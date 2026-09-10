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

async function getApprovedLeaves(dateFromISO, dateToISO, preloadedCreateResponse) {
  const userId = process.env.SPROUT_USER_ID;
  const createUrl = buildApiUrl('timeattendance', '/api/v1/Leaves/SearchCriteria');
  const createHeaders = { ...(await sproutHeaders()), 'UserId': userId, 'Content-Type': 'application/json' };

  const createResponse = preloadedCreateResponse || await fetchWithRetry(createUrl, {
    method: 'POST',
    headers: createHeaders,
    body: JSON.stringify({
      UserId: Number(userId),
      dateFrom: dateFromISO,
      dateTo: dateToISO,
      statusIds: [4],
      pageNumber: 1,
      rowsPerPage: 100
    })
  });

  if (createResponse.status !== 201 && createResponse.status !== 200) {
    throw new Error(`Leaves SearchCriteria (create) failed: ${await createResponse.text()}`);
  }
  const createData = await createResponse.json();
  const searchCriteriaId = createData.searchCriteriaId;
  if (!searchCriteriaId) return [];

  const fetchUrl = buildApiUrl('timeattendance', `/api/v1/Leaves/SearchCriteria?SearchCriteriaId=${encodeURIComponent(searchCriteriaId)}`);
  const fetchHeaders = { ...(await sproutHeaders()), 'UserId': userId };
  const fetchResponse = await fetchWithRetry(fetchUrl, { headers: fetchHeaders });

  if (fetchResponse.status !== 200) {
    throw new Error(`Leaves SearchCriteria (fetch) failed: ${await fetchResponse.text()}`);
  }
  const fetchData = await fetchResponse.json();
  return fetchData.data || [];
}

// ---------------------------------------------------------------------
// Schedule adjustment background cache.
//
// The only real endpoint for this data (confirmed directly against
// production, after the original "ScheduleAdjustments" resource turned
// out not to exist at all) requires one call PER EMPLOYEE:
//   GET /api/v1/Schedules?DateFrom=...&DateTo=...&EmployeeId=<id>
// At Firstmac's scale (750+ employees) that's far too slow and far too
// close to Sprout's rate limit to run on every dashboard refresh — a
// live user would be stuck waiting minutes for a page load.
//
// Instead, this runs as a periodic BACKGROUND job (see startBackgroundJobs
// in server.js): it walks every employee, paced in small batches so it
// never bursts past Sprout's rate limit, and stores any day that actually
// has an adjustment in this in-memory cache. The dashboard itself always
// reads from whatever's already cached — it never waits on this loop.
// That means adjustment data can be up to one refresh cycle old (a
// deliberate, known tradeoff — see README), not something to "fix" later.
// ---------------------------------------------------------------------

const scheduleAdjustmentCache = new Map(); // key: `${employeeId}|${dayKey}` -> { isRestDay, shiftFrom, shiftTo }
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

function getScheduleAdjustmentCacheStatus() {
  return { ...scheduleAdjustmentCacheState };
}

