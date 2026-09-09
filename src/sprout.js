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

  return allEmployees;
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

async function getScheduleAdjustments(dateFromISO, dateToISO, preloadedFirstResponse) {
  let allAdjustments = [];
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const url = buildApiUrl('timeattendance', `/api/v1/ScheduleAdjustments?DateFrom=${encodeURIComponent(dateFromISO)}&DateTo=${encodeURIComponent(dateToISO)}&StatusId=4&SortColumn=DateFiled&SortOrder=asc&RowsPerPage=${pageSize}&PageNumber=${pageNumber}`);
    const response = (pageNumber === 1 && preloadedFirstResponse)
      ? preloadedFirstResponse
      : await fetchWithRetry(url, { headers: await sproutHeaders() });

    if (response.status !== 200) {
      throw new Error(`ScheduleAdjustments list request failed: ${await response.text()}`);
    }
    const data = await response.json();
    const page = data.data || [];
    allAdjustments = allAdjustments.concat(page);
    if (page.length < pageSize) break;
    pageNumber++;
    if (pageNumber > 20) break;
  }

  if (allAdjustments.length === 0) return [];

  const detailHeaders = await sproutHeaders();
  const detailResults = await Promise.all(
    allAdjustments.map(async (item) => {
      try {
        const detailResponse = await fetchWithRetry(
          buildApiUrl('timeattendance', `/api/v1/ScheduleAdjustment/${item.id}`),
          { headers: detailHeaders }
        );
        if (detailResponse.status === 200) return await detailResponse.json();
        return null;
      } catch (err) {
        return null;
      }
    })
  );

  return detailResults.filter((d) => d !== null);
}

function classifyEmployeeForDay(emp, dayContext) {
  const basic = emp.basicInformation || {};
  const work = emp.workInformation || {};
  const schedule = emp.workSchedule || {};
  const name = `${basic.firstName || ''} ${basic.lastName || ''}`;
  const bioId = work.biometricId;
  const systemId = basic.systemId;

  const department = work.department || '—';
  const supervisor = work.reportsTo || '—';
  const contactInfo = { department, supervisor, systemId };

  const adjustment = dayContext.adjustmentByEmployeeId[systemId];
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
      const [endH, endM] = shiftToStr.split(':').map(Number);
      const shiftEnd = new Date(dayContext.dayDate);
      shiftEnd.setHours(endH, endM, 0, 0);
      shiftHasEnded = new Date() > shiftEnd;
    }

    if (shiftHasEnded) {
      return { status: 'didNotReport', entry: { name, ...contactInfo, loginTime, logoutTime, reason: 'no log-in or log-out, shift already ended' } };
    }
    return { status: 'late', entry: { name, ...contactInfo, loginTime, logoutTime, reason: 'no log-in yet, shift still ongoing' } };
  }

  if (!shiftFromStr) {
    return { status: 'onTime', entry: { name, ...contactInfo, loginTime, logoutTime } };
  }

  const [h, m] = shiftFromStr.split(':').map(Number);
  const shiftStart = new Date(inTime);
  shiftStart.setHours(h, m, 0, 0);
  const lateMinutes = Math.round((inTime - shiftStart) / 60000);
  if (lateMinutes > 0) {
    return { status: 'presentButLate', entry: { name, ...contactInfo, loginTime, logoutTime, lateMinutes } };
  }

  return { status: 'onTime', entry: { name, ...contactInfo, loginTime, logoutTime } };
}

