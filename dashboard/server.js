require('dotenv').config();
const express = require('express');
const axios = require('axios');
const session = require('express-session');
const path = require('path');

const fs = require('fs');

const app = express();
const PORT = 3000;
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const zoomCreds = {
    accountId: process.env.ZOOM_ACCOUNT_ID,
    clientId: process.env.ZOOM_CLIENT_ID,
    clientSecret: process.env.ZOOM_CLIENT_SECRET
};
let zoomTokenCache = { token: null, expiresAt: 0 };

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// --- TOKEN PERSISTENCE ---
let calendlyTokens = {
    accessToken: null,
    refreshToken: null
};

function loadTokens() {
    try {
        if (fs.existsSync(TOKENS_FILE)) {
            const data = fs.readFileSync(TOKENS_FILE, 'utf8');
            calendlyTokens = JSON.parse(data);
            console.log('Loaded tokens from disk.');
        }
    } catch (err) {
        console.error('Error loading tokens:', err.message);
    }
}

function saveTokens() {
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(calendlyTokens, null, 2));
        console.log('Saved tokens to disk.');
    } catch (err) {
        console.error('Error saving tokens:', err.message);
    }
}

// Load on startup
loadTokens();

function zoomConfigAvailable() {
    return zoomCreds.accountId && zoomCreds.clientId && zoomCreds.clientSecret;
}

async function getZoomAccessToken() {
    if (!zoomConfigAvailable()) {
        return null;
    }
    const now = Date.now();
    if (zoomTokenCache.token && zoomTokenCache.expiresAt - 60000 > now) {
        return zoomTokenCache.token;
    }
    try {
        const credentials = Buffer.from(`${zoomCreds.clientId}:${zoomCreds.clientSecret}`).toString('base64');
        const response = await axios.post('https://zoom.us/oauth/token', null, {
            params: {
                grant_type: 'account_credentials',
                account_id: zoomCreds.accountId
            },
            headers: {
                Authorization: `Basic ${credentials}`
            }
        });
        zoomTokenCache = {
            token: response.data.access_token,
            expiresAt: now + ((response.data.expires_in || 3500) * 1000)
        };
        return zoomTokenCache.token;
    } catch (err) {
        console.error('Failed to fetch Zoom token:', err.response ? err.response.data : err.message);
        return null;
    }
}

async function fetchZoomParticipants(meetingId) {
    if (!meetingId) return [];
    const token = await getZoomAccessToken();
    if (!token) return [];

    let participants = [];
    let nextPageToken = null;

    try {
        do {
            const response = await axios.get(`https://api.zoom.us/v2/report/meetings/${encodeURIComponent(meetingId)}/participants`, {
                headers: { Authorization: `Bearer ${token}` },
                params: {
                    page_size: 100,
                    next_page_token: nextPageToken || undefined
                }
            });
            if (response.data && Array.isArray(response.data.participants)) {
                participants = participants.concat(response.data.participants);
            }
            nextPageToken = response.data && response.data.next_page_token ? response.data.next_page_token : null;
        } while (nextPageToken);
    } catch (err) {
        console.error(`Failed to fetch Zoom participants for meeting ${meetingId}:`, err.response ? err.response.data : err.message);
        return [];
    }

    return participants.map(p => ({
        name: p.name || p.user_name || 'Unknown',
        email: p.user_email || '',
        phone: p.phone_number || null,
        joinTime: p.join_time || null,
        leaveTime: p.leave_time || null,
        duration: typeof p.duration === 'number' ? p.duration : null
    }));
}

