# BE-Webinars Dashboard

## Project Overview

This project is a dashboard application designed to manage and visualize webinar schedules and statistics. It specifically integrates with **Calendly** to fetch upcoming and past webinar events, track attendee counts, and categorize sessions by specific "collectives" (Mumbai, Bhopal, Hammiyala, Poomaale).

The application provides a web interface to:
- Authenticate with Calendly via OAuth.
- View upcoming webinar sessions and total participant counts.
- View historical data of past webinars.
- Filter data by collective location.

## Architecture

The project follows a simple client-server architecture:

### Backend
- **Runtime:** Node.js
- **Framework:** Express.js
- **Authentication:** 
  - **App Login:** Simple session-based authentication using environment variables (`ADMIN_USER`, `ADMIN_PASS`).
  - **Calendly Integration:** OAuth 2.0 flow to obtain and refresh access tokens.
- **Persistence:** File-based persistence using `tokens.json` to store Calendly OAuth tokens.
- **API:** Exposes REST endpoints (`/api/webinars`, `/api/login`, etc.) for the frontend to consume.

### Frontend
- **Technology:** Static HTML served via Express static middleware.
- **Pages:**
  - `login.html`: Admin login page.
  - `dashboard.html`: Main view for upcoming webinars.
  - `history.html`: View for past webinars.
  - `index.html`: Landing/redirect page.

## Project Structure

```text
.
├── dashboard/               # Main application code
│   ├── public/              # Frontend static files (HTML)
│   ├── node_modules/        # Dependencies
│   ├── package.json         # Project metadata and scripts
│   ├── server.js            # Main backend server entry point
│   └── tokens.json          # (Generated) Stores Calendly auth tokens
├── webinar_schedule.md      # Reference schedule for planning
├── error.md                 # Log of known errors
├── *.png                    # Project assets/images
└── GEMINI.md                # Context documentation
```

## Setup & Usage

### Prerequisites
- Node.js (v14+ recommended)
- A Calendly account and API credentials (Client ID and Secret).

### Installation
1. Navigate to the dashboard directory:
   ```bash
   cd dashboard
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

### Configuration
Create a `.env` file in the `dashboard` directory with the following variables:

```env
ADMIN_USER=admin
ADMIN_PASS=your_secure_password
SESSION_SECRET=your_random_session_secret
CALENDLY_CLIENT_ID=your_calendly_client_id
CALENDLY_CLIENT_SECRET=your_calendly_client_secret
CALENDLY_REDIRECT_URI=http://localhost:3000/oauth/callback
```

### Running the Application
Start the server:
```bash
npm start
```
The server will start at `http://localhost:3000`.

## Known Issues

- **ES Module Error:** The project currently attempts to `require('open')` in `server.js`. The `open` package (v8+) is an ES Module and cannot be loaded via `require` in a CommonJS environment. This causes a crash on startup if `open` is used.
  - **Fix:** Either downgrade `open` to v7.x or convert the project to use ES Modules (`"type": "module"` in `package.json`).

## Key Workflows
1. **Login:** Access the dashboard and log in with the configured admin credentials.
2. **Connect Calendly:** If not connected, use the "Connect Calendly" button to authorize the app.
3. **View Data:** The dashboard automatically fetches and processes events from your Calendly account.