function newEmptyReport() {
  return { late: [], presentButLate: [], onLeave: [], onTime: [], restDay: [], didNotReport: [] };
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function buildDayAttendanceIndex(allLogs, dayKey) {
  // First clock-in, LAST clock-out — someone with multiple taps in a day
  // (e.g. a lunch-break out/in) should still show their real end-of-day
  // time, not an early break checkout.
  const firstInByBioId = {};
  const lastOutByBioId = {};
  allLogs.forEach((log) => {
    const logDateKey = formatDateKey(new Date(log.logTime));
    if (logDateKey !== dayKey) return;
    const bioId = log.bioEmpID;
    const logTime = new Date(log.logTime);
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

function buildDayAdjustmentIndex(scheduleAdjustments, dayKey) {
  const adjustmentByEmployeeId = {};
  scheduleAdjustments.forEach((adj) => {
    const empId = adj.employeeId;
    if (!empId || !adj.details) return;
    const dayDetail = adj.details.find((d) => d.date.substring(0, 10) === dayKey);
    if (dayDetail) {
      adjustmentByEmployeeId[empId] = {
        isRestDay: dayDetail.isRestDay,
        shiftFrom: dayDetail.timeFrom,
        shiftTo: dayDetail.timeTo
      };
    }
  });
  return adjustmentByEmployeeId;
}

async function computeTodayReport() {
  const now = new Date();
  const todayKey = formatDateKey(now);
  const dateFromISO = `${todayKey}T00:00:00`;
  const dateToISO = `${todayKey}T23:59:59`;
  const todayWeekday = WEEKDAY_FIELDS[now.getDay()];

  const adjustmentSearchFrom = `${formatDateKey(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000))}T00:00:00`;
  const adjustmentSearchTo = `${formatDateKey(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000))}T23:59:59`;
  const userId = process.env.SPROUT_USER_ID;

  let leaveCheckFailed = false;
  let scheduleAdjustmentCheckFailed = false;

  const headers = await sproutHeaders();
  const leaveHeaders = { ...headers, 'UserId': userId, 'Content-Type': 'application/json' };

  const employeesUrl = buildApiUrl('empservice', '/api/v1/Employees?Include=WorkSchedule&Include=WorkInformation&RowsPerPage=100&PageNumber=1');
  const attendanceUrl = buildApiUrl('timeattendance', `/api/v1/AttendanceLogs?DateFrom=${encodeURIComponent(dateFromISO)}&DateTo=${encodeURIComponent(dateToISO)}&RowsPerPage=100&PageNumber=1`);
  const leaveCreateUrl = buildApiUrl('timeattendance', '/api/v1/Leaves/SearchCriteria');
  const adjustmentsUrl = buildApiUrl('timeattendance', `/api/v1/ScheduleAdjustments?DateFrom=${encodeURIComponent(adjustmentSearchFrom)}&DateTo=${encodeURIComponent(adjustmentSearchTo)}&StatusId=4&SortColumn=DateFiled&SortOrder=asc&RowsPerPage=100&PageNumber=1`);

  const [empResp, attResp, leaveResp, adjResp] = await Promise.allSettled([
    fetchWithRetry(employeesUrl, { headers }),
    fetchWithRetry(attendanceUrl, { headers }),
    fetchWithRetry(leaveCreateUrl, {
      method: 'POST',
      headers: leaveHeaders,
      body: JSON.stringify({ UserId: Number(userId), dateFrom: dateFromISO, dateTo: dateToISO, statusIds: [4], pageNumber: 1, rowsPerPage: 100 })
    }),
    fetchWithRetry(adjustmentsUrl, { headers })
  ]);

  const employees = await getEmployees(empResp.status === 'fulfilled' ? empResp.value : undefined);
  const logs = await getAttendanceLogs(dateFromISO, dateToISO, attResp.status === 'fulfilled' ? attResp.value : undefined);

  let leaves = [];
  try {
    leaves = await getApprovedLeaves(dateFromISO, dateToISO, leaveResp.status === 'fulfilled' ? leaveResp.value : undefined);
  } catch (err) {
    leaveCheckFailed = true;
  }

  let scheduleAdjustments = [];
  try {
    scheduleAdjustments = await getScheduleAdjustments(adjustmentSearchFrom, adjustmentSearchTo, adjResp.status === 'fulfilled' ? adjResp.value : undefined);
  } catch (err) {
    scheduleAdjustmentCheckFailed = true;
  }

  const attendanceIndex = buildDayAttendanceIndex(logs, todayKey);
  const dayContext = {
    weekday: todayWeekday,
    dayDate: now,
    firstInByBioId: attendanceIndex.firstInByBioId,
    lastOutByBioId: attendanceIndex.lastOutByBioId,
    leaveByEmployeeId: buildDayLeaveIndex(leaves, todayKey),
    adjustmentByEmployeeId: buildDayAdjustmentIndex(scheduleAdjustments, todayKey)
  };

  const report = newEmptyReport();
  employees.forEach((emp) => {
    const result = classifyEmployeeForDay(emp, dayContext);
    report[result.status].push(result.entry);
  });

  report.leaveCheckFailed = leaveCheckFailed;
  report.scheduleAdjustmentCheckFailed = scheduleAdjustmentCheckFailed;
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

  let scheduleAdjustments = [];
  let scheduleAdjustmentCheckFailed = false;
  try {
    const adjustmentSearchFrom = `${formatDateKey(new Date(rangeStart.getTime() - 30 * 24 * 60 * 60 * 1000))}T00:00:00`;
    const adjustmentSearchTo = `${formatDateKey(new Date(rangeEnd.getTime() + 30 * 24 * 60 * 60 * 1000))}T23:59:59`;
    scheduleAdjustments = await getScheduleAdjustments(adjustmentSearchFrom, adjustmentSearchTo);
  } catch (err) {
    scheduleAdjustmentCheckFailed = true;
  }

  return dayDates.map((dayDate) => {
    const dayKey = formatDateKey(dayDate);
    const weekday = WEEKDAY_FIELDS[dayDate.getDay()];
    const attendanceIndex = buildDayAttendanceIndex(logs, dayKey);

    const dayContext = {
      weekday,
      dayDate,
      firstInByBioId: attendanceIndex.firstInByBioId,
      lastOutByBioId: attendanceIndex.lastOutByBioId,
      leaveByEmployeeId: buildDayLeaveIndex(leaves, dayKey),
      adjustmentByEmployeeId: buildDayAdjustmentIndex(scheduleAdjustments, dayKey)
    };

    const report = newEmptyReport();
    employees.forEach((emp) => {
      const result = classifyEmployeeForDay(emp, dayContext);
      report[result.status].push(result.entry);
    });
    report.leaveCheckFailed = leaveCheckFailed;
    report.scheduleAdjustmentCheckFailed = scheduleAdjustmentCheckFailed;

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

module.exports = { computeTodayReport, computeReportsForDateRange, computeReportsForCustomRange, resetTokenCache, getEmployees };
