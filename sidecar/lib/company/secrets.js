'use strict';
const fs = require('node:fs');
const path = require('node:path');
/** Write-only secret store (Law 6): values are never returned by any API. Falls back to process.env. */
function makeSecrets(ctx) {
  const file = path.join(ctx.dataDir, 'company-secrets.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  return {
    set(name, value) {
      data[name] = String(value);
      fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    },
    has(name) { return Boolean(data[name] || process.env[name.toUpperCase()]); },
    names() { return Object.keys(data); },
    /** internal use only – never expose through HTTP */
    _get(name) { return data[name] || process.env[name.toUpperCase()] || null; },
  };
}
module.exports = { makeSecrets };
