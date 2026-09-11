const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { computeTodayReport, computeReportsForDateRange, computeReportsForCustomRange, resetTokenCache, getEmployees, refreshScheduleAdjustmentsCache, getScheduleAdjustmentCacheStatus } = require('./sprout');
const configStore = require('./config-store');
const authStore = require('./auth-store');

const app = express();
const PORT = process.env.PORT || 3000;

// Needed so req.secure correctly reflects the original client connection
// (Azure Container Apps — and most cloud hosts — terminate HTTPS at an
// edge/proxy layer and forward plain HTTP internally; without this,
// req.secure would always read false even on a real HTTPS deployment,
// and session cookies would never get their `secure` flag set).
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());

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
    secure: true, // req.secure is reliable now that 'trust proxy' is set; plain-HTTP local testing still works since browsers only enforce this over an actual HTTPS page
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
  try {
    const employees = await getEmployees();
    authStore.register(systemId, password, employees);
    setSessionCookie(res, String(systemId).trim()); // auto-login right after registering
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { systemId, password } = req.body || {};
  if (!authStore.verifyLogin(systemId, password)) {
    return res.status(401).json({ ok: false, error: 'Incorrect System ID or password.' });
  }
  setSessionCookie(res, String(systemId).trim());
  res.json({ ok: true });
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
  const requestedDays = parseInt(req.query.days, 10);
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
