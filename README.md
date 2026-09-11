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

### A second, related bug found while verifying the first one

After the fix above, the same employee — the one whose adjustment needs
2 pages of data (182 days across their history) rather than 1 — kept
showing the *same* wrong number, even after confirming his real
adjustment was returned correctly by Sprout. Two real problems, found by
tracing this all the way through:

1. **A non-retryable HTTP failure (e.g. a 404) for any page was
   completely silent** — no log line at all, anywhere. Only genuine
   exceptions (network errors, thrown after retries) were logged; a
   clean non-200 response just returned quietly. This made a real
   production issue impossible to find by searching server logs — there
   was nothing to find.
2. **The whole cache was wiped and rebuilt from scratch on every single
   cycle**, meaning if *any* employee's fetch failed on a *given* cycle
   (more likely for anyone needing multiple pages, since that's more
   requests and more chances to hit something transient), they'd show
   *zero* cached data — not stale data, nothing — until a subsequent
   cycle happened to succeed for them specifically.

Fixed both: HTTP failures are now logged explicitly with the employee ID
and page number, and each employee's cache entries are only replaced
once *their own* fetch fully succeeds — a failure for one person no
longer wipes their last-known-good data, it just keeps showing that
until the next successful fetch. Confirmed both independently: simulated
a 404 and confirmed it's now logged (previously silent); simulated a
transient failure on a second cycle and confirmed the employee's correct
classification survived unchanged rather than reverting to wrong data.

### Graveyard/overnight shifts were getting split across two days

Attendance logs used to be bucketed strictly by the calendar day of
their own timestamp. For a normal shift that's fine, but an overnight
shift's checkout lands on the *next* calendar day — e.g. clock in 9 PM
Thursday, clock out 9 AM Friday. That checkout was landing in Friday's
bucket, completely disconnected from the Thursday shift it actually
belonged to — and worse, it would then get picked up on Friday as an
unexplained "checked out but never checked in" flag, even though nothing
was actually wrong; Friday's real shift (that night) just hadn't started
yet.

Fixed by matching logs against the *shift's own time window* (already
computed per employee, per day) instead of a fixed calendar-day bucket
— see `findShiftLogTimes`, `getShiftBoundariesForDay`, and
`buildLogsByBioId` in `sprout.js`. Each day now also checks whether
*yesterday's* shift for that same employee was itself overnight and
tails into today, so a checkout that genuinely belongs to yesterday's
shift doesn't get double-counted or misread as today's problem. The day
before their next shift actually starts, they're shown in "Late (Shift
Ongoing)" — the same way any employee is shown before their shift has
started, not a special case just for this.

Confirmed against a real overnight case (a 9 PM–9 AM shift): the shift's
own day now correctly shows both the check-in and the next-morning
check-out together as one complete shift, and the following day no
longer shows the misleading "missing log-in" flag. Confirmed no
regression for normal shifts, rest-day-with-real-logs, and Did Not
Report classification, both in `computeTodayReport` and the multi-day
range function.

### A crash this same fix introduced, caught and fixed the same day

Real production error: `"The backend reported an error from Sprout:
Invalid time value"` — a genuine crash, not a Sprout-side issue despite
the wording. Root cause: `getShiftBoundariesForDay` (added for the fix
above) parses a schedule's from/to time into a real `Date`, but didn't
validate the result — and Sprout's own schedule data sometimes has
`isRestDay: false` for a day whose time fields are still the literal
text `"REST DAY"` (a genuine data inconsistency on Sprout's end, not
something this code controls). Parsing that text as a time produces a
technically-truthy-but-invalid `Date` object, and the *following* day's
overnight-shift check (`yesterdayWasOvernightIntoToday`) passed that
straight into `formatDateKey`, which throws exactly `"Invalid time
value"` the moment it tries to format an invalid date.

Fixed at the source: `getShiftBoundariesForDay` now validates its own
`start`/`end` before returning them, so every caller downstream can
trust that a non-null boundary is genuinely usable, without needing its
own separate validity check. Reproduced the exact crash with this same
data pattern before fixing, confirmed it no longer throws afterward, and
re-ran the full graveyard-shift regression suite (Kiev's real overnight
case, normal shifts, rest-day-with-logs) to confirm nothing else broke.

### A severe gap the graveyard-shift fix itself had — permanent night shifts

