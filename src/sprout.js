/**
 * Core Sprout HR integration logic — identical to the verified Azure
 * Functions port (shift-board-azure/src/functions/shiftBoard.js), just
 * extracted into its own module so it can be reused by an Express server
 * instead of an Azure Function trigger. The classification rules and
 * confirmed Sprout API quirks (UserId header, flat Leave response, the
 * Schedule Adjustments date-filter behavior, safe string-based date
 * comparisons) are unchanged.
 *
 * Same caveat as the Azure port: this has NOT been tested against a live
 * Sprout API call. Verify against your sandbox before trusting it with
 * real client data.
 */

// SPROUT_BASE is read fresh each call (not locked in at startup) so it
// stays in sync if it's ever changed via environment config — though in
// this version it's intentionally NOT editable from the frontend/settings
// screen (see src/config-store.js for why).
function getSproutBase() {
  return process.env.SPROUT_BASE || 'https://gateway-sb.sprout.ph';
}
const WEEKDAY_FIELDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

let cachedToken = null;
let cachedTokenExpiry = 0;

// Call this after credentials change (e.g. saved via the settings screen)
// so the next request re-authenticates immediately instead of continuing
// to use a token obtained under the old credentials for up to an hour.
function resetTokenCache() {
  cachedToken = null;
  cachedTokenExpiry = 0;
}

async function fetchWithRetry(url, options, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        lastError = new Error(`Transient HTTP ${response.status}: ${await response.text()}`);
      } else {
        return response;
      }
    } catch (err) {
      lastError = err;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError;
}

// Detects whether SPROUT_BASE is pointed at Sprout's sandbox or a
// production account. Sandbox and production turned out to use genuinely
// different API path structures and auth request formats (confirmed
// against Sprout's own Postman documentation, Sept 2026) — this isn't
// just a different domain, so a single hardcoded path/format can't work
// for both.
function isSandboxEnvironment() {
  return getSproutBase().includes('-sb.');
}

