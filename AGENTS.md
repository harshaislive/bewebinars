# Repository Guidelines

## Project Structure & Module Organization
`dashboard/server.js` hosts the Express API, session middleware, and Calendly OAuth/token refresh helpers, while `dashboard/public/` contains the login, dashboard, history, and marketing HTML that drive the admin UI. Static webinar artwork (.png files) and planning docs stay in the repo root for campaign teams. Keep runtime secrets in `.env`, and remember `tokens.json` (generated beside `server.js`) is git-ignored but must stay readable by the Node process.

## Build, Test, and Development Commands
```bash
cd dashboard
npm install        # install Express, Axios, and session deps
npm start          # run server.js on http://localhost:3000
```
Use `SET DEBUG=express:*` (Windows) to inspect routing when debugging middleware. The default `npm test` placeholder exits with code 1; replace it only after adding real tests.

## Coding Style & Naming Conventions
Follow the existing 4-space indentation, `const`/`let` scoping, and async/await patterns used in `server.js`. Route handlers should be named after their purpose (`/api/login`, `/connect-calendly`) and return JSON objects with explicit `success` or `error` keys. Keep client assets lowercase-with-dashes (for example, `history.html`), and group shared helpers near the top of `server.js` with descriptive names such as `makeCalendlyRequest`.

## Testing Guidelines
No automated suite exists yet; create focused tests before shipping risky changes. Until then, verify logins with `curl http://localhost:3000/api/auth-status` and recheck the browser dashboard to confirm that event listings, history filters, and Calendly sync flows respond correctly. When tests are added, place them under `dashboard/tests/` and name files `featureName.spec.js` for quick discovery.

## Commit & Pull Request Guidelines
Recent history favors Conventional Commit-style prefixes (`Fix:`, `Feat:`). Keep subjects imperative and under ~72 characters, then expand in the body only when necessary. Pull requests should summarize scope, list manual verification steps (commands or screenshots of affected dashboard views), and link any tracked issue or webinar request ticket. Call out migrations, env changes, or token handling tweaks explicitly so reviewers can confirm deployment steps.

## Security & Configuration Tips
Provision `CALENDLY_CLIENT_ID`, `CALENDLY_CLIENT_SECRET`, `CALENDLY_REDIRECT_URI`, `ADMIN_USER`, `ADMIN_PASS`, and `SESSION_SECRET` in `.env`, and never commit that file or `tokens.json`. Rotate Calendly credentials whenever access is revoked, and clear stale session cookies when testing login flows in multiple browsers.