// --- MIDDLEWARE ---
const requireLogin = (req, res, next) => {
    if (req.session.isLoggedIn) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// --- APP AUTH ROUTES ---

// Login Endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        req.session.isLoggedIn = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

app.get('/api/auth-status', (req, res) => {
    res.json({ 
        isLoggedIn: !!req.session.isLoggedIn,
        isCalendlyConnected: !!calendlyTokens.accessToken
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});


// --- CALENDLY OAUTH ROUTES ---

// 1. Redirect user to Calendly to authorize (protected)
app.get('/connect-calendly', (req, res) => {
    if (!req.session.isLoggedIn) return res.redirect('/');

    const clientId = process.env.CALENDLY_CLIENT_ID;
    const redirectUri = process.env.CALENDLY_REDIRECT_URI;
    
    if (!clientId) return res.send('Missing CALENDLY_CLIENT_ID in .env file');

    const authUrl = `https://auth.calendly.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}`;
    res.redirect(authUrl);
});

// 2. Handle the callback from Calendly
app.get('/oauth/callback', async (req, res) => {
    // Note: If session is lost during redirect (rare locally), this might fail check.
    // For simplicity, we process the code then redirect to home.
    
    const { code } = req.query;
    const clientId = process.env.CALENDLY_CLIENT_ID;
    const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
    const redirectUri = process.env.CALENDLY_REDIRECT_URI;

    try {
        const response = await axios.post('https://auth.calendly.com/oauth/token', null, {
            params: {
                grant_type: 'authorization_code',
                client_id: clientId,
                client_secret: clientSecret,
                code: code,
                redirect_uri: redirectUri
            }
        });

        calendlyTokens.accessToken = response.data.access_token;
        calendlyTokens.refreshToken = response.data.refresh_token;
        saveTokens(); // Save to disk

        res.redirect('/');
    } catch (error) {
        console.error('Error exchanging token:', error.response ? error.response.data : error.message);
        res.redirect('/?error=calendly_auth_failed');
    }
});


// --- DATA API ---

async function refreshAccessToken() {
    try {
        console.log('Refreshing Access Token...');
        const response = await axios.post('https://auth.calendly.com/oauth/token', null, {
            params: {
                grant_type: 'refresh_token',
                client_id: process.env.CALENDLY_CLIENT_ID,
                client_secret: process.env.CALENDLY_CLIENT_SECRET,
                refresh_token: calendlyTokens.refreshToken
            }
        });

        calendlyTokens.accessToken = response.data.access_token;
        calendlyTokens.refreshToken = response.data.refresh_token; // Calendly rotates refresh tokens too
        saveTokens();
        console.log('Token Refreshed Successfully.');
        return calendlyTokens.accessToken;
    } catch (error) {
        console.error('Failed to refresh token:', error.response ? error.response.data : error.message);
        return null;
    }
}

// Helper to make authenticated requests with auto-retry
async function makeCalendlyRequest(url, params = {}) {
    if (!calendlyTokens.accessToken) throw new Error('No token');

    try {
        return await axios.get(url, {
            headers: { Authorization: `Bearer ${calendlyTokens.accessToken}` },
            params: params
        });
    } catch (error) {
        // If 401, try to refresh and retry ONCE
        if (error.response && error.response.status === 401) {
            const newToken = await refreshAccessToken();
            if (newToken) {
                return await axios.get(url, {
                    headers: { Authorization: `Bearer ${newToken}` },
                    params: params
                });
            }
        }
        throw error; // Re-throw if not 401 or refresh failed
    }
}

function extractPhone(invitee) {
    if (!invitee) return null;
    if (invitee.phone_number) return invitee.phone_number;
    if (invitee.text_reminder_number) return invitee.text_reminder_number;
    if (Array.isArray(invitee.questions_and_answers)) {
        const phoneAnswer = invitee.questions_and_answers.find(entry => {
            return entry.question && entry.question.toLowerCase().includes('phone');
        });
        if (phoneAnswer && phoneAnswer.answer) return phoneAnswer.answer;
    }
    return null;
}

function extractZoomMeetingId(zoomUrl) {
    if (!zoomUrl) return null;
    const normalized = zoomUrl.toLowerCase();
    const regex = /zoom\.us\/[jw]\/(\d+)/i;
    const match = zoomUrl.match(regex);
    if (match) return match[1];
    const digits = normalized.match(/(\d{9,12})/);
    return digits ? digits[1] : null;
}

function parseDateSafe(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeEmail(value) {
    return (value || '').toLowerCase().trim();
}

function normalizeName(value) {
    return (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function filterAndDedupAttendance(attendees, sessionStart, sessionEnd) {
    if (!Array.isArray(attendees) || attendees.length === 0) return [];
    const start = parseDateSafe(sessionStart);
    const end = parseDateSafe(sessionEnd);
    const fallbackEnd = end || (start ? new Date(start.getTime() + (2 * 60 * 60 * 1000)) : null);
    const windowStart = start ? new Date(start.getTime() - (2 * 60 * 60 * 1000)) : null; // allow early joins
    const windowEnd = fallbackEnd ? new Date(fallbackEnd.getTime() + (60 * 60 * 1000)) : null; // allow late departures

    const filtered = attendees.filter(entry => {
        if (!windowStart || !windowEnd) return true;
        const join = parseDateSafe(entry.joinTime);
        if (!join) return true;
        return join >= windowStart && join <= windowEnd;
    });

    const deduped = new Map();
    filtered.forEach(entry => {
        const key = entry.email 
            ? entry.email.toLowerCase().trim()
            : `${(entry.name || 'guest').toLowerCase()}-${entry.joinTime || ''}`;
        const existing = deduped.get(key);
        if (!existing) {
            deduped.set(key, entry);
            return;
        }
        const currentDuration = typeof existing.duration === 'number' ? existing.duration : 0;
        const newDuration = typeof entry.duration === 'number' ? entry.duration : 0;
        if (newDuration > currentDuration) {
            deduped.set(key, entry);
        }
    });

    return Array.from(deduped.values()).sort((a, b) => {
        const aTime = parseDateSafe(a.joinTime);
        const bTime = parseDateSafe(b.joinTime);
        if (!aTime && !bTime) return 0;
        if (!aTime) return 1;
        if (!bTime) return -1;
        return aTime - bTime;
    });
}

function matchAttendanceToRegistrants(attendanceList, registrants) {
    if (!Array.isArray(attendanceList) || attendanceList.length === 0) {
        return { matched: [], external: [] };
    }
    const registrantEmails = new Set();
    const registrantNames = new Set();
    (registrants || []).forEach(r => {
        const emailKey = normalizeEmail(r.email);
        if (emailKey) registrantEmails.add(emailKey);
        const nameKey = normalizeName(r.name);
        if (nameKey) registrantNames.add(nameKey);
    });
    const matched = [];
    const external = [];

    attendanceList.forEach(entry => {
        const email = normalizeEmail(entry.email);
        if (email && registrantEmails.has(email)) {
            matched.push(entry);
            registrantEmails.delete(email);
            return;
        }
        const nameKey = normalizeName(entry.name);
        if (nameKey && registrantNames.has(nameKey)) {
            matched.push(entry);
            registrantNames.delete(nameKey);
            return;
        }
        external.push(entry);
    });
    return { matched, external };
}

// Shared helper to process events
async function processEvents(events, options = {}) {
    const includeAttendance = !!options.includeAttendance && zoomConfigAvailable();

    // Step C: Fetch Invitees
    const detailedEvents = await Promise.all(events.map(async (event) => {
        try {
            const uuid = event.uri.split('/').pop();
            let allInvitees = [];
            let url = `https://api.calendly.com/scheduled_events/${uuid}/invitees`;
            let params = { count: 100 };

            while (url) {
                const inviteesRes = await makeCalendlyRequest(url, params);
                const invitees = inviteesRes.data.collection.map(inv => ({
                    name: inv.name,
                    email: inv.email,
                    status: inv.status,
                    phone: extractPhone(inv)
                }));
                allInvitees = allInvitees.concat(invitees);

                if (inviteesRes.data.pagination && inviteesRes.data.pagination.next_page) {
                    url = inviteesRes.data.pagination.next_page;
                    params = {}; // next_page URL includes params
                } else {
                    url = null;
                }
            }
            return { ...event, inviteeDetails: allInvitees };
        } catch (err) {
            console.error(`Failed to fetch invitees`, err.message);
            return { ...event, inviteeDetails: [] };
        }
    }));

    // Step D: Process Data
    const webinars = { 'Mumbai': [], 'Bhopal': [], 'Hammiyala': [], 'Poomaale': [] };
    const targetNames = ['Mumbai', 'Bhopal', 'Hammiyala', 'Poomaale'];

    detailedEvents.forEach(event => {
        const name = event.name;
        const collective = targetNames.find(t => name.toLowerCase().includes(t.toLowerCase()));
        
        if (collective) {
            webinars[collective].push({
                rawEvent: event,
                startTime: new Date(event.start_time),
                invitees: event.inviteeDetails
            });
        }
    });

    const collectiveStats = await Promise.all(targetNames.map(async name => {
        const rawList = webinars[name];
        const sessionsMap = {};

        rawList.forEach(item => {
            const key = item.startTime.toISOString();
            if (!sessionsMap[key]) {
                sessionsMap[key] = {
                    date: item.startTime,
                    endDate: item.rawEvent.end_time ? new Date(item.rawEvent.end_time) : null,
                    eventName: item.rawEvent.name,
                    location: item.rawEvent.location, // Store location data
                    attendees: []
                };
            }
            sessionsMap[key].attendees.push(...item.invitees);
        });

        const sessions = await Promise.all(Object.values(sessionsMap)
            .sort((a, b) => a.date - b.date)
            .map(async s => {
                const zoomLink = (s.location && s.location.join_url) ? s.location.join_url : null;
                const baseSession = {
                    eventName: s.eventName,
                    dateString: s.date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
                    timeString: s.date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }),
                    dayPart: s.date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric' }),
                    monthPart: s.date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short' }),
                    isoDate: s.date,
                    startDate: s.date,
                    endDate: s.endDate || null,
                    attendees: s.attendees,
                    zoomLink,
                    zoomMeetingId: null,
                    attendanceCount: null,
                    attendanceList: [],
                    attendanceRate: null,
                    externalAttendance: 0
                };

                if (includeAttendance && zoomLink) {
                    const meetingId = extractZoomMeetingId(zoomLink);
                    if (meetingId) {
                        const rawAttendance = await fetchZoomParticipants(meetingId);
                        const dedupedAttendance = filterAndDedupAttendance(rawAttendance, s.date, s.endDate);
                        const { matched, external } = matchAttendanceToRegistrants(dedupedAttendance, s.attendees);
                        baseSession.zoomMeetingId = meetingId;
                        baseSession.attendanceList = matched;
                        baseSession.attendanceCount = matched.length;
                        baseSession.externalAttendance = external.length;
                        if (baseSession.attendees.length > 0 && baseSession.attendanceCount !== null) {
                            baseSession.attendanceRate = Math.round((baseSession.attendanceCount / baseSession.attendees.length) * 100);
                        }
                    }
                }

                return baseSession;
            }));

        const totalAttendees = sessions.reduce((sum, s) => sum + s.attendees.length, 0);
        const totalAttendance = sessions.reduce((sum, s) => sum + (s.attendanceCount || 0), 0);

        return {
            collective: name,
            totalUpcoming: totalAttendees,
            totalAttendance,
            sessions: sessions
        };
    }));

    return collectiveStats;
}

app.get('/api/webinars', requireLogin, async (req, res) => {
    if (!calendlyTokens.accessToken) {
        return res.status(400).json({ error: 'Calendly not connected' });
    }

    try {
        // Step A: Get Current User URI
        const userRes = await makeCalendlyRequest('https://api.calendly.com/users/me');
        const userUri = userRes.data.resource.uri;

        // Step B: Get Scheduled Events (Active & FUTURE ONLY)
        const eventsRes = await makeCalendlyRequest('https://api.calendly.com/scheduled_events', {
            user: userUri,
            status: 'active',
            count: 100,
            sort: 'start_time:asc',
            min_start_time: new Date().toISOString()
        });

        const collectiveStats = await processEvents(eventsRes.data.collection);
        
        // Calculate Global Stats
        const totalParticipants = collectiveStats.reduce((sum, c) => sum + c.totalUpcoming, 0);
        const totalAttendance = collectiveStats.reduce((sum, c) => sum + (c.totalAttendance || 0), 0);
        
        // Find next immediate session
        let allSessions = [];
        collectiveStats.forEach(c => allSessions.push(...c.sessions));
        allSessions.sort((a, b) => new Date(a.isoDate) - new Date(b.isoDate));
        
        const nextSession = allSessions.length > 0 ? allSessions[0] : null;

        res.json({
            collectives: collectiveStats,
            globalStats: {
                totalParticipants,
                totalAttendance,
                nextSession: nextSession || null,
                totalSessions: allSessions.length
            }
        });

    } catch (error) {
        console.error('Error fetching data:', error.response ? error.response.data : error.message);
        if (error.response && error.response.status === 401) {
             return res.status(401).json({ error: 'Authentication expired' });
        }
        res.status(500).json({ error: 'Failed to fetch data' });
    }
});

app.get('/api/webinars/past', requireLogin, async (req, res) => {
    if (!calendlyTokens.accessToken) return res.status(400).json({ error: 'Calendly not connected' });

    try {
        const userRes = await makeCalendlyRequest('https://api.calendly.com/users/me');
        const userUri = userRes.data.resource.uri;

        // Step B: Get Scheduled Events (Active & PAST ONLY)
        const eventsRes = await makeCalendlyRequest('https://api.calendly.com/scheduled_events', {
            user: userUri,
            status: 'active',
            count: 100,
            sort: 'start_time:desc',
            max_start_time: new Date().toISOString()
        });

        const collectiveStats = await processEvents(eventsRes.data.collection, { includeAttendance: true });
        
        const totalParticipants = collectiveStats.reduce((sum, c) => sum + c.totalUpcoming, 0);
        const totalAttendance = collectiveStats.reduce((sum, c) => sum + (c.totalAttendance || 0), 0);
        
        res.json({
            collectives: collectiveStats,
            globalStats: { totalParticipants, totalAttendance, totalSessions: eventsRes.data.collection.length }
        });

    } catch (error) {
        console.error('Error fetching past data:', error.message);
        if (error.response && error.response.status === 401) return res.status(401).json({ error: 'Authentication expired' });
        res.status(500).json({ error: 'Failed to fetch data' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
