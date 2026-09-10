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
async function fetchAndCacheAdjustmentsForEmployee(employeeId, dateFromISO, dateToISO) {
  const pageSize = 100;
  try {
    const headers = await sproutHeaders();
    let pageNumber = 1;
    while (true) {
      const url = buildApiUrl('timeattendance', `/api/v1/Schedules?DateFrom=${encodeURIComponent(dateFromISO)}&DateTo=${encodeURIComponent(dateToISO)}&EmployeeId=${encodeURIComponent(employeeId)}&PageNumber=${pageNumber}&RowsPerPage=${pageSize}`);
      const response = await fetchWithRetry(url, { headers });
      if (response.status !== 200) return; // one employee's failure shouldn't break the whole refresh

      const data = await response.json();
      const page = data.data || [];
      page.forEach((day) => {
        if (!day.date) return;
        const dayKey = day.date.substring(0, 10);
        if (day.scheduleAdjustment) {
          scheduleAdjustmentCache.set(`${employeeId}|${dayKey}`, {
            isRestDay: !!day.scheduleAdjustment.isRestDay,
            shiftFrom: day.scheduleAdjustment.shiftStart,
            shiftTo: day.scheduleAdjustment.shiftEnd
          });
        }
        if (day.leaves && day.leaves.length > 0) {
          leaveCache.set(`${employeeId}|${dayKey}`, day.leaves);
        }
      });

      // A wide window (see WINDOW_DAYS_PAST/FUTURE below) can span more
      // days than fit on one page — this loop keeps paging until Sprout
      // returns a short page, rather than silently truncating at 100 days.
      if (page.length < pageSize) break;
      pageNumber++;
      if (pageNumber > 10) break; // sane upper bound — a ~1000-day span should never actually happen here
    }
  } catch (err) {
    // Swallow per-employee errors — logged for visibility, but one bad
    // employee record shouldn't abort caching for everyone else.
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

    scheduleAdjustmentCache.clear(); // rebuild fresh each cycle — avoids unbounded growth over many refreshes
    leaveCache.clear();

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
    : schedule[`${dayContext.weekday}IsRestday`];

  // Log presence is now computed BEFORE the Rest Day / On Leave early
  // returns (previously computed only further down, meaning those two
  // categories never showed any log info at all). This lets Rest Day and
  // On Leave still show the actual check-in/check-out time, if any —
  // real scenarios include an employee working part of a shift before an
  // emergency came up and they filed leave for the rest of the day, so
  // this is genuine attendance data worth seeing, not just an anomaly
  // flag. Sent as ISO strings so the frontend can format them in the
  // viewer's local time.
  const inTime = dayContext.firstInByBioId[bioId];
  const outTime = dayContext.lastOutByBioId[bioId];
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

  const shiftFromStr = (adjustment && adjustment.shiftFrom) || schedule[`${dayContext.weekday}From`];
  const shiftToStr = (adjustment && adjustment.shiftTo) || schedule[`${dayContext.weekday}To`];

  if (!inTime) {
    if (outTime) {
      return {
        status: 'presentButLate',
        entry: { name, ...contactInfo, loginTime, logoutTime, lateMinutes: null, reason: 'missing log-in (has log-out)' }
      };
    }

    let shiftHasEnded = false;
    if (shiftToStr) {
      const shiftEnd = manilaTimeOnDay(dayContext.dayKey, shiftToStr);
      shiftHasEnded = new Date() > shiftEnd;
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

  if (!shiftFromStr) {
    return { status: 'onTime', entry: { name, ...contactInfo, loginTime, logoutTime } };
  }

  const shiftStart = manilaTimeOnDay(dayContext.dayKey, shiftFromStr);
  const lateMinutes = Math.round((inTime - shiftStart) / 60000);
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

function buildDayAttendanceIndex(allLogs, dayKey) {
  // First clock-in, LAST clock-out — someone with multiple taps in a day
  // (e.g. a lunch-break out/in) should still show their real end-of-day
  // time, not an early break checkout.
  const firstInByBioId = {};
  const lastOutByBioId = {};
  allLogs.forEach((log) => {
    const logDateKey = formatDateKey(parseManilaDateTime(log.logTime));
    if (logDateKey !== dayKey) return;
    const bioId = log.bioEmpID;
    const logTime = parseManilaDateTime(log.logTime);
    const modeStr = String(log.inOutMode).toLowerCase();
    const isIn = modeStr === 'in' || modeStr === '0';
    const isOut = modeStr === 'out' || modeStr === '1';
    if (isIn && (!firstInByBioId[bioId] || logTime < firstInByBioId[bioId])) firstInByBioId[bioId] = logTime;
    if (isOut && (!lastOutByBioId[bioId] || logTime > lastOutByBioId[bioId])) lastOutByBioId[bioId] = logTime;
  });
  return { firstInByBioId, lastOutByBioId };
}

async function computeTodayReport() {
  const now = new Date();
  const todayKey = formatDateKey(now);
  const dateFromISO = `${todayKey}T00:00:00`;
  const dateToISO = `${todayKey}T23:59:59`;
  const todayWeekday = weekdayForDayKey(todayKey);

  const headers = await sproutHeaders();

  const employeesUrl = buildApiUrl('empservice', '/api/v1/Employees?Include=WorkSchedule&Include=WorkInformation&RowsPerPage=100&PageNumber=1');
  const attendanceUrl = buildApiUrl('timeattendance', `/api/v1/AttendanceLogs?DateFrom=${encodeURIComponent(dateFromISO)}&DateTo=${encodeURIComponent(dateToISO)}&RowsPerPage=100&PageNumber=1`);

  const [empResp, attResp] = await Promise.allSettled([
    fetchWithRetry(employeesUrl, { headers }),
    fetchWithRetry(attendanceUrl, { headers })
  ]);

  const employees = await getEmployees(empResp.status === 'fulfilled' ? empResp.value : undefined);
  const logs = await getAttendanceLogs(dateFromISO, dateToISO, attResp.status === 'fulfilled' ? attResp.value : undefined);

  const attendanceIndex = buildDayAttendanceIndex(logs, todayKey);
  const dayContext = {
    weekday: todayWeekday,
    dayDate: now,
    dayKey: todayKey,
    firstInByBioId: attendanceIndex.firstInByBioId,
    lastOutByBioId: attendanceIndex.lastOutByBioId
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

  const dateFromISO = `${formatDateKey(rangeStart)}T00:00:00`;
  const dateToISO = `${formatDateKey(rangeEnd)}T23:59:59`;

  const employees = await getEmployees();
  const logs = await getAttendanceLogs(dateFromISO, dateToISO);

  const cacheStatus = getScheduleAdjustmentCacheStatus();

  return dayDates.map((dayDate) => {
    const dayKey = formatDateKey(dayDate);
    const weekday = weekdayForDayKey(dayKey);
    const attendanceIndex = buildDayAttendanceIndex(logs, dayKey);

    const dayContext = {
      weekday,
      dayDate,
      dayKey,
      firstInByBioId: attendanceIndex.firstInByBioId,
      lastOutByBioId: attendanceIndex.lastOutByBioId
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

// One-time diagnostic: checks whether the Schedules endpoint's "leaves"
// field (documented, but never confirmed against real data) actually
// gets populated for anyone. Rather than needing to already know a real
// employee who's on leave right now, this scans across every active
// employee and reports back any day where "leaves" came back non-empty.
// If Sprout's own docs are accurate, this could mean leave status is
// already available through the Schedules call — used for Schedule
// Adjustments already — without needing the separate, currently-blocked
// Leaves/SearchCriteria endpoint at all. Paced the same way as the
// schedule-adjustment cache, to stay safely under Sprout's rate limit.
//
// Runs as a background job, not a single blocking request — a scan
// across hundreds of employees takes several minutes, which is longer
// than most reverse proxies (including Codespaces' own port forwarding)
// will hold a request open for. Start it, then poll the status
// separately, same pattern as the schedule-adjustment cache itself.
const leavesScanState = {
  isRunning: false,
  startedAt: null,
  completedAt: null,
  employeesScanned: 0,
  employeesTotal: 0,
  findings: [],
  error: null
};

function getLeavesScanStatus() {
  return { ...leavesScanState, findings: leavesScanState.findings.slice() };
}

async function startLeavesScan(windowDaysPast, windowDaysFuture) {
  if (leavesScanState.isRunning) return; // already running — don't start a second overlapping scan

  leavesScanState.isRunning = true;
  leavesScanState.startedAt = new Date().toISOString();
  leavesScanState.completedAt = null;
  leavesScanState.employeesScanned = 0;
  leavesScanState.findings = [];
  leavesScanState.error = null;

  try {
    const employees = await getEmployees();
    leavesScanState.employeesTotal = employees.length;

    const now = new Date();
    const rangeStart = new Date(now.getTime() - windowDaysPast * 24 * 60 * 60 * 1000);
    const rangeEnd = new Date(now.getTime() + windowDaysFuture * 24 * 60 * 60 * 1000);
    const dateFromISO = `${formatDateKey(rangeStart)}T00:00:00`;
    const dateToISO = `${formatDateKey(rangeEnd)}T23:59:59`;

    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 1200;

    for (let i = 0; i < employees.length; i += BATCH_SIZE) {
      const batch = employees.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (emp) => {
        const employeeId = emp.basicInformation && emp.basicInformation.systemId;
        const name = `${(emp.basicInformation || {}).firstName || ''} ${(emp.basicInformation || {}).lastName || ''}`.trim();
        if (employeeId == null) return;
        try {
          const url = buildApiUrl('timeattendance', `/api/v1/Schedules?DateFrom=${encodeURIComponent(dateFromISO)}&DateTo=${encodeURIComponent(dateToISO)}&EmployeeId=${encodeURIComponent(employeeId)}&PageNumber=1&RowsPerPage=100`);
          const response = await fetchWithRetry(url, { headers: await sproutHeaders() });
          if (response.status !== 200) return;
          const data = await response.json();
          (data.data || []).forEach((day) => {
            if (day.leaves && day.leaves.length > 0) {
              leavesScanState.findings.push({ employeeId, name, date: (day.date || '').substring(0, 10), leaves: day.leaves });
            }
          });
        } catch (err) {
          // one employee's failure shouldn't abort the whole scan
        }
      }));
      leavesScanState.employeesScanned = Math.min(i + BATCH_SIZE, employees.length);
      if (i + BATCH_SIZE < employees.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    leavesScanState.completedAt = new Date().toISOString();
  } catch (err) {
    leavesScanState.error = err.message;
  } finally {
    leavesScanState.isRunning = false;
  }
}


module.exports = { computeTodayReport, computeReportsForDateRange, computeReportsForCustomRange, resetTokenCache, getEmployees, refreshScheduleAdjustmentsCache, getScheduleAdjustmentCacheStatus, startLeavesScan, getLeavesScanStatus };
