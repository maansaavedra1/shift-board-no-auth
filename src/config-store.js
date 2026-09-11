/**
 * Persists Sprout credentials entered through the frontend's settings
 * screen, so the app doesn't have to be redeployed just to change them.
 *
 * Storage: a plain JSON file on disk (data/sprout-config.json). This is
 * intentionally simple — this app has no database at all otherwise (see
 * README's "What is the database?" note). A Docker volume must be mounted
 * over the `data/` folder for this to survive a container restart —
 * without that, saved settings are lost when the container recreates.
 * See docker-compose.yml.
 *
 * SECURITY NOTE — read this before relying on it:
 * A full login system now protects this file's endpoints (GET and POST
 * /api/settings in server.js both sit behind requireSession — see
 * auth-store.js and README's "Authentication" section). This comment
 * used to say the opposite — that the app had no login at all and these
 * routes were unprotected — which was true in an earlier version but has
 * been wrong since login was added, and would badly mislead anyone
 * reasoning about credential exposure from this file alone.
 *
 * SPROUT_BASE (the API's actual domain) is deliberately NOT stored or
 * settable here — it stays controlled only by the SPROUT_BASE
 * environment variable. Making the base URL editable through an
 * unauthenticated endpoint would let anyone redirect it to a server they
 * control; a real secret typed in later would then be sent straight to
 * that attacker-controlled server instead of Sprout. Keeping it
 * environment-only removes that specific risk.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'sprout-config.json');

const EDITABLE_FIELDS = ['SPROUT_CLIENT_ID', 'SPROUT_CLIENT_SECRET', 'SPROUT_SUBSCRIPTION_KEY', 'SPROUT_USER_ID'];

// Captured at module load time — BEFORE initFromDisk() below has a chance
// to copy any saved-file values into process.env. This is what lets us
// tell "credentials were baked in at deployment (real env vars)" apart
// from "credentials were entered later through the settings screen".
// When every field is already present here, this app was deployed for
// one specific client with credentials fixed at deploy time (per client
// request) — the settings screen becomes read-only and the person using
// the dashboard never needs to see or touch any of this.
const DEPLOYMENT_LOCKED = EDITABLE_FIELDS.every((key) => !!process.env[key]);

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  // Deliberately not caught here, same reasoning as auth-store.js's
  // loadAccounts — a file that exists but fails to parse is genuinely
  // different from "nothing saved yet", and saveConfig below needs to
  // be able to tell them apart rather than silently merging new values
  // into an empty object and overwriting whatever was actually there.
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

// Applies a saved/just-submitted config to process.env so sprout.js picks
// it up immediately, without needing a restart.
function applyConfigToEnv(config) {
  EDITABLE_FIELDS.forEach((key) => {
    if (config[key] !== undefined && config[key] !== '') {
      process.env[key] = config[key];
    }
  });
}

// Loads whatever was saved last time and applies it — called once when
// the server starts. If nothing was ever saved, this does nothing, and
// the app falls back to whatever's in the environment/.env file (useful
// for first boot, before anyone has used the settings screen yet).
// Skipped entirely when deployment-locked, since real env vars already
// take precedence and there's no saved-file editing to layer on top of.
function initFromDisk() {
  if (DEPLOYMENT_LOCKED) {
    console.log('Sprout credentials are deployment-locked (set via environment variables) — settings screen is read-only.');
    return;
  }
  // Wrapped in try/catch specifically because this runs once at server
  // startup — loadConfig now throws on a genuinely corrupt (not just
  // missing) file, and a corrupt saved-settings file should never
  // prevent the whole server from starting. Falling back to
  // env-var-only behavior and logging clearly beats an unbootable
  // container.
  try {
    const saved = loadConfig();
    if (saved) {
      applyConfigToEnv(saved);
      console.log('Loaded saved Sprout settings from ' + CONFIG_PATH);
    }
  } catch (err) {
    console.error('Saved Sprout settings file exists but could not be read (' + CONFIG_PATH + '):', err.message);
    console.error('Falling back to environment-variable credentials only. The settings screen will overwrite this file on next save.');
  }
}

function saveConfig(newValues) {
  if (DEPLOYMENT_LOCKED) {
    throw new Error('Credentials are set at deployment time for this installation and cannot be changed here.');
  }
  const current = loadConfig() || {};
  const merged = { ...current };

  EDITABLE_FIELDS.forEach((key) => {
    if (newValues[key] !== undefined && newValues[key] !== '') {
      merged[key] = newValues[key];
    }
  });

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  // Written to a temp file and renamed into place — rename is atomic on
  // the same filesystem, so a crash mid-write leaves either the old
  // complete file or the new complete file, never a half-written,
  // corrupt one.
  const tempPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(merged, null, 2));
  fs.renameSync(tempPath, CONFIG_PATH);
  applyConfigToEnv(merged);
  return merged;
}

// Safe-to-expose status for the settings screen: confirms what's set
// without ever sending a real secret value back to the browser. Values
// are masked to a short, non-reversible preview (last 4 characters).
function getStatus() {
  const status = {};
  EDITABLE_FIELDS.forEach((key) => {
    const value = process.env[key];
    if (!value) {
      status[key] = { set: false };
    } else if (key === 'SPROUT_CLIENT_SECRET') {
      // Never expose any part of the secret itself, not even masked —
      // just confirm it's set.
      status[key] = { set: true };
    } else {
      const preview = value.length > 4 ? '••••' + value.slice(-4) : '••••';
      status[key] = { set: true, preview };
    }
  });
  return { fields: status, locked: DEPLOYMENT_LOCKED };
}

module.exports = { initFromDisk, saveConfig, getStatus, EDITABLE_FIELDS, DEPLOYMENT_LOCKED };
