require('dotenv').config();
const express = require('express');
const axios = require('axios');
const session = require('express-session');
const path = require('path');

const fs = require('fs');

const app = express();
const PORT = 3000;
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

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

app.get('/api/webinars', requireLogin, async (req, res) => {
    if (!calendlyTokens.accessToken) {
        return res.status(400).json({ error: 'Calendly not connected' });
    }

    try {
        // Step A: Get Current User URI
        const userRes = await axios.get('https://api.calendly.com/users/me', {
            headers: { Authorization: `Bearer ${calendlyTokens.accessToken}` }
        });
        const userUri = userRes.data.resource.uri;

        // Step B: Get Scheduled Events (Active)
        const eventsRes = await axios.get('https://api.calendly.com/scheduled_events', {
            headers: { Authorization: `Bearer ${calendlyTokens.accessToken}` },
            params: {
                user: userUri,
                status: 'active',
                count: 100,
                sort: 'start_time:asc'
            }
        });

        const events = eventsRes.data.collection;
        
        // Step C: Fetch Invitees
        const detailedEvents = await Promise.all(events.map(async (event) => {
            try {
                const uuid = event.uri.split('/').pop();
                const inviteesRes = await axios.get(`https://api.calendly.com/scheduled_events/${uuid}/invitees`, {
                    headers: { Authorization: `Bearer ${calendlyTokens.accessToken}` }
                });

                const invitees = inviteesRes.data.collection.map(inv => ({
                    name: inv.name,
                    email: inv.email,
                    status: inv.status
                }));

                return { ...event, inviteeDetails: invitees };
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

        const collectiveStats = targetNames.map(name => {
            const rawList = webinars[name];
            const sessionsMap = {};

            rawList.forEach(item => {
                const key = item.startTime.toISOString();
                if (!sessionsMap[key]) {
                    sessionsMap[key] = {
                        date: item.startTime,
                        eventName: item.rawEvent.name,
                        location: item.rawEvent.location, // Store location data
                        attendees: []
                    };
                }
                sessionsMap[key].attendees.push(...item.invitees);
            });

            const sessions = Object.values(sessionsMap)
                .sort((a, b) => a.date - b.date)
                .map(s => ({
                    eventName: s.eventName,
                    dateString: s.date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
                    timeString: s.date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }),
                    dayPart: s.date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric' }),
                    monthPart: s.date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short' }),
                    isoDate: s.date,
                    attendees: s.attendees,
                    zoomLink: (s.location && s.location.join_url) ? s.location.join_url : null
                }));

            const totalAttendees = sessions.reduce((sum, s) => sum + s.attendees.length, 0);

            return {
                collective: name,
                totalUpcoming: totalAttendees,
                sessions: sessions
            };
        });

        // Calculate Global Stats
        const totalParticipants = collectiveStats.reduce((sum, c) => sum + c.totalUpcoming, 0);
        
        // Find next immediate session
        let allSessions = [];
        collectiveStats.forEach(c => allSessions.push(...c.sessions));
        allSessions.sort((a, b) => new Date(a.isoDate) - new Date(b.isoDate));
        
        const nextSession = allSessions.length > 0 ? allSessions[0] : null;

        res.json({
            collectives: collectiveStats,
            globalStats: {
                totalParticipants,
                nextSession: nextSession || null,
                totalSessions: allSessions.length
            }
        });

    } catch (error) {
        console.error('Error fetching data:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch data' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});