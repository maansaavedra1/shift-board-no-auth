# Shift Board

A Docker-based attendance dashboard pulling live from Sprout HR, with
System ID + password login restricted to a dev-curated admin allowlist.

## Authentication

This app used to have **no login of any kind** — anyone with the URL
could see attendance data. That's no longer the case. Here's how access
control actually works now:

**Who can register:** only System IDs listed in the `ADMIN_ALLOWLIST`
environment variable (comma-separated, e.g.
`ADMIN_ALLOWLIST=2414,1936,1050`), set at deployment time by whoever's
running the container. This is the actual gate — being a real Sprout
employee alone isn't enough to register.

**How registration works:** someone on the allowlist visits the
dashboard, clicks "Register," enters their System ID and a password of
their choosing (minimum 8 characters). The server then double-checks
that System ID against Sprout's *current* employee list — so someone
can't register under a System ID that isn't a real, active employee,
even if it ended up on the allowlist by mistake. Passwords are hashed
with bcrypt before being stored; the plain password is never saved
anywhere. Registering also logs you in immediately.

**How login works after that:** System ID + the password chosen at
registration. A signed session cookie (12-hour expiry) is issued —
signed with `SESSION_SECRET` (see below), not stored server-side beyond
the account record itself.

**Forgotten password:** there's no email-based reset — with only a small
admin list, that would be real infrastructure (an email account/service,
reset tokens, etc.) for a rare event. Instead, any *other* currently
logged-in admin can go to **"Reset an admin account"** in the toolbar,
enter the forgetful person's System ID, and clear their account entirely
— they then just register again from scratch with a new password. The
security model here is simply "already logged in as *some* admin," which
is a reasonable bar with only a handful of people on the list; it stops
being reasonable if this list grows large, at which point a real
email-based reset is worth revisiting.

**Auto-logout after 30 minutes idle:** tracked client-side (mouse,
keyboard, scroll, or touch activity all reset the countdown) — walking
away from the dashboard logs you out automatically rather than leaving
it open indefinitely. This is separate from, and shorter than, the
12-hour session expiry above; either one can end a session first.

**Required environment variables for this to work at all:**
- `ADMIN_ALLOWLIST` — comma-separated System IDs allowed to register.
  If unset, *nobody* can register (existing accounts can still log in).
- `SESSION_SECRET` — a long random string used to sign session cookies.
  If unset, a random one is generated per process start, which means
  **everyone gets logged out on every restart** until this is set
  explicitly. Set it to something fixed in real deployments.

**Where accounts are stored:** `data/admin-accounts.json`, alongside the
saved Sprout credentials (see `config-store.js` below) — same file, same
Docker-volume requirement to survive a container restart.

**What's still open, deliberately:** `/health` (for uptime checks) and
the dashboard's page shell itself (the login form has to be reachable
before anyone can log in) — but no actual attendance data, settings, or
employee information is served without a valid session.

## Why there's still a backend at all

Sprout's API does not allow requests sent directly from a browser
(confirmed via a live CORS test — Sprout's servers reject browser-origin
requests outright, regardless of credentials). So a server still has to
sit between the browser and Sprout, purely to make that one call — this
version keeps that server, it just doesn't gate who can use it.

## What changed from the Keycloak version

- `public/index.html` — no login screen, no "manage users" panel. Loads
  straight into the setup box (paste your API URL) or the dashboard.
  Adds a "Sprout settings" panel instead (see below).
- `src/server.js` — no `requireAuth` middleware, no `/config.json`,
  no `/api/admin/users`. `/api/shift-board` is open to anyone. Adds
  `/api/settings` (GET and POST) for the credentials panel.
- `src/config-store.js` — new. Persists Sprout credentials submitted
  through the settings panel to `data/sprout-config.json`, and applies
  them to the running server immediately (no restart needed).
- `keycloak-auth.js`, `keycloak-admin.js`, the `scripts/` folder, and
  `keycloak/shift-board-realm.json` are all gone — nothing in this
  version references Keycloak at all.
