'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { createCompany } = require('../sidecar/lib/company');
function mk({ llm = null, settings = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-'));
  const clock = { t: 1_800_000_000_000 };
  const co = createCompany({ dataDir: dir, llm, now: () => clock.t });
  co.setSettings({ sandbox: { mode: 'process' }, port: 0, ...settings });
  return { co, clock, dir, day: (n = 1) => { clock.t += n * 86400000; } };
}
module.exports = { mk };