**Found via testing on a separate Apps Script port of this app** — the
same underlying bug exists here too, and did affect this live
deployment. The original graveyard-shift fix only actually worked for an
overnight shift arriving as a **schedule adjustment**, because those
carry full datetimes that already say which calendar day the shift ends
on. A **permanent** night shift — someone's regular weekly schedule,
e.g. `21:00`–`06:00`, with no adjustment involved at all — arrives as
two bare `"HH:MM"` strings with no date. Both were being anchored to the
*same* calendar day, putting the end nine hours *before* the start. That
inverted window meant every real punch fell outside it, misclassifying
a genuine night-shift worker as **Did Not Report** despite clocking in
and out completely normally. Every previous test of the graveyard fix
happened to use an adjustment-based case, so this gap went unnoticed
until it was found against a different implementation of this same
logic.

Fixed in `getShiftBoundariesForDay`: after computing the day's start/end,
if neither came from an adjustment and the end still falls at or before
the start, push the end forward by 24 hours. Adjustments are
deliberately excluded — their times are already correct as given.
Reproduced the exact failure first (a 21:00–06:00 weekly schedule with
real punches at 21:05 and 06:10, showing Did Not Report with null
times), confirmed the fix correctly reclassifies it as Present but Late
with both times shown, confirmed the following day still correctly
shows Did Not Report before that night's shift starts, and re-ran the
full regression suite (adjustment-based overnight, normal shifts,
rest-day-with-logs, the "REST DAY"-text crash fix) with zero
regressions.

### Public holidays were causing mass false "Did Not Report"

Found via a handover from a separate review pass, and confirmed directly
in this codebase: `holidays[]` rides along in the same `Schedules`
response already being fetched for adjustments and leave, but nothing
here ever actually read it. On any real public holiday, every employee
whose weekly schedule would normally have them working that weekday was
being compared against a shift they were never expected to keep that
day — and correctly not showing up read as **Did Not Report**, for the
whole ~359-person workforce simultaneously, every single time a holiday
occurred.

Real Sprout data distinguishes two holiday types, and they need
different treatment: a **Non-Working Holiday** (e.g. Independence Day)
is a genuine day off — nobody's expected to work. A **Mandatory Working
Holiday** (e.g. a local city anniversary) is still a real working day,
just with premium pay — people who don't show up on one of these are
still correctly flagged, same as any other day. Confirmed this
distinction matters with a direct test: a Non-Working Holiday correctly
excuses someone from Did Not Report; a Mandatory Working Holiday
correctly does not change their classification at all.

Fixed by caching `holidays[]` alongside adjustments and leave (same
background sync, no extra Sprout calls), and checking it right after the
rest-day check in `classifyEmployeeForDay` — reusing the existing Rest
Day category for now rather than introducing a new one, with the actual
holiday's name carried through so the detail column can say "Holiday
(Independence Day)" rather than a generic "On rest day". Confirmed with
a real browser test end-to-end.

An external audit of this codebase (prompted by the night-shift bug
above) found several genuine issues, each reproduced against the real
code before being fixed. In rough order of severity:

**A removed admin kept full access.** `verifyLogin` only checked the
allowlist at registration, never again — and `requireSession` never
checked it at all. Taking someone off `ADMIN_ALLOWLIST` and redeploying,
or using "Reset an admin account", left their *existing* session fully
valid for up to its full 12-hour lifetime; sessions are stateless, so
there was nothing else that could revoke them. Fixed: both now recheck
the allowlist (and, for sessions, that the account still exists) on
every single request, not just at login. Confirmed: removal from the
allowlist and an account reset both now invalidate an existing session
immediately, on the very next request.

**Registration was unauthenticated and revealing.** `/api/auth/register`
ran a handful of real Sprout API calls *before* validating anything, and
returned three distinct, verbatim error messages — enough to walk the
numeric System ID space and find exactly which IDs were
allowlisted-but-unregistered, each one a free account. Fixed: the
allowlist is now checked first, before any Sprout call, and every
failure returns one generic message. A simple rate limiter (10
requests/minute/IP) was also added across all `/api/auth/*` routes,
since nothing previously stopped either endpoint from being hit in a
tight loop.

**Login could block the whole server.** Password verification used
bcrypt's synchronous compare, which holds Node's single thread for
~150-300ms with no yielding — a handful of login attempts per second was
enough to stall every other request, including the health check. Fixed:
switched to bcrypt's async compare. This also meant `loadAccounts`
(which can now throw on a corrupt file — see below) needed proper
try/catch handling added around both the login route and the session
check, so a read failure can't become an unhandled rejection.

