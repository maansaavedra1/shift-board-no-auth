/**
 * Authentication for the dashboard: System ID + password login, restricted
 * to a dev-curated allowlist of System IDs, with each account's identity
 * double-checked against real Sprout employee data at registration time
 * (so someone can't register under a System ID that isn't actually a real
 * employee, even if it somehow ended up on the allowlist by mistake).
 *
 * This replaces what used to be a fully open, no-login dashboard — see
 * README's "Authentication" section for the full reasoning and setup.
 *
 * Storage: a plain JSON file on disk (data/admin-accounts.json), same
 * pattern as config-store.js's saved Sprout settings. Passwords are never
 * stored in plain text — only a bcrypt hash. The same Docker-volume
 * caveat applies: without a persistent volume over data/, accounts are
 * lost on container restart, same as Sprout credentials would be.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACCOUNTS_PATH = path.join(DATA_DIR, 'admin-accounts.json');

const SESSION_COOKIE_NAME = 'sb_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Signs session tokens. Falls back to a random value generated at process
// start if SESSION_SECRET isn't set — this still works, but it means every
// existing session is invalidated (everyone logged out) on every restart,
// since the signing key changes each time. Set SESSION_SECRET in a real
// deployment to avoid that.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set — using a random key for this process only. Everyone will be logged out on every restart until this is set explicitly.');
}

function getAllowlist() {
  const raw = process.env.ADMIN_ALLOWLIST || '';
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

function loadAccounts() {
  try {
    if (!fs.existsSync(ACCOUNTS_PATH)) return {};
    return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  } catch (err) {
    console.error('Could not read admin accounts (' + ACCOUNTS_PATH + '):', err.message);
    return {};
  }
}

function saveAccounts(accounts) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2));
}

// Confirms a System ID corresponds to a real, currently-returned Sprout
// employee — not just a well-formed number. Takes the already-fetched
// employee list (from getEmployees()) rather than fetching itself, so
// this stays fast and doesn't add its own separate Sprout call.
function isRealEmployee(systemId, employees) {
  return employees.some((emp) => String(emp.basicInformation && emp.basicInformation.systemId) === String(systemId));
}

function register(systemId, password, employees) {
  systemId = String(systemId).trim();
  if (!systemId || !password) {
    throw new Error('System ID and password are both required.');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  if (!getAllowlist().includes(systemId)) {
    throw new Error('This System ID is not on the approved admin list. Contact your administrator to be added.');
  }
  if (!isRealEmployee(systemId, employees)) {
    throw new Error('This System ID does not match a current Sprout employee record.');
  }

  const accounts = loadAccounts();
  if (accounts[systemId]) {
    throw new Error('An account for this System ID already exists. Use the login screen instead.');
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  accounts[systemId] = { passwordHash, registeredAt: new Date().toISOString() };
  saveAccounts(accounts);
}

function verifyLogin(systemId, password) {
  systemId = String(systemId).trim();
  const accounts = loadAccounts();
  const account = accounts[systemId];
  if (!account) return false;
  return bcrypt.compareSync(password || '', account.passwordHash);
}

function accountExists(systemId) {
  const accounts = loadAccounts();
  return !!accounts[String(systemId).trim()];
}

// Admin-assisted password reset: any currently logged-in admin can clear
// another (or their own) account's entry, letting that System ID
// register fresh with a new password. Deliberately not self-service by
// the person who forgot their password — since they can't log in, they
// couldn't trigger this themselves anyway. With only a small, known set
// of admins, having any one of them vouch for the reset (by already
// being logged in themselves) is a reasonable bar — see README for the
// full reasoning and the tradeoffs against a real email-based reset.
function resetAccount(systemId) {
  systemId = String(systemId).trim();
  const accounts = loadAccounts();
  if (!accounts[systemId]) {
    throw new Error('No account exists for this System ID.');
  }
  delete accounts[systemId];
  saveAccounts(accounts);
}

// --- Session tokens -----------------------------------------------------
// A simple signed cookie: "<systemId>.<expiryMs>.<hmacSignature>". No
// server-side session store needed — the signature alone proves it
// wasn't tampered with, and the expiry is checked on every request.

function createSessionToken(systemId) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${systemId}.${expiresAt}`;
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [systemId, expiresAtStr, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(`${systemId}.${expiresAtStr}`).digest('hex');

  // Constant-time comparison — avoids leaking timing information about
  // how much of the signature matched.
  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null;
  }

  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return null; // expired

  return { systemId };
}

// Express middleware — blocks the request with 401 unless a valid,
// unexpired session cookie is present. Attaches req.systemId on success.
function requireSession(req, res, next) {
  const session = verifySessionToken(req.cookies && req.cookies[SESSION_COOKIE_NAME]);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Not logged in.' });
  }
  req.systemId = session.systemId;
  next();
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  getAllowlist,
  register,
  verifyLogin,
  accountExists,
  resetAccount,
  createSessionToken,
  verifySessionToken,
  requireSession
};