// Sandbox paths are prefixed with a service name (empservice,
// timeattendance); production paths (confirmed for AttendanceLogs,
// INFERRED by pattern for the rest — see README) drop that prefix
// entirely. Centralizing this so every endpoint stays consistent if this
// pattern needs correcting later.
function buildApiUrl(sandboxServicePrefix, pathAndQuery) {
  const base = getSproutBase();
  return isSandboxEnvironment()
    ? `${base}/${sandboxServicePrefix}${pathAndQuery}`
    : `${base}${pathAndQuery}`;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const sandbox = isSandboxEnvironment();

  const tokenUrl = sandbox
    ? `${getSproutBase()}/auth/connect/token`
    : `${getSproutBase()}/api/v1/Auth/client/token`;

  const requestInit = sandbox
    ? {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.SPROUT_SUBSCRIPTION_KEY,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: new URLSearchParams({
          Client_Id: process.env.SPROUT_CLIENT_ID,
          Client_Secret: process.env.SPROUT_CLIENT_SECRET,
          grant_type: 'client_credentials'
        })
      }
    : {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.SPROUT_SUBSCRIPTION_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          ClientId: process.env.SPROUT_CLIENT_ID,
          Secret: process.env.SPROUT_CLIENT_SECRET
        })
      };

  const response = await fetchWithRetry(tokenUrl, requestInit);

  if (response.status !== 200) {
    throw new Error(`Token request failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  // Response field names weren't confirmed from a saved example response
  // in Sprout's docs (only the request format was shown) — checking both
  // the sandbox's snake_case style and a possible PascalCase production
  // style defensively, rather than assuming either.
  cachedToken = data.access_token || data.AccessToken;
  const expiresIn = data.expires_in || data.ExpiresIn || 3600;
  cachedTokenExpiry = Date.now() + (expiresIn - 120) * 1000;
  if (!cachedToken) {
    throw new Error('Token request succeeded but no access token was found in the response. Response shape may differ from what this code expects — check the raw response: ' + JSON.stringify(data));
  }
  return cachedToken;
}

async function sproutHeaders() {
  return {
    'Authorization': `Bearer ${await getAccessToken()}`,
    'Ocp-Apim-Subscription-Key': process.env.SPROUT_SUBSCRIPTION_KEY,
    'Accept': 'application/json'
  };
}

async function getEmployees(preloadedFirstResponse) {
  let allEmployees = [];
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const url = buildApiUrl('empservice', `/api/v1/Employees?Include=WorkSchedule&Include=WorkInformation&RowsPerPage=${pageSize}&PageNumber=${pageNumber}`);
    const response = (pageNumber === 1 && preloadedFirstResponse)
      ? preloadedFirstResponse
      : await fetchWithRetry(url, { headers: await sproutHeaders() });

    if (response.status !== 200) {
      throw new Error(`Employees request failed: ${await response.text()}`);
    }
    const data = await response.json();
    const page = data.data || [];
    allEmployees = allEmployees.concat(page);
    if (page.length < pageSize) break;
    pageNumber++;
    if (pageNumber > 50) break;
  }

  // Excludes resigned and terminated employees — confirmed against real
  // production data (via a one-time diagnostic check of the actual
  // employmentStatus values in use) that these are the only two of the
  // client's originally-requested categories (resigned, terminated,
  // AWOL, end of contract, OJT Ended) that actually exist as distinct
  // statuses in this account; the other three aren't used here at all.
  // Deliberately keeps everyone else, including probationary and
  // maternity — those are still active, working employees, not
  // separated ones, even though they're not "regular" status either.
  const EXCLUDED_EMPLOYMENT_STATUSES = ['resigned', 'terminated'];
  return allEmployees.filter((emp) => {
    const status = ((emp.workInformation || {}).employmentStatus || '').toLowerCase();
    return !EXCLUDED_EMPLOYMENT_STATUSES.includes(status);
  });
}

async function getAttendanceLogs(dateFromISO, dateToISO, preloadedFirstResponse) {
  let allLogs = [];
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const url = buildApiUrl('timeattendance', `/api/v1/AttendanceLogs?DateFrom=${encodeURIComponent(dateFromISO)}&DateTo=${encodeURIComponent(dateToISO)}&RowsPerPage=${pageSize}&PageNumber=${pageNumber}`);
    const response = (pageNumber === 1 && preloadedFirstResponse)
      ? preloadedFirstResponse
      : await fetchWithRetry(url, { headers: await sproutHeaders() });

    if (response.status !== 200) {
      throw new Error(`AttendanceLogs request failed: ${await response.text()}`);
    }
    const data = await response.json();
    const page = data.data || [];
    allLogs = allLogs.concat(page);
    if (page.length < pageSize) break;
    pageNumber++;
    if (pageNumber > 100) break;
  }

  return allLogs;
}

// NOTE: there used to be a getApprovedLeaves() function here, calling
// POST /api/v1/Leaves/SearchCriteria directly. That endpoint is
// currently blocked entirely on Sprout's side (confirmed: a token-issuer
// mismatch tied to production credentials, unrelated to anything in this
// code — see README). Leave status is now sourced from the Schedules
// endpoint's own "leaves" field instead, captured by the same background
// cache used for schedule adjustments — see getCachedLeave below and the
// cache section that follows. Confirmed against real production data
// (real employees, real leave dates, including same-day entries) before
// this switch was made — not just the documented schema.

// ---------------------------------------------------------------------
// Schedule adjustment + leave background cache.
//
// The only real endpoint for schedule adjustments (confirmed directly
// against production, after the original "ScheduleAdjustments" resource
// turned out not to exist at all) requires one call PER EMPLOYEE:
//   GET /api/v1/Schedules?DateFrom=...&DateTo=...&EmployeeId=<id>
// At Firstmac's scale (750+ employees) that's far too slow and far too
// close to Sprout's rate limit to run on every dashboard refresh — a
// live user would be stuck waiting minutes for a page load.
//
// As of the most recent check, this SAME response also carries a real,
// populated "leaves" array per day — confirmed against actual production
// data (dozens of real employees, real leave dates, including same-day
// entries), not just the documented schema. Since the separate
// Leaves/SearchCriteria endpoint is currently blocked entirely on
// Sprout's side (a token-issuer mismatch tied to production credentials
// — see README), this cache now also captures leave data from this same
// per-employee Schedules call, at no extra API cost — one fetch already
// gives us both adjustments and leave status together. Leave checking no
// longer depends on that separate endpoint at all.
//
// Instead, this runs as a periodic BACKGROUND job (see startBackgroundJobs
// in server.js): it walks every employee, paced in small batches so it
// never bursts past Sprout's rate limit, and stores any day that actually
// has an adjustment or a leave in these in-memory caches. The dashboard
// itself always reads from whatever's already cached — it never waits on
// this loop. That means this data can be up to one refresh cycle old (a
// deliberate, known tradeoff — see README), not something to "fix" later.
// ---------------------------------------------------------------------

const scheduleAdjustmentCache = new Map(); // key: `${employeeId}|${dayKey}` -> { isRestDay, shiftFrom, shiftTo }
const leaveCache = new Map(); // key: `${employeeId}|${dayKey}` -> array of { type, paid, isWhole, isFirstHalf }
const scheduleAdjustmentCacheState = {
  lastRefreshedAt: null,   // ISO string, or null if a full cycle has never completed yet
  isRefreshing: false,
  lastError: null,
  employeesProcessed: 0,
  employeesTotal: 0
};

function getCachedAdjustment(employeeId, dayKey) {
  return scheduleAdjustmentCache.get(`${employeeId}|${dayKey}`) || null;
}

function getCachedLeave(employeeId, dayKey) {
  return leaveCache.get(`${employeeId}|${dayKey}`) || null;
}

// Reconstructs an approximate leave date range around a given day, since
// the Schedules-based leave data (see the cache section below) is
// inherently per-day, not a single request record with its own
// dateFrom/dateTo the way the old, now-blocked Leaves endpoint provided.
// Walks backward and forward from the given day, extending the range as
// long as either (a) the same employee has a leave entry of the same
// type that day, or (b) it's one of their scheduled rest days — tolerated
// as a gap within the range, same as a real multi-day leave request
// would span a weekend, without itself counting as a "leave day". Capped
// at 14 days each direction as a sane bound; a leave request longer than
// that would be unusual enough to just show what's directly confirmed.
function reconstructLeaveRange(employeeId, dayKey, leaveType, schedule) {
  const MAX_WALK_DAYS = 14;

  function matchesType(entries) {
    return !!entries && entries.some((l) => l.type === leaveType);
  }
  function isScheduledRestDay(someDayKey) {
    const weekday = weekdayForDayKey(someDayKey);
    return !!schedule[`${weekday}IsRestday`];
  }
  function shiftDayKey(someDayKey, deltaDays) {
    const d = new Date(`${someDayKey}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return formatDateKey(d);
  }

  let startKey = dayKey;
  for (let i = 1; i <= MAX_WALK_DAYS; i++) {
    const candidate = shiftDayKey(dayKey, -i);
    if (matchesType(getCachedLeave(employeeId, candidate))) {
      startKey = candidate;
    } else if (isScheduledRestDay(candidate)) {
      continue; // tolerated gap — keep walking, but don't move startKey to a non-leave day
    } else {
      break;
    }
  }

  let endKey = dayKey;
  for (let i = 1; i <= MAX_WALK_DAYS; i++) {
    const candidate = shiftDayKey(dayKey, i);
    if (matchesType(getCachedLeave(employeeId, candidate))) {
      endKey = candidate;
    } else if (isScheduledRestDay(candidate)) {
      continue;
    } else {
      break;
    }
  }

  return { startKey, endKey };
}

