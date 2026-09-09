const path = require('path');
const express = require('express');
const { computeTodayReport, computeReportsForDateRange, computeReportsForCustomRange, resetTokenCache, getEmployees } = require('./sprout');
const configStore = require('./config-store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// -----------------------------------------------------------------------
// NO LOGIN, NO ACCESS CONTROL of any kind in this version.
// Anyone who can reach this server's URL can view attendance data, AND
// can view/change the Sprout settings below — there is nothing here
// checking who's asking. If that's not acceptable, this is the file to
// come back to and add protection to.
// -----------------------------------------------------------------------

// Load any previously-saved Sprout credentials (from the settings screen)
// before anything else, so they're in effect for the very first request.
configStore.initFromDisk();

// Serve the dashboard (index.html) as static files from the same container.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check.
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

// Settings screen support. SPROUT_BASE is deliberately not included here
// — see the comment at the top of config-store.js for why.
app.get('/api/settings', (req, res) => {
  res.json({ ok: true, status: configStore.getStatus() });
});

app.post('/api/settings', (req, res) => {
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

// The report endpoint — open to anyone who can reach this server.
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
  console.log(`Shift Board (no-auth version) listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Report endpoint (OPEN — no login required): http://localhost:${PORT}/api/shift-board`);
  console.log(`Settings endpoint (OPEN — no login required): http://localhost:${PORT}/api/settings`);
});