**`?days=` had no upper bound.** The custom date-range picker enforces a
62-day maximum; the "last N days" preset buttons didn't share it. A
stray `?days=100000` would build that many day objects and classify
every employee against every one of them, synchronously — long enough
to fail the health check and get the container restarted. Fixed: clamped
to the same 62-day bound. Confirmed: `?days=100000` now returns exactly
62 days.

**A long leave showed a confidently wrong date range.** The leave-range
walk was capped at 14 days each direction — past that, it didn't show
less detail, it showed a *wrong* range with nothing to indicate it was
incomplete. Philippine maternity leave is 105 days, and the employment
filter deliberately keeps maternity employees active — every one of them
would have displayed an incorrect range. Fixed: raised the cap to 120
days (comfortably covers 105), and anything that still exceeds it now
shows honestly — e.g. "On leave (Sep 11, 2026 – Jan 10, 2027 or later)"
— rather than a clean-looking but wrong window. Confirmed with a real
105-day case (shows the full correct range, no truncation) and a 150-day
case (correctly marked as truncated on the end that genuinely couldn't
be walked far enough to resolve).

**A corrupt saved-data file was indistinguishable from an empty one.**
Both `admin-accounts.json` and `sprout-config.json` caught every read
error, including malformed JSON, and silently returned as if nothing had
ever been saved. Combined with non-atomic writes, a crash mid-write
could produce a corrupt file that then looked exactly like "no accounts
yet" — and the next registration would write a fresh file containing
*only* that one new account, permanently losing everyone else who was in
the unreadable original. Fixed: both files now distinguish a genuinely
missing file (returns empty, as before) from one that exists but fails
to parse (throws, so callers can't silently proceed as if nothing was
lost); both now write via a temp file + atomic rename, so a crash
mid-write can't produce a half-written file in the first place. The one
place this *does* run at server startup (`config-store.js`'s
`initFromDisk`) is wrapped in its own try/catch, so a corrupt file can
never prevent the whole server from booting — confirmed directly.