function getScheduleAdjustmentCacheStatus() {
  return { ...scheduleAdjustmentCacheState };
}

// Fetches one employee's schedule (including any adjustment AND any
// leave) for the whole cache window in a single call, and stores any day
// that actually has either. Failures for one employee are logged and
// skipped — they don't stop the rest of the batch from completing.
//
// Builds up this employee's new entries in local maps first, and only
// writes them into the real caches once every page has been fetched
// successfully — deliberately NOT clearing their existing entries
// upfront. A transient failure partway through (more likely for anyone
// needing multiple pages, like an overnight-shift employee with a wide
// history of adjustments) used to leave that person with nothing cached
// at all until the next successful cycle; now they just keep showing
// their last known-good data until a fetch genuinely succeeds again.
async function fetchAndCacheAdjustmentsForEmployee(employeeId, dateFromISO, dateToISO) {
  const pageSize = 100;
  const newAdjustments = new Map();
  const newLeaves = new Map();
  try {
    const headers = await sproutHeaders();
    let pageNumber = 1;
    while (true) {
      const url = buildApiUrl('timeattendance', `/api/v1/Schedules?DateFrom=${encodeURIComponent(dateFromISO)}&DateTo=${encodeURIComponent(dateToISO)}&EmployeeId=${encodeURIComponent(employeeId)}&PageNumber=${pageNumber}&RowsPerPage=${pageSize}`);
      const response = await fetchWithRetry(url, { headers });
      if (response.status !== 200) {
        // This used to return here with ZERO logging — a genuinely
        // silent failure mode that made a real production issue
        // (an employee's adjustment mysteriously never caching)
        // impossible to find by searching server logs. Now logged
        // explicitly, and existing cached data for this employee is
        // left untouched rather than wiped.
        console.error(`Schedule/leave fetch failed for employee ${employeeId}, page ${pageNumber}: HTTP ${response.status}`);
        return;
      }

      const data = await response.json();
      const page = data.data || [];
      page.forEach((day) => {
        if (!day.date) return;
        const dayKey = day.date.substring(0, 10);
        if (day.scheduleAdjustment) {
          newAdjustments.set(`${employeeId}|${dayKey}`, {
            isRestDay: !!day.scheduleAdjustment.isRestDay,
            shiftFrom: day.scheduleAdjustment.shiftStart,
            shiftTo: day.scheduleAdjustment.shiftEnd
          });
        }
        if (day.leaves && day.leaves.length > 0) {
          newLeaves.set(`${employeeId}|${dayKey}`, day.leaves);
        }
      });

      // A wide window (see WINDOW_DAYS_PAST/FUTURE below) can span more
      // days than fit on one page — this loop keeps paging until Sprout
      // returns a short page, rather than silently truncating at 100 days.
      if (page.length < pageSize) break;
      pageNumber++;
      if (pageNumber > 10) break; // sane upper bound — a ~1000-day span should never actually happen here
    }

    // Every page succeeded — now safely replace this employee's entries:
    // clear out anything previously cached for them (in case an
    // adjustment was removed on Sprout's side since last cycle), then
    // apply everything just fetched.
    for (const key of scheduleAdjustmentCache.keys()) {
      if (key.startsWith(`${employeeId}|`)) scheduleAdjustmentCache.delete(key);
    }
    for (const key of leaveCache.keys()) {
      if (key.startsWith(`${employeeId}|`)) leaveCache.delete(key);
    }
    newAdjustments.forEach((value, key) => scheduleAdjustmentCache.set(key, value));
    newLeaves.forEach((value, key) => leaveCache.set(key, value));
  } catch (err) {
    // Swallow per-employee errors — logged for visibility, but one bad
    // employee record shouldn't abort caching for everyone else. Their
    // existing cached entries (if any) are deliberately left untouched.
    console.error(`Schedule adjustment/leave fetch failed for employee ${employeeId}:`, err.message);
  }
}

