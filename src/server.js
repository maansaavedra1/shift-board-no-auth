const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { computeTodayReport, computeReportsForDateRange, computeReportsForCustomRange, resetTokenCache, getEmployees, refreshScheduleAdjustmentsCache, getScheduleAdjustmentCacheStatus, MAX_CUSTOM_RANGE_DAYS } = require('./sprout');
const configStore = require('./config-store');
const authStore = require('./auth-store');

const app = express();
const PORT = process.env.PORT || 3000;

// Makes req.ip correctly reflect the original client's address rather
// than Azure's internal proxy hop (Azure Container Apps — and most cloud
// hosts — terminate HTTPS at an edge/proxy layer and forward plain HTTP
// internally). This is what the rate limiter below keys on; without it,
// every request would appear to come from the same internal proxy
// address, and the per-IP limit would apply to all users combined
// rather than each one individually. (The cookie's `secure` flag below
// is hardcoded rather than read from req.secure, so this setting isn't
// actually needed for that anymore — kept for the rate limiter instead.)
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());

// Simple, dependency-free rate limiter for the auth routes specifically
// — register() does a handful of real Sprout API calls before this
// existed, and login() runs bcrypt (deliberately slow, ~150-300ms per
// attempt) on Node's single thread with no yielding. Either one looped
// by a script, or an internet scanner that found the hostname, can
// amplify into real load on Sprout's rate limit or block the event loop
// entirely for real users. Keyed by IP (trust proxy above makes req.ip
// reflect the real client through Azure's edge layer, not the proxy).
const authAttempts = new Map(); // ip -> { count, windowStartedAt }
const AUTH_RATE_LIMIT_MAX = 10;
const AUTH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

function authRateLimiter(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now - entry.windowStartedAt > AUTH_RATE_LIMIT_WINDOW_MS) {
    authAttempts.set(ip, { count: 1, windowStartedAt: now });
    return next();
  }
  entry.count++;
  if (entry.count > AUTH_RATE_LIMIT_MAX) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a minute and try again.' });
  }
  next();
}
app.use('/api/auth', authRateLimiter);

// The map above gains one entry per unique IP and nothing ever removed
// an old one — trivial at Firstmac's scale (three admins), but a slow,
// genuine leak if the ingress is ever scanned or hit by unrelated
// internet traffic that finds the hostname. Swept on the same interval
// as the rate limit window itself; an entry whose window has already
// expired is definitionally stale and safe to drop.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authAttempts) {
    if (now - entry.windowStartedAt > AUTH_RATE_LIMIT_WINDOW_MS) {
      authAttempts.delete(ip);
    }
  }
}, AUTH_RATE_LIMIT_WINDOW_MS);

// -----------------------------------------------------------------------
// Login required for everything below except /health and the static
// dashboard shell itself (the page has to load before anyone can log in).
// System ID + password, restricted to a dev-curated allowlist — see
// README's "Authentication" section for the full setup and reasoning.
// This app used to have no access control at all; that gap is now closed.
// -----------------------------------------------------------------------

// Load any previously-saved Sprout credentials (from the settings screen)
// before anything else, so they're in effect for the very first request.
configStore.initFromDisk();

// Schedule adjustments require one Sprout API call PER EMPLOYEE (confirmed
// directly against production — there's no bulk endpoint for this data).
// At real client scale, that's too slow to run inline on every dashboard
// request, so it runs here instead: a periodic background refresh that
// the dashboard reads from whenever it needs adjustment data, never
// waiting on it directly. See the cache section in sprout.js for the
// full reasoning.
//
// One full cycle (750 employees, ±90-day window needing 2 pages each)
// takes roughly 5-6 minutes on its own. This interval is set shorter than
// that on purpose — refreshScheduleAdjustmentsCache() guards against
// overlapping runs, so in practice this means each new cycle starts
// again almost immediately after the previous one finishes, rather than
// sitting idle between them. That's a deliberate choice for freshness,
// not an oversight — it does mean sustained, near-continuous request
// traffic to Sprout (still paced at ~4-5/sec, safely under the observed
// rate limit) rather than a short burst every 20 minutes.
//
// Kicked off once immediately on startup (so the cache isn't empty for
// the entire first cycle), then re-triggered on this timer.  Errors are
// caught and logged inside refreshScheduleAdjustmentsCache itself — a
// failed cycle here should never crash the server.
const SCHEDULE_ADJUSTMENT_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
refreshScheduleAdjustmentsCache().catch((err) => console.error('Initial schedule adjustment cache load failed:', err.message));
setInterval(() => {
  refreshScheduleAdjustmentsCache().catch((err) => console.error('Scheduled adjustment cache refresh failed:', err.message));
}, SCHEDULE_ADJUSTMENT_REFRESH_INTERVAL_MS);