- `docker-compose.yml` no longer runs a Keycloak container, and now
  mounts a volume for `data/` (see below).
- `package.json` no longer depends on `jsonwebtoken` / `jwks-rsa`.

## Fixing Department / Supervisor showing blank or wrong

The dashboard shows a Department and Supervisor column, but the field
names used to read them (`work.department`, `work.reportsTo` in
`src/sprout.js`) have **never been confirmed against real Sprout data —
they were always a guess.** If these show as "—" or an unexpected value,
that's why.

**To fix it for real, instead of guessing again:**

1. With the app running and Sprout credentials saved (via the settings
   panel), open this URL in a browser:
   ```
   http://<your-app-url>/api/debug/employee-sample
   ```
2. This returns the full, real JSON for one actual employee record —
   copy that whole response
3. Share it (with whoever is doing this fix, e.g. in a chat with Claude)
   so the exact field names for department and supervisor can be found
   and `classifyEmployeeForDay()` in `src/sprout.js` updated to match
4. Once fixed, this diagnostic endpoint can be deleted from
   `src/server.js` — it's a one-time tool, not something the dashboard
   needs day-to-day

**This endpoint has no login either** (same as everything else in this
version) and returns one real employee's full record, including fields
not otherwise shown on the dashboard. Treat it the same as the rest of
this app's data exposure — remove it once no longer needed, or restrict
access if this deployment needs to stay live longer-term.

## Setting Sprout credentials

There are now two ways to provide the four Sprout credentials (Client ID,
Client Secret, Subscription Key, User ID) — pick whichever fits how this
is being deployed.