// Runs one full refresh cycle: every employee, paced in small batches so
// this stays comfortably under Sprout's rate limit (observed as roughly
// 10 requests/second) even at Firstmac's employee count. Safe to call
// repeatedly — guards against overlapping runs.
async function refreshScheduleAdjustmentsCache() {
  if (scheduleAdjustmentCacheState.isRefreshing) return; // already running — skip this trigger
  scheduleAdjustmentCacheState.isRefreshing = true;
  scheduleAdjustmentCacheState.lastError = null;

  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 1200; // ~4/sec, safely under the observed ~10/sec limit
  const WINDOW_DAYS_PAST = 90;
  const WINDOW_DAYS_FUTURE = 90;

  try {
    const employees = await getEmployees();
    scheduleAdjustmentCacheState.employeesTotal = employees.length;
    scheduleAdjustmentCacheState.employeesProcessed = 0;

    const now = new Date();
    const rangeStart = new Date(now.getTime() - WINDOW_DAYS_PAST * 24 * 60 * 60 * 1000);
    const rangeEnd = new Date(now.getTime() + WINDOW_DAYS_FUTURE * 24 * 60 * 60 * 1000);
    const dateFromISO = `${formatDateKey(rangeStart)}T00:00:00`;
    const dateToISO = `${formatDateKey(rangeEnd)}T23:59:59`;

    // No longer a blanket clear() here — each employee's entries are now
    // only replaced once THEIR fetch fully succeeds (see
    // fetchAndCacheAdjustmentsForEmployee), so a transient failure for
    // one person doesn't wipe their last known-good data. This does mean
    // an employee removed from Sprout entirely would keep showing stale
    // data indefinitely rather than disappearing — an acceptable
    // tradeoff, since the employment-status filter already removes
    // resigned/terminated people from getEmployees() itself, so this
    // cache naturally stops being asked about them going forward too.

    for (let i = 0; i < employees.length; i += BATCH_SIZE) {
      const batch = employees.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map((emp) => {
        const employeeId = emp.basicInformation && emp.basicInformation.systemId;
        if (employeeId == null) return Promise.resolve();
        return fetchAndCacheAdjustmentsForEmployee(employeeId, dateFromISO, dateToISO);
      }));
      scheduleAdjustmentCacheState.employeesProcessed = Math.min(i + BATCH_SIZE, employees.length);
      if (i + BATCH_SIZE < employees.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    scheduleAdjustmentCacheState.lastRefreshedAt = new Date().toISOString();
  } catch (err) {
    scheduleAdjustmentCacheState.lastError = err.message;
    console.error('Schedule adjustment cache refresh failed:', err.message);
  } finally {
    scheduleAdjustmentCacheState.isRefreshing = false;
  }
}

function classifyEmployeeForDay(emp, dayContext) {
  const basic = emp.basicInformation || {};
  const work = emp.workInformation || {};
  const schedule = emp.workSchedule || {};
  const name = `${basic.firstName || ''} ${basic.lastName || ''}`;
  const bioId = work.biometricId;
  const systemId = basic.systemId;
  // employeeId is a genuinely separate field from systemId (confirmed
  // against real production data — e.g. systemId: 1, employeeId: "1" as
  // a string) even though they can coincidentally match for some
  // records. Kept alongside systemId (not replacing it) since systemId
  // is still needed internally for matching leave/adjustment records —
  // employeeId is purely for display, per the client's request to show
  // it on the Excel export instead of systemId.
  const employeeId = basic.employeeId;

  const department = work.department || '—';
  const supervisor = work.reportsTo || '—';
  const contactInfo = { department, supervisor, systemId, employeeId };

  const adjustment = getCachedAdjustment(systemId, dayContext.dayKey);
  const isRestDay = adjustment
    ? !!adjustment.isRestDay
    : !!schedule[`${dayContext.weekday}IsRestday`];

  // Shift boundaries computed up front now (previously computed further
  // down, after log-matching) — the in/out matching below needs to know
  // the shift's actual start/end window to search against, rather than
  // just grabbing whatever fell in today's calendar-day bucket. Also
  // computes yesterday's boundaries for this same employee, purely to
  // check whether an overnight shift from yesterday tails into today —
  // see findShiftLogTimes for why that matters.
  const todayBoundaries = getShiftBoundariesForDay(systemId, dayContext.dayKey, schedule);
  const yesterdayKey = formatDateKey(new Date(new Date(`${dayContext.dayKey}T12:00:00Z`).getTime() - 24 * 60 * 60 * 1000));
  const yesterdayBoundaries = getShiftBoundariesForDay(systemId, yesterdayKey, schedule);
  const yesterdayWasOvernightIntoToday = !!(yesterdayBoundaries && yesterdayBoundaries.end && formatDateKey(yesterdayBoundaries.end) === dayContext.dayKey);

  const employeeLogs = (dayContext.logsByBioId && dayContext.logsByBioId[bioId]) || [];
  // On a genuine rest day there's no shift window to search against —
  // fall back to a plain same-calendar-day match, same as the original
  // behavior, just so a rest-day worker's logs still show if present.
  const { inTime, outTime } = (todayBoundaries && !isRestDay)
    ? findShiftLogTimes(employeeLogs, todayBoundaries.start, todayBoundaries.end, yesterdayWasOvernightIntoToday ? yesterdayBoundaries.end : null)
    : (() => {
        let firstIn = null;
        let lastOut = null;
        employeeLogs.forEach((log) => {
          if (formatDateKey(log.time) !== dayContext.dayKey) return;
          if (log.isIn && (!firstIn || log.time < firstIn)) firstIn = log.time;
          if (log.isOut && (!lastOut || log.time > lastOut)) lastOut = log.time;
        });
        return { inTime: firstIn, outTime: lastOut };
      })();

  // Log presence is computed BEFORE the Rest Day / On Leave early
  // returns, so those two categories still show the actual check-in/
  // check-out time, if any — real scenarios include an employee working
  // part of a shift before an emergency came up and they filed leave for
  // the rest of the day, so this is genuine attendance data worth
  // seeing, not just an anomaly flag. Sent as ISO strings so the
  // frontend can format them in the viewer's local time.
  const loginTime = inTime ? inTime.toISOString() : null;
  const logoutTime = outTime ? outTime.toISOString() : null;

  if (isRestDay) {
    return { status: 'restDay', entry: { name, ...contactInfo, loginTime, logoutTime } };
  }

  const leaveEntries = getCachedLeave(systemId, dayContext.dayKey);
  if (leaveEntries && leaveEntries.length > 0) {
    const types = [...new Set(leaveEntries.map((l) => l.type).filter(Boolean))].join(', ');
    const anyHalfDay = leaveEntries.some((l) => l.isWhole === false);
    // Reconstructed from the per-day cache — the primary leave type found
    // for this specific day is what's used to find the surrounding range,
    // since a mixed multi-type day (rare) can't cleanly extend in both
    // directions at once. See reconstructLeaveRange for the full logic.
    const primaryType = leaveEntries[0] && leaveEntries[0].type;
    const range = primaryType ? reconstructLeaveRange(systemId, dayContext.dayKey, primaryType, schedule) : null;
    return {
      status: 'onLeave',
      entry: {
        name, ...contactInfo, loginTime, logoutTime,
        leaveType: types || 'Leave',
        leaveIsHalfDay: anyHalfDay,
        leaveFrom: range ? range.startKey : dayContext.dayKey,
        leaveTo: range ? range.endKey : dayContext.dayKey
      }
    };
  }

  // Adjustment values from Sprout are already full datetimes (confirmed
  // against real production data — e.g. "2026-09-10T21:00:00"), while the
  // default weekly schedule only ever gives a bare "HH:MM" time that still
  // needs combining with the day being checked. These need different
  // parsing — mixing them up (concatenating an already-full datetime as
  // if it were bare "HH:MM") silently produced Invalid Date, discovered
  // via a real case (an employee with a schedule adjustment moving their
  // shift to 9 PM showed as 893 minutes late — compared against their
  // unadjusted 6 AM default instead, since the malformed date meant the
  // adjustment branch never actually took effect for the "is inTime
  // valid" checks it's used in elsewhere). getShiftBoundariesForDay
  // (used above for the log-matching window) already handles this
  // correctly, so these are just reused here for the lateness math below.
  const shiftStartBoundary = todayBoundaries ? todayBoundaries.start : null;
  const shiftEndBoundary = todayBoundaries ? todayBoundaries.end : null;

  if (!inTime) {
    if (outTime) {
      return {
        status: 'presentButLate',
        entry: { name, ...contactInfo, loginTime, logoutTime, lateMinutes: null, reason: 'missing log-in (has log-out)' }
      };
    }

    let shiftHasEnded = false;
    if (shiftEndBoundary) {
      shiftHasEnded = new Date() > shiftEndBoundary;
    }
    // Defensive fallback: even without valid shift-end-time data (a real
    // case saw someone stuck on "Late — shift still ongoing" for a day a
    // week in the past, because their schedule record was missing an end
    // time for that day), a calendar day that isn't today can never
    // still be "ongoing". Missing or bad schedule data shouldn't leave
    // someone misclassified for a day that's obviously already over.
    if (dayContext.dayKey < formatDateKey(new Date())) {
      shiftHasEnded = true;
    }

    if (shiftHasEnded) {
      return { status: 'didNotReport', entry: { name, ...contactInfo, loginTime, logoutTime, reason: 'no log-in or log-out, shift already ended' } };
    }
    return { status: 'late', entry: { name, ...contactInfo, loginTime, logoutTime, reason: 'no log-in yet, shift still ongoing' } };
  }

  if (!shiftStartBoundary) {
    return { status: 'onTime', entry: { name, ...contactInfo, loginTime, logoutTime } };
  }

  const lateMinutes = Math.round((inTime - shiftStartBoundary) / 60000);
  if (lateMinutes > 0) {
    return { status: 'presentButLate', entry: { name, ...contactInfo, loginTime, logoutTime, lateMinutes } };
  }

  return { status: 'onTime', entry: { name, ...contactInfo, loginTime, logoutTime } };
}

function newEmptyReport() {
  return { late: [], presentButLate: [], onLeave: [], onTime: [], restDay: [], didNotReport: [] };
}

// Sprout returns timestamps as naive local Philippine time strings (no
// UTC offset attached), and shift start/end times come from Sprout as
// plain "HH:mm" strings with no date or timezone at all. The server this
// code runs on isn't guaranteed to be in the Philippines timezone
// (Codespaces, Azure, etc. commonly default to UTC) — parsing these
// naive strings without being explicit about the timezone caused a real,
// confirmed bug where displayed times were off by exactly 8 hours
// (Manila's UTC offset from UTC). These helpers make every such parse
// explicit about Asia/Manila, regardless of what timezone the server
// process itself happens to be running in.
function parseManilaDateTime(naiveDateTimeStr) {
  if (!naiveDateTimeStr) return null;
  // Sprout's timestamps are Manila wall-clock time regardless of what
  // suffix (if any) they carry — a real, confirmed case showed a 'Z'
  // suffix on a value that was actually local Manila time, not true UTC.
  // Trusting a 'Z'/offset as accurate reproduced the exact same 8-hour
  // bug this function was built to fix. So: strip any existing
  // timezone marker and always apply +08:00 explicitly, rather than
  // trusting whatever suffix (if any) is already there.
  const stripped = naiveDateTimeStr.replace(/(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i, '');
  return new Date(`${stripped}+08:00`);
}

function manilaTimeOnDay(dayKey, hhmmStr) {
  return parseManilaDateTime(`${dayKey}T${hhmmStr}:00`);
}

// Derives day-of-week purely from the calendar date string (already
// correctly Manila-derived via formatDateKey), rather than calling
// .getDay() on a Date object — which is server-local-timezone-dependent
// and could return the wrong weekday for the same reason described
// above. Anchoring at noon UTC on that date sidesteps any timezone edge
// case entirely, since noon UTC is unambiguously the same calendar day
// in every real-world timezone.
function weekdayForDayKey(dayKey) {
  return WEEKDAY_FIELDS[new Date(`${dayKey}T12:00:00Z`).getUTCDay()];
}

function formatDateKey(date) {
  // Explicit Asia/Manila calendar date, regardless of the server's own
  // runtime timezone — getFullYear/getMonth/getDate are otherwise
  // server-local, which could misclassify a late-night Manila log (e.g.
  // 12:30 AM) into the wrong calendar day entirely on a UTC server.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year').value;
  const mo = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${mo}-${d}`;
}

// Groups ALL attendance logs by employee (bioId), sorted chronologically
// — replaces the old per-calendar-day bucketing. Needed because a single
// overnight shift's check-in and check-out land on two different
// calendar days (e.g. clock in 9 PM Thursday, clock out 9 AM Friday) —
// bucketing strictly by the log's own calendar day was splitting one
// shift's data across two days, and worse, letting the tail-end checkout
// get misread as an unrelated "missing log-in" problem on the second
// day. Matching against the shift's actual time window (computed per
// employee, per day) instead of a fixed calendar-day bucket fixes both
// at once — see classifyEmployeeForDay's in/out matching below.
function buildLogsByBioId(allLogs) {
  const logsByBioId = {};
  allLogs.forEach((log) => {
    const bioId = log.bioEmpID;
    const logTime = parseManilaDateTime(log.logTime);
    if (!logTime || isNaN(logTime.getTime())) return;
    const modeStr = String(log.inOutMode).toLowerCase();
    const isIn = modeStr === 'in' || modeStr === '0';
    const isOut = modeStr === 'out' || modeStr === '1';
    if (!isIn && !isOut) return;
    if (!logsByBioId[bioId]) logsByBioId[bioId] = [];
    logsByBioId[bioId].push({ time: logTime, isIn, isOut });
  });
  Object.keys(logsByBioId).forEach((bioId) => {
    logsByBioId[bioId].sort((a, b) => a.time - b.time);
  });
  return logsByBioId;
}

// Computes an employee's shift start/end boundaries for an ARBITRARY day
// — not just the day currently being classified. Needed to check
// yesterday's shift (from today's perspective) without re-deriving all
// of classifyEmployeeForDay's logic. Returns null if that day is a rest
// day (no shift at all to speak of).
function getShiftBoundariesForDay(systemId, someDayKey, schedule) {
  const someWeekday = weekdayForDayKey(someDayKey);
  const adjustment = getCachedAdjustment(systemId, someDayKey);
  const isRest = adjustment ? !!adjustment.isRestDay : !!schedule[`${someWeekday}IsRestday`];
  if (isRest) return null;

  const fromStr = (adjustment && adjustment.shiftFrom) || schedule[`${someWeekday}From`];
  const toStr = (adjustment && adjustment.shiftTo) || schedule[`${someWeekday}To`];
  const fromIsAdjustment = !!(adjustment && adjustment.shiftFrom);
  const toIsAdjustment = !!(adjustment && adjustment.shiftTo);

  const start = fromStr ? (fromIsAdjustment ? parseManilaDateTime(fromStr) : manilaTimeOnDay(someDayKey, fromStr)) : null;
  const end = toStr ? (toIsAdjustment ? parseManilaDateTime(toStr) : manilaTimeOnDay(someDayKey, toStr)) : null;
  return { start, end };
}

// Finds the real check-in/check-out for a specific shift, searching an
// employee's own chronological log list directly rather than a
// calendar-day bucket — this is what actually lets an overnight shift's
// post-midnight checkout be recognized as belonging to the shift it
// started with, instead of looking like unrelated data on the next day.
//
// previousDayEnd (if the employee had a shift the day before that was
// itself overnight and ends today) is used to exclude a checkout that
// actually belongs to THAT earlier shift — otherwise it could get
// double-counted as this shift's own checkout too.
function findShiftLogTimes(employeeLogs, shiftStart, shiftEnd, previousDayEnd) {
  if (!employeeLogs || employeeLogs.length === 0) return { inTime: null, outTime: null };

  // Search window: from a bit before shift start (covers someone
  // clocking in early) to a generous margin after shift end (covers an
  // overnight shift's checkout the next morning, or someone staying
  // late). 4 hours each direction comfortably covers real early-arrival
  // and late-checkout cases without reaching into a genuinely separate
  // later shift.
  const GRACE_MS = 4 * 60 * 60 * 1000;
  const windowStart = shiftStart ? new Date(shiftStart.getTime() - GRACE_MS) : null;
  const windowEnd = shiftEnd ? new Date(shiftEnd.getTime() + GRACE_MS) : null;

  let inTime = null;
  let outTime = null;

  employeeLogs.forEach((log) => {
    if (windowStart && log.time < windowStart) return;
    if (windowEnd && log.time > windowEnd) return;

    // A checkout that lines up with YESTERDAY's overnight shift ending
    // today belongs to that earlier shift, not this one — exclude it
    // from this shift's own matching so it isn't misread as "this
    // shift's checkout" or, worse, as a sign this shift itself is broken.
    if (previousDayEnd && log.isOut) {
      const previousGraceEnd = new Date(previousDayEnd.getTime() + GRACE_MS);
      if (log.time <= previousGraceEnd) return;
    }

    if (log.isIn && (!inTime || log.time < inTime)) inTime = log.time;
    if (log.isOut && (!outTime || log.time > outTime)) outTime = log.time;
  });

  return { inTime, outTime };
}

async function computeTodayReport() {
  const now = new Date();
  const todayKey = formatDateKey(now);
  const todayWeekday = weekdayForDayKey(todayKey);

  // Attendance logs are fetched one calendar day wider on each side than
  // strictly needed — an overnight shift's checkout can land on the next
  // calendar day (or, less commonly, a very early check-in could sit just
  // before midnight the day before) — without this wider fetch, the log
  // that actually belongs to today's shift might not even be in the
  // dataset being searched. See findShiftLogTimes for how these get
  // matched to the right shift once fetched.
  const logsFromISO = `${formatDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))}T00:00:00`;
  const logsToISO = `${formatDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000))}T23:59:59`;

  const headers = await sproutHeaders();

  const employeesUrl = buildApiUrl('empservice', '/api/v1/Employees?Include=WorkSchedule&Include=WorkInformation&RowsPerPage=100&PageNumber=1');
  const attendanceUrl = buildApiUrl('timeattendance', `/api/v1/AttendanceLogs?DateFrom=${encodeURIComponent(logsFromISO)}&DateTo=${encodeURIComponent(logsToISO)}&RowsPerPage=100&PageNumber=1`);

  const [empResp, attResp] = await Promise.allSettled([
    fetchWithRetry(employeesUrl, { headers }),
    fetchWithRetry(attendanceUrl, { headers })
  ]);

  const employees = await getEmployees(empResp.status === 'fulfilled' ? empResp.value : undefined);
  const logs = await getAttendanceLogs(logsFromISO, logsToISO, attResp.status === 'fulfilled' ? attResp.value : undefined);

  const logsByBioId = buildLogsByBioId(logs);
  const dayContext = {
    weekday: todayWeekday,
    dayDate: now,
    dayKey: todayKey,
    logsByBioId
    // Schedule adjustments AND leave status are both read directly from
    // the background cache inside classifyEmployeeForDay (see
    // getCachedAdjustment / getCachedLeave) — not fetched live here.
    // See the cache section above for why.
  };

  const report = newEmptyReport();
  employees.forEach((emp) => {
    const result = classifyEmployeeForDay(emp, dayContext);
    report[result.status].push(result.entry);
  });

  report.scheduleAdjustmentCache = getScheduleAdjustmentCacheStatus();
  return report;
}

// Shared by both "last N days" (the preset buttons) and a custom
// from/to range (the calendar picker) — both just need to classify
// every day between two dates, they only differ in how that range gets
// decided. Keeping one implementation avoids the two modes silently
// drifting apart from each other over time.
async function computeReportsBetweenDates(rangeStart, rangeEnd) {
  const dayDates = [];
  for (let d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) {
    dayDates.push(new Date(d));
  }

  // Fetched one calendar day wider on each side than the requested range
  // — same reasoning as computeTodayReport: an overnight shift starting
  // on the last day of the range needs its checkout (which lands on the
  // day after) to actually be in the dataset being searched, and
  // similarly for a shift starting the day before the range that tails
  // into its first day.
  const logsFromISO = `${formatDateKey(new Date(rangeStart.getTime() - 24 * 60 * 60 * 1000))}T00:00:00`;
  const logsToISO = `${formatDateKey(new Date(rangeEnd.getTime() + 24 * 60 * 60 * 1000))}T23:59:59`;

  const employees = await getEmployees();
  const logs = await getAttendanceLogs(logsFromISO, logsToISO);
  const logsByBioId = buildLogsByBioId(logs);

  const cacheStatus = getScheduleAdjustmentCacheStatus();

  return dayDates.map((dayDate) => {
    const dayKey = formatDateKey(dayDate);
    const weekday = weekdayForDayKey(dayKey);

    const dayContext = {
      weekday,
      dayDate,
      dayKey,
      logsByBioId
      // Schedule adjustments AND leave status are both read directly from
      // the background cache inside classifyEmployeeForDay (see
      // getCachedAdjustment / getCachedLeave) — not fetched live here.
      // See the cache section above for why.
    };

    const report = newEmptyReport();
    employees.forEach((emp) => {
      const result = classifyEmployeeForDay(emp, dayContext);
      report[result.status].push(result.entry);
    });
    report.scheduleAdjustmentCache = cacheStatus;

    return { dateKey: dayKey, report };
  });
}

async function computeReportsForDateRange(numDays) {
  const now = new Date();
  const rangeStart = new Date(now.getTime() - (numDays - 1) * 24 * 60 * 60 * 1000);
  return computeReportsBetweenDates(rangeStart, now);
}

// Powers the calendar/custom-range picker — accepts explicit "YYYY-MM-DD"
// strings rather than a day count, so any past (or future) span can be
// requested, not just "the last N days ending today".
const MAX_CUSTOM_RANGE_DAYS = 62; // ~2 months — generous, but bounded so
// one bad request can't accidentally ask Sprout for years of logs at once.

async function computeReportsForCustomRange(fromDateStr, toDateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toDateStr)) {
    throw new Error('Dates must be in YYYY-MM-DD format.');
  }
  const rangeStart = new Date(`${fromDateStr}T00:00:00`);
  const rangeEnd = new Date(`${toDateStr}T00:00:00`);
  if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime())) {
    throw new Error('One or both dates are invalid.');
  }
  if (rangeStart > rangeEnd) {
    throw new Error('Start date must be on or before the end date.');
  }
  const spanDays = Math.round((rangeEnd - rangeStart) / (24 * 60 * 60 * 1000)) + 1;
  if (spanDays > MAX_CUSTOM_RANGE_DAYS) {
    throw new Error(`Date range is too wide (${spanDays} days). Please pick a range of ${MAX_CUSTOM_RANGE_DAYS} days or fewer.`);
  }
  return computeReportsBetweenDates(rangeStart, rangeEnd);
}

module.exports = { computeTodayReport, computeReportsForDateRange, computeReportsForCustomRange, resetTokenCache, getEmployees, refreshScheduleAdjustmentsCache, getScheduleAdjustmentCacheStatus };