// Serve the dashboard (index.html) as static files from the same container.
// Deliberately NOT behind requireSession — the page shell (which contains
// the login/register form) has to be reachable before anyone can log in.
// Every actual piece of data lives behind the protected API routes below.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check. Deliberately unprotected — standard practice for
// infrastructure/uptime checks, and it reveals nothing sensitive.
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

function setSessionCookie(res, systemId) {
  const token = authStore.createSessionToken(systemId);
  res.cookie(authStore.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true, // Hardcoded, not read from req.secure — this app is only ever served over HTTPS in any real deployment, so there's no case where this should be false. Browsers only enforce the `secure` flag over an actual HTTPS page, so plain-HTTP local testing still works fine despite this being always-true.
    sameSite: 'lax',
    maxAge: authStore.SESSION_TTL_MS
  });
}

app.get('/api/auth/session', (req, res) => {
  const session = authStore.verifySessionToken(req.cookies[authStore.SESSION_COOKIE_NAME]);
  if (!session) return res.json({ ok: true, loggedIn: false });
  res.json({ ok: true, loggedIn: true, systemId: session.systemId });
});

app.post('/api/auth/register', async (req, res) => {
  const { systemId, password } = req.body || {};
  const genericError = 'Registration failed. Check your System ID, or contact your administrator.';
  try {
    // Checked here, before anything else — a cheap, local, in-memory
    // check that costs nothing, deliberately ahead of the expensive
    // Sprout fetch below. Without this, any input (a scanner, a typo, a
    // scripted loop) triggers a handful of real Sprout API calls before
    // ever getting validated — amplifying junk traffic into load on
    // Sprout's own rate limit, on top of the background sync already
    // running continuously.
    const trimmedId = String(systemId || '').trim();
    if (!trimmedId || !authStore.getAllowlist().includes(trimmedId)) {
      return res.status(400).json({ ok: false, error: genericError });
    }
    // Checked here too, before the Sprout fetch — an attempt against an
    // already-claimed ID can never succeed (register() rejects it
    // internally), but without this check that rejection only happens
    // *after* a full paginated employee fetch (four live Sprout calls at
    // ~359 employees) has already run. The allowlist check above closes
    // most of the original amplification; this closes the specific gap
    // where a known, already-registered ID still costs a full fetch on
    // every repeated attempt. Same generic error either way, so this
    // still reveals nothing about which IDs exist.
    if (authStore.accountExists(trimmedId)) {
      return res.status(400).json({ ok: false, error: genericError });
    }
    const employees = await getEmployees();
    authStore.register(systemId, password, employees);
    setSessionCookie(res, trimmedId); // auto-login right after registering
    res.json({ ok: true });
  } catch (err) {
    // Deliberately generic, not err.message — the previous version
    // returned three distinct, verbatim error strings (not on the
    // allowlist / doesn't match a Sprout employee / already registered),
    // which lets anyone walk the numeric System ID space and learn
    // exactly which IDs are allowlisted-but-unregistered — each one a
    // free account waiting to be claimed. err.message could also
    // surface a raw Sprout response body in some failure paths, which
    // has no business reaching an unauthenticated caller either.
    console.error('Registration failed:', err.message);
    res.status(400).json({ ok: false, error: genericError });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { systemId, password } = req.body || {};
  try {
    if (!(await authStore.verifyLogin(systemId, password))) {
      return res.status(401).json({ ok: false, error: 'Incorrect System ID or password.' });
    }
    setSessionCookie(res, String(systemId).trim());
    res.json({ ok: true });
  } catch (err) {
    // Catches a corrupt accounts file (loadAccounts now throws on
    // unparseable JSON rather than silently treating it as "no
    // accounts") — without this try/catch, that throw would surface as
    // an unhandled promise rejection from this async handler, since
    // verifyLogin is itself async now (see its own comment for why).
    console.error('Login failed:', err.message);
    res.status(500).json({ ok: false, error: 'Login is temporarily unavailable. Please try again shortly.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(authStore.SESSION_COOKIE_NAME);
  res.json({ ok: true });
});

// Everything from here down requires a valid, logged-in session.
app.use('/api', authStore.requireSession);

// Admin-assisted password reset. Requires being logged in as SOME admin
// already (req.systemId is set by requireSession above) — with only a
// handful of admins total, any one of them vouching for a reset (by
// already having a valid session) is the actual security model here.
// See auth-store.js's resetAccount() for the full reasoning.
app.post('/api/auth/reset-account', (req, res) => {
  const { systemId } = req.body || {};
  if (!systemId) {
    return res.status(400).json({ ok: false, error: 'System ID is required.' });
  }
  try {
    authStore.resetAccount(systemId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Lets the dashboard (or a curious dev) check on the background schedule
// adjustment cache directly, without needing a full report fetch.
app.get('/api/schedule-adjustment-cache-status', (req, res) => {
  res.json({ ok: true, status: getScheduleAdjustmentCacheStatus() });
});

// Lets the dashboard "nudge" the background schedule-adjustment sync to
// run sooner than its next scheduled interval — called (fire-and-forget)
// whenever the dashboard itself refreshes, so active use naturally keeps
// this data fresher than the fixed timer alone would. Deliberately does
// NOT await the refresh — responds immediately either way, since making
// a routine dashboard refresh wait on a multi-minute per-employee sync
// would be a bad tradeoff (see the cache section in sprout.js). Safe to
// call as often as the dashboard likes — refreshScheduleAdjustmentsCache
// already guards against overlapping runs, so this is a no-op if a cycle
// is already in progress.
app.post('/api/schedule-adjustment-cache/nudge', (req, res) => {
  refreshScheduleAdjustmentsCache().catch((err) => console.error('Nudged schedule adjustment refresh failed:', err.message));
  res.json({ ok: true, status: getScheduleAdjustmentCacheStatus() });
});

// Settings screen support. SPROUT_BASE is deliberately not included here
// — see the comment at the top of config-store.js for why.
app.get('/api/settings', (req, res) => {
  res.json({ ok: true, status: configStore.getStatus() });
});

app.post('/api/settings', (req, res) => {
  if (configStore.DEPLOYMENT_LOCKED) {
    return res.status(403).json({ ok: false, error: 'Credentials are set at deployment time for this installation and cannot be changed here.' });
  }

  const body = req.body || {};
  const allowedKeys = configStore.EDITABLE_FIELDS;
  const submitted = {};
  let anyProvided = false;

  allowedKeys.forEach((key) => {
    if (typeof body[key] === 'string' && body[key].trim() !== '') {
      submitted[key] = body[key].trim();
      anyProvided = true;
    }
  });

  if (!anyProvided) {
    return res.status(400).json({ ok: false, error: 'No values provided. Fill in at least one field.' });
  }

  try {
    configStore.saveConfig(submitted);
    resetTokenCache(); // don't keep using a token obtained under the old credentials
    return res.json({ ok: true, status: configStore.getStatus() });
  } catch (err) {
    console.error('Saving Sprout settings failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Could not save settings on the server: ' + err.message });
  }
});

// The report endpoint — now requires a logged-in session (see the
// requireSession middleware registered above).
app.get('/api/shift-board', async (req, res) => {
  // Clamped here too, visibly, even though computeReportsForDateRange
  // already enforces this same bound internally — a reviewer checking
  // just this line, without tracing into sprout.js, would otherwise
  // reasonably conclude this was unbounded. Redundant protection is
  // cheap; a confusing-looking gap that turns out to be safe anyway
  // still costs someone's time to re-verify.
  const requestedDays = Math.min(parseInt(req.query.days, 10) || 0, MAX_CUSTOM_RANGE_DAYS);
  const fromDate = req.query.from;
  const toDate = req.query.to;

  try {
    // Custom calendar range takes priority if both from/to are given —
    // this is what the date-range picker uses, separate from the
    // "last N days" preset buttons (which still use ?days=).
    if (fromDate && toDate) {
      const dayResults = await computeReportsForCustomRange(fromDate, toDate);
      return res.json({ ok: true, reports: dayResults, generatedAt: new Date().toISOString() });
    }

    if (requestedDays && requestedDays > 1) {
      const dayResults = await computeReportsForDateRange(requestedDays);
      return res.json({ ok: true, reports: dayResults, generatedAt: new Date().toISOString() });
    }

    const report = await computeTodayReport();
    return res.json({ ok: true, report, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Report generation failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Shift Board listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Report endpoint (login required): http://localhost:${PORT}/api/shift-board`);
  console.log(`Settings endpoint (login required): http://localhost:${PORT}/api/settings`);
  console.log(`Admin allowlist: ${authStore.getAllowlist().length ? authStore.getAllowlist().join(', ') : '(none set — nobody can register yet; set ADMIN_ALLOWLIST)'}`);
});