// Fetches one employee's schedule (including any adjustment) for the
// whole cache window in a single call, and stores any day that actually
// has an adjustment. Failures for one employee are logged and skipped —
// they don't stop the rest of the batch from completing.
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
        if (!day.scheduleAdjustment || !day.date) return;
        const dayKey = day.date.substring(0, 10);
        scheduleAdjustmentCache.set(`${employeeId}|${dayKey}`, {
          isRestDay: !!day.scheduleAdjustment.isRestDay,
          shiftFrom: day.scheduleAdjustment.shiftStart,
          shiftTo: day.scheduleAdjustment.shiftEnd
        });
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
    console.error(`Schedule adjustment fetch failed for employee ${employeeId}:`, err.message);
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

  const leaveInfo = dayContext.leaveByEmployeeId[systemId];
  if (leaveInfo) {
    return {
      status: 'onLeave',
      entry: {
        name, ...contactInfo, loginTime, logoutTime,
        leaveFrom: leaveInfo.dateFrom, leaveTo: leaveInfo.dateTo
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

function buildDayLeaveIndex(allLeaves, dayKey) {
  // Stores the actual leave record (with its date range) per employee,
  // not just a boolean — needed so "On Leave" can show until when the
  // employee is on leave, not just that they are.
  const leaveByEmployeeId = {};
  allLeaves.forEach((leave) => {
    if (!leave.dateFrom || !leave.dateTo) return;
    const fromKey = leave.dateFrom.substring(0, 10);
    const toKey = leave.dateTo.substring(0, 10);
    if (fromKey <= dayKey && dayKey <= toKey) {
      leaveByEmployeeId[leave.employeeId] = { dateFrom: leave.dateFrom, dateTo: leave.dateTo };
    }
  });
  return leaveByEmployeeId;
}

async function computeTodayReport() {
  const now = new Date();
  const todayKey = formatDateKey(now);
  const dateFromISO = `${todayKey}T00:00:00`;
  const dateToISO = `${todayKey}T23:59:59`;
  const todayWeekday = weekdayForDayKey(todayKey);

  const userId = process.env.SPROUT_USER_ID;

  let leaveCheckFailed = false;

  const headers = await sproutHeaders();
  const leaveHeaders = { ...headers, 'UserId': userId, 'Content-Type': 'application/json' };

  const employeesUrl = buildApiUrl('empservice', '/api/v1/Employees?Include=WorkSchedule&Include=WorkInformation&RowsPerPage=100&PageNumber=1');
  const attendanceUrl = buildApiUrl('timeattendance', `/api/v1/AttendanceLogs?DateFrom=${encodeURIComponent(dateFromISO)}&DateTo=${encodeURIComponent(dateToISO)}&RowsPerPage=100&PageNumber=1`);
  const leaveCreateUrl = buildApiUrl('timeattendance', '/api/v1/Leaves/SearchCriteria');

  const [empResp, attResp, leaveResp] = await Promise.allSettled([
    fetchWithRetry(employeesUrl, { headers }),
    fetchWithRetry(attendanceUrl, { headers }),
    fetchWithRetry(leaveCreateUrl, {
      method: 'POST',
      headers: leaveHeaders,
      body: JSON.stringify({ UserId: Number(userId), dateFrom: dateFromISO, dateTo: dateToISO, statusIds: [4], pageNumber: 1, rowsPerPage: 100 })
    })
  ]);

  const employees = await getEmployees(empResp.status === 'fulfilled' ? empResp.value : undefined);
  const logs = await getAttendanceLogs(dateFromISO, dateToISO, attResp.status === 'fulfilled' ? attResp.value : undefined);

  let leaves = [];
  try {
    leaves = await getApprovedLeaves(dateFromISO, dateToISO, leaveResp.status === 'fulfilled' ? leaveResp.value : undefined);
  } catch (err) {
    leaveCheckFailed = true;
  }

  const attendanceIndex = buildDayAttendanceIndex(logs, todayKey);
  const dayContext = {
    weekday: todayWeekday,
    dayDate: now,
    dayKey: todayKey,
    firstInByBioId: attendanceIndex.firstInByBioId,
    lastOutByBioId: attendanceIndex.lastOutByBioId,
    leaveByEmployeeId: buildDayLeaveIndex(leaves, todayKey)
    // Schedule adjustments are read directly from the background cache
    // inside classifyEmployeeForDay (see getCachedAdjustment) — not
    // fetched live here. See the cache section above for why.
  };

  const report = newEmptyReport();
  employees.forEach((emp) => {
    const result = classifyEmployeeForDay(emp, dayContext);
    report[result.status].push(result.entry);
  });

  report.leaveCheckFailed = leaveCheckFailed;
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

  let leaves = [];
  let leaveCheckFailed = false;
  try {
    leaves = await getApprovedLeaves(dateFromISO, dateToISO);
  } catch (err) {
    leaveCheckFailed = true;
  }

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
      lastOutByBioId: attendanceIndex.lastOutByBioId,
      leaveByEmployeeId: buildDayLeaveIndex(leaves, dayKey)
      // Schedule adjustments are read directly from the background cache
      // inside classifyEmployeeForDay (see getCachedAdjustment) — not
      // fetched live here. See the cache section above for why.
    };

    const report = newEmptyReport();
    employees.forEach((emp) => {
      const result = classifyEmployeeForDay(emp, dayContext);
      report[result.status].push(result.entry);
    });
    report.leaveCheckFailed = leaveCheckFailed;
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
