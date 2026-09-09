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
 * This version of the app has NO login of any kind (see main README).
 * That means the endpoints that read/write this file (GET and POST
 * /api/settings in server.js) are also unprotected — anyone who can
 * reach this server can view masked settings status and, more
 * importantly, OVERWRITE the credentials being used. There is nothing
 * stopping that in this version. If that's not acceptable, this needs
 * some form of access control in front of it before real use.
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

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Could not read saved Sprout settings (' + CONFIG_PATH + '):', err.message);
    return null;
  }
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
function initFromDisk() {
  const saved = loadConfig();
  if (saved) {
    applyConfigToEnv(saved);
    console.log('Loaded saved Sprout settings from ' + CONFIG_PATH);
  }
}

function saveConfig(newValues) {
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
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
  return status;
}

module.exports = { initFromDisk, saveConfig, getStatus, EDITABLE_FIELDS };