**Smaller fixes from the same audit, also confirmed:** logs with no
`bioEmpID` are now skipped entirely rather than grouped under a shared
`undefined` bucket (previously, every employee missing a biometric ID
would have silently inherited each other's attendance); an unrecognized
`inOutMode` value now logs a warning (once per distinct value, not once
per log line) instead of silently dropping the punch with nothing to
explain it; a System ID containing a period is now rejected at
registration, since it would otherwise break the session token's format
in a way that's very confusing to debug; and two stale comments
(`config-store.js` claiming the app has no login at all, and a cookie
comment implying `req.secure` is read when the value is actually
hardcoded) were corrected to match reality.

**Flagged but not acted on, since it needs an operational check rather
than a code change:** whether this deployment actually runs a single
replica with a persistent volume over `data/`. If it doesn't, saved
accounts/credentials and session signing keys would be inconsistent
across replicas — worth confirming directly in Azure rather than
assuming.

### The cache could go stale silently, and the UI would never say

Found via a separate review pass. `scheduleAdjustmentCacheMessage` used
to treat "has completed at least once" as permanently healthy — once
the background sync succeeded a single time, the dashboard would never
warn about it again, no matter how old the data actually got. A cache
that last completed at 08:00 would show "Schedule adjustments synced
08:00:00" at 6pm, in the same muted grey as always. That matters more
than it sounds: Leave and Schedule Adjustments (and now holidays) all
quietly read as "none" if the cache stops updating — indistinguishable
from a genuinely uneventful day. This isn't hypothetical: the Apps
Script port hit exactly this for hours, and the only thing that caught
it was someone comparing one employee against what Sprout actually
showed.

Fixed: compares the last successful refresh against now, and warns past
2 hours (the cycle takes ~30 minutes at this employee count, so 2 hours
means cycles have genuinely stopped, not just one running long). The
toolbar note itself now renders the stale case in bold red rather than
muted grey — the whole point is that it should stop looking like normal,
healthy data. Confirmed with direct tests: a fresh cache shows no
warning, a cache just under the 2-hour threshold shows no warning
either (no false positives), and a 3-hour-old cache correctly shows both
the banner and the bold red note.

**Related fix, same underlying risk:** there was no request timeout
anywhere in this file. Combined with the background refresh's overlap
guard (`isRefreshing`, which skips a new cycle if one's already running),
a single genuinely stalled Sprout request could hold that flag true
indefinitely — every subsequent scheduled refresh would silently skip,
while the dashboard kept showing its last good timestamp throughout
(exactly the failure the fix above is designed to eventually catch, but
better to prevent the freeze in the first place). Fixed: each request
now aborts after 30 seconds via `AbortController`, surfacing as a normal
retryable error rather than hanging forever. Confirmed with a genuinely
hung request (one that never resolves on its own) — correctly aborts,
retries the full 3 attempts, and throws a clear "Request timed out"
error instead of stalling indefinitely. Confirmed no regression for
normal, fast-resolving requests.

### `?days=` looked unbounded from one line, even though it wasn't

A separate review, checking `server.js` line by line, correctly flagged
`const requestedDays = parseInt(req.query.days, 10);` as unclamped and
concluded the earlier `?days=` fix had been missed. It hadn't — the
actual clamp lived one level deeper, inside `computeReportsForDateRange`
in `sprout.js` (shared with the custom-range path, so both enforce the
same bound from one place rather than duplicating the check). Verified
end-to-end through the real HTTP route before touching anything:
`?days=100000` already returned exactly 62 days in 0.037 seconds, not a
hang. So this was never actually unsafe — but a reviewer reasonably
concluding otherwise from that one line is a real cost by itself. Added
an explicit, visible clamp at the entry point too, referencing the same
exported `MAX_CUSTOM_RANGE_DAYS` constant rather than a duplicated
magic number — redundant with the existing protection, but the point is
that the safety should be obvious without needing to trace into another
file. Re-confirmed the exact same end-to-end request still returns 62
days.

### Registration still fetched employees for an attempt that could never succeed

The allowlist check (see the security audit fixes above) closed most of
the original amplification — junk input is rejected before any Sprout
call now. But an attempt against an ID that's already claimed slipped
past that check (it *is* allowlisted) and still ran a full paginated
employee fetch — several real Sprout calls at Firstmac's scale — before
`register()`'s own "already exists" check finally rejected it, every
single time. The rate limiter already caps this at 10/IP/minute, so it
was a leak rather than a hole, but the load lands on Sprout's own rate
limit, not this app's. Found via a separate implementation hitting the
identical bug, having inherited the same ordering.

Fixed with one more cheap, local check ahead of the Sprout fetch:
`accountExists()`, same generic error either way so it still reveals
nothing about which IDs exist. Confirmed precisely with a real,
timestamped test: a genuinely new registration still triggers the
fetch as expected; a second attempt against that same now-claimed ID
triggers zero additional fetches, rejected immediately instead.

### The holiday type string is a single point of failure — now guarded

Holidays only excuse someone when the type string matches
`"Non-Working Holiday"` exactly — the right rule, since a Mandatory
Working Holiday means premium pay but people are still expected in.
But if Sprout ever returns a type that's neither of the two known
strings (a new category, a spelling change, different casing), holidays
would silently stop being recognized with nothing to explain it — the
whole workforce would go back to reading as Did Not Report on public
holidays, and it would look exactly like the original bug returning
with no signal at all. Fixed with the same pattern already used for
unrecognized `inOutMode` values: a warning logged once per distinct
unrecognized type (not once per occurrence). Confirmed with a real test:
an unrecognized type correctly warns and — just as importantly —
correctly does *not* excuse anyone, a deliberately conservative default
rather than accidentally excusing something unrecognized. Confirmed two
employees sharing the same unrecognized type only produce one warning,
and both previously-recognized types still classify correctly.

### Two smaller cleanup items from the same review

**The rate-limiter map never evicted.** `authAttempts` (added alongside
the rate limiter above) gained one entry per unique IP and never removed
any, for the life of the process — trivial at Firstmac's scale (three
admins), but a genuine slow leak if the ingress is ever scanned by
unrelated internet traffic. Fixed with a periodic sweep on the same
interval as the rate-limit window itself, removing any entry whose
window has already expired. Confirmed directly: a stale (90-second-old)
entry gets swept, an active (10-second-old) one doesn't.

**A rotated Sprout credential could be silently overridden.** If all
four `SPROUT_CLIENT_*` values aren't set (so the settings screen isn't
locked), and someone had previously saved credentials through it, a
credential later rotated via the Container App's own environment
variable would get silently overwritten by the stale saved value at
startup — Azure's own config would correctly show the new value while
the running process kept using the old one, with nothing to explain
why. Fixed with a warning logged specifically when a saved value is
about to override a *different* value already in the environment.
Confirmed: fires correctly when the saved value differs, stays silent
when it matches (no false-positive noise on a normal save).

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
