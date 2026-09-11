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
  if (!fs.existsSync(ACCOUNTS_PATH)) return {};
  // Deliberately NOT caught here — a file that exists but fails to
  // parse (e.g. truncated by a crash mid-write) is a genuinely
  // different situation from "no accounts yet", and callers need to be
  // able to tell them apart. Silently returning {} for both meant a
  // corrupt file looked identical to a fresh install — and the next
  // registration would then write a file containing only that one
  // account, permanently losing everyone else who was in the corrupted
  // file but unreadable.
  return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
}

function saveAccounts(accounts) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Written to a temp file and renamed into place, rather than written
  // directly — rename is atomic on the same filesystem, so a crash
  // mid-write leaves either the old complete file or the new complete
  // file, never a half-written, corrupt one.
  const tempPath = `${ACCOUNTS_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(accounts, null, 2));
  fs.renameSync(tempPath, ACCOUNTS_PATH);
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
  // Session tokens are "<systemId>.<expiry>.<signature>" — a System ID
  // containing a "." would split into the wrong number of parts and
  // silently fail verification on every single request afterward. No
  // real Sprout System ID has ever contained one (they're numeric), but
  // the failure mode this guards against — login appears to succeed,
  // then every subsequent request 401s for no visible reason — is
  // disproportionately confusing for what a one-line check prevents.
  if (systemId.includes('.')) {
    throw new Error('System ID cannot contain a period.');
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

async function verifyLogin(systemId, password) {
  systemId = String(systemId).trim();
  // Re-checked on every login, not just at registration — removing
  // someone from the allowlist and redeploying should actually revoke
  // them, not just block new signups. See requireSession below for the
  // other half of this (an *existing* session also needs to stop
  // working, not just future logins).
  if (!getAllowlist().includes(systemId)) return false;
  const accounts = loadAccounts();
  const account = accounts[systemId];
  if (!account) return false;
  // Async, not compareSync — bcrypt is deliberately slow (by design, to
  // resist cracking), but the sync version holds Node's single thread
  // for the full ~150-300ms with no yielding. A handful of login
  // attempts per second is enough to starve every other request,
  // including the health check. The async version offloads the actual
  // hashing to bcrypt's internal thread pool instead.
  return new Promise((resolve, reject) => {
    bcrypt.compare(password || '', account.passwordHash, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
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
  try {
    // A valid, unexpired token alone isn't enough — sessions are
    // stateless (no server-side store to invalidate directly), so
    // without this check an admin removed from the allowlist, or reset
    // via "Reset an admin account", would keep full access on their
    // existing cookie for up to the full 12-hour TTL. This makes removal
    // and reset actually take effect immediately, on the very next
    // request. Wrapped in try/catch since accountExists now reads a file
    // that can throw on genuinely corrupt (not just missing) data — this
    // runs on every protected request, so it needs a clean JSON error
    // rather than relying on Express's default HTML error page.
    if (!getAllowlist().includes(session.systemId) || !accountExists(session.systemId)) {
      return res.status(401).json({ ok: false, error: 'Not logged in.' });
    }
  } catch (err) {
    console.error('Session check failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Temporarily unavailable. Please try again shortly.' });
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