**Option A — bake them in at deployment (recommended for this build,
since it's for one specific client).** Set all four as environment
variables alongside `SPROUT_BASE` (see `AZURE_DEPLOYMENT.md`). When all
four are present this way, the dashboard automatically detects it and
**hides its Credentials panel entirely** — the person using the
dashboard never sees a settings screen and can't change these values
after deployment (the save endpoint refuses to, even if someone tried
via a direct API call). This is the safer default: fewer moving parts
for the end user, and no unauthenticated panel left exposed for anyone
to tamper with.

**Option B — leave them unset, and set them later through the
dashboard's "Credentials" panel.** Only relevant if these values might
need to change without a redeploy. Submitted values are sent to this
app's own server (same-origin, so no CORS issue) and saved to
`data/sprout-config.json` — **never sent to or stored in the browser**,
and the real secret value is never sent back to the browser again after
saving (only "•••• last4" previews, and the Client Secret shows only as
"saved", no preview at all). In this mode, the panel stays visible and
editable to anyone who can reach the dashboard's URL, since this version
has no login of any kind.

**`SPROUT_BASE` (the API's domain) is never part of this panel, in
either option** — it stays controlled only by the `SPROUT_BASE`
environment variable, set at deploy time. This is a deliberate choice: if
the base URL were editable through this same panel, anyone could point
it at a server they control, and a real secret typed in later would then
be sent straight to that attacker's server instead of Sprout's. Keeping
it environment-only closes that specific hole.

**⚠️ Sandbox and production aren't just different domains — they use
different API path structures and a different auth request format
entirely.** Discovered this the hard way (a live 404 on a real production
deployment) — `src/sprout.js` now detects which environment it's talking
to by checking whether `SPROUT_BASE` contains `-sb.`, and adjusts
accordingly:

| | Sandbox | Production |
|---|---|---|
| Token endpoint | `/auth/connect/token` | `/api/v1/Auth/client/token` |
| Token request format | form-urlencoded, `grant_type=client_credentials` | raw JSON, `{"ClientId":...,"Secret":...}` |
| Data endpoints | `/{service}/api/v1/{Resource}` (e.g. `/timeattendance/api/v1/AttendanceLogs`) | `/api/v1/{Resource}` (service prefix dropped) |

**Confidence level, to be precise about what's actually verified — this
whole picture changed significantly since it was first written:**
- **Token endpoint, `Employees`, `AttendanceLogs`, `Schedules`** —
  confirmed directly against real production data, not just docs
- **`ScheduleAdjustments` as its own endpoint never existed at all** —
  confirmed by testing directly against production (three separate 404s,
  including the exact sandbox-style query parameters). The real data
  lives nested inside each day's `Schedules` response instead — see the
  background cache section in `sprout.js` for the full story of how this
  was found.
- **`Leaves/SearchCriteria` is confirmed blocked, specifically on
  Sprout's side, not a path/format issue.** Sprout's own team confirmed
  the correct endpoint (`api.sprout.ph`, a genuinely different host than
  everything else here); we tested it directly and got back a real,
  specific error — the token our production credentials generate is
  rejected by that endpoint with `"The issuer
  'https://sproutauth.hrhub.ph' is invalid"`. This is an account/app
  registration mismatch on Sprout's infrastructure, not something fixable
  from this codebase.
- **Leave status works anyway** — the same `Schedules` response that
  solved Schedule Adjustments also carries a real, populated `leaves`
  array per day. Confirmed against actual production data (dozens of
  real employees, real leave dates, including same-day entries) before
  switching to it. Leave checking no longer depends on the blocked
  endpoint at all, and no longer has a "temporarily unavailable" failure
  mode — it's exactly as reliable as Schedule Adjustments now, sourced
  from the same background cache.

### A real bug this surfaced: adjustment times were silently broken

Found via a genuinely wrong number in production — an employee with a
9 PM shift adjustment showed as **893 minutes late**, compared against
his unadjusted 6 AM default schedule instead. The cause: Sprout's
adjustment values (`scheduleAdjustment.shiftStart`/`shiftEnd`) are
**full datetimes** (e.g. `"2026-09-10T21:00:00"`), but the code was
feeding them into a helper built for the *default* weekly schedule's
bare `"HH:MM"` values, which re-prepends the day and re-appends `:00` —
turning an already-full datetime into a malformed string like
`"2026-09-10T2026-09-10T21:00:00:00"`. That parses to `Invalid Date`,
which any comparison against silently evaluates as `false` — so the
adjustment branch never actually took effect for the checks it's used
in, and the code fell through to comparing against the default schedule
instead. Fixed by using the correct parser depending on where the value
actually came from (see `resolveShiftBoundary` in `classifyEmployeeForDay`).
Confirmed fixed against this exact employee's real adjustment and real
attendance log — correctly reclassified from 893 minutes late to
7 minutes *early* once fixed.

### Login is required

There's a full System ID + password login system — see the
"Authentication" section above. The dashboard, its API, and the settings
endpoint are all behind it; nothing here is reachable without a valid
session.

### Persistence — this needs a Docker volume

Saved settings live in `data/sprout-config.json` inside the container.
Docker containers are ephemeral by default — **without the volume mount
already set up in `docker-compose.yml`, saved settings are lost every
time the container restarts or gets redeployed.** If you're deploying
this outside of `docker compose` (e.g. directly to a platform like Azure
Container Apps), make sure `/app/data` is mounted to persistent storage
there too, or settings won't survive a redeploy.

## Running it locally

1. Copy `.env.example` to `.env` — filling in Sprout credentials here is
   now optional (only used for the very first run before you've saved
   anything through the settings panel)
2. `docker compose up --build`
3. Visit `http://localhost:3000` — paste `http://localhost:3000/api/shift-board`
   into the setup box, and use "Sprout settings" to enter credentials if
   you didn't set them in `.env`

## File Structure

```
shift-board-no-auth/
├── Dockerfile
├── docker-compose.yml    (now includes a volume for data/ persistence)
├── .env.example
├── AZURE_DEPLOYMENT.md   (simplified — no Keycloak/Postgres needed)
├── package.json
├── public/
│   └── index.html         (dashboard — no login, has Sprout settings panel)
└── src/
    ├── server.js           (Express app — everything here is OPEN, no auth)
    ├── config-store.js     (persists credentials submitted via settings panel)
    └── sprout.js            (Sprout HR integration, unchanged)
```
