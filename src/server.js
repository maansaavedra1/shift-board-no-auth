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
// Kicked off once immediately on startup (so the cache isn't empty for
// the entire first refresh interval), then re-run on a timer. Errors are
// caught and logged inside refreshScheduleAdjustmentsCache itself — a
// failed cycle here should never crash the server.
const SCHEDULE_ADJUSTMENT_REFRESH_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
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

// Lets the dashboard (or a curious dev) check on the background schedule
// adjustment cache directly, without needing a full report fetch.
app.get('/api/schedule-adjustment-cache-status', (req, res) => {
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

// Diagnostic endpoint: shows the raw structure of one real employee
// record, so the correct field names for Department/Supervisor can be
// confirmed against actual Sprout data instead of guessed. This has come
// up before — "reportsTo" was a guess that was never verified. Once the
// real field names are confirmed and sprout.js is updated to use them,
// this endpoint can be removed — it's a one-time diagnostic tool, not
// part of the normal report flow.
app.get('/api/debug/employee-sample', async (req, res) => {
  try {
    const employees = await getEmployees();
    if (employees.length === 0) {
      return res.json({ ok: true, note: 'No employees returned from Sprout.', sample: null });
    }
    return res.json({ ok: true, sample: employees[0] });
  } catch (err) {
    console.error('Employee sample fetch failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
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
