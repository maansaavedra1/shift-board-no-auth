# Shift Board — No Login Version

This is the Docker-based Shift Board with **all authentication removed** —
no Keycloak, no login page, no user management. It's a straight port of
the Keycloak version with every auth-related piece taken out.

## What this means, plainly

**Anyone who can reach this server's URL can see live attendance data.**
There is nothing in this version checking who's asking — no username,
no password, no role, nothing. If the URL is public or guessable, the
data is effectively public too.

This is a real tradeoff, not a bug — it's what was asked for. If that's
not acceptable for how this will actually be used, the options are:

- Put it behind something else that handles access control (e.g. a
  gate like sproutmarkup.com's own enrollment/login, if that's where
  this is being hosted)
- Bring back a lightweight protection layer (even something as simple
  as a shared access key in the URL, like the Apps Script version uses)
- Go back to the Keycloak version for real per-person login and roles

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

**Confidence level, to be precise about what's actually verified:**
- **Token endpoint + format, and `AttendanceLogs`** — confirmed directly
  against Sprout's own Postman documentation (`clients.hrhub.ph`
  examples, internally consistent, no contradictions found)
- **`Employees`, `Leaves`, `ScheduleAdjustments` production paths** — NOT
  independently confirmed. They're inferred by applying the same
  "service prefix dropped" pattern seen in the confirmed endpoints. The
  only documentation found for these specific endpoints was in a
  differently-labeled collection that turned out to contain mislabeled
  sandbox content (its own instructions said "sandbox account" despite
  being filed under "PRODUCTION") — so it couldn't be trusted as
  evidence, and this fix goes with the pattern instead. **Test these
  three endpoints specifically** once real production data is flowing;
  if any of them 404, that's the signal this particular inference was
  wrong for that endpoint, and it may need its own service prefix kept
  even in production.
- The token response's field names (`access_token` vs a possible
  PascalCase `AccessToken`) also weren't confirmed from a saved example
  response — the code now checks both, and fails with a clear error
  message (showing the raw response) if neither matches, rather than
  silently caching an unusable token.

**This still inherits the whole "no login" caveat from above.** The
settings panel and its save endpoint have no access control either —
anyone who can reach this dashboard can view its masked status and
overwrite the credentials being used. If that's a real concern, this
needs protection in front of it before relying on it for anything real.

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
