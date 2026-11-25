'use strict';
// SessionStart hook: installs the plugin dependencies into ${CLAUDE_PLUGIN_DATA} (node_modules) on the
// first run and again when package.json or package-lock.json change. heroku-ops-gaps finds them through
// NODE_PATH. Portable replacement for the documented `diff || cp && npm install` shell one-liner.
// Always exits 0: a failed install must not block the session (the next session retries).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const FILES = ['package.json', 'package-lock.json'];
const SEAL = '.install-ok';
const REQUIRED = ['@modelcontextprotocol/sdk/server/mcp.js', 'zod'];

function npmCommand(platform = process.platform) {
  const args = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  if (platform === 'win32') {
    // Run npm through node directly: no npm.cmd, so no shell is needed.
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return { file: process.execPath, args: [npmCli, ...args] };
  }
  return { file: 'npm', args };
}

function runCommand(cmd, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd.file, cmd.args, { cwd, windowsHide: true, timeout: 90000 }, (err) => (err ? reject(err) : resolve()));
  });
}

const read = (file) => {
  try { return fs.readFileSync(file); } catch (_e) { return null; }
};

// sha256 over the root package.json + package-lock.json; null when either is missing.
function digest(root) {
  const h = crypto.createHash('sha256');
  for (const f of FILES) {
    const b = read(path.join(root, f));
    if (b === null) return null;
    h.update(b);
  }
  return h.digest('hex');
}

// The seal is written only after a successful npm ci, so an interrupted install never counts as up to date.
function upToDate(root, data) {
  if (!fs.existsSync(path.join(data, 'node_modules'))) return false;
  const want = digest(root);
  const have = read(path.join(data, SEAL));
  return want !== null && have !== null && have.toString('utf8') === want;
}

function resolvesFromRoot(root) {
  try {
    for (const m of REQUIRED) require.resolve(m, { paths: [root] });
    return true;
  } catch (_e) {
    return false;
  }
}

async function installDeps({ root, data, run = runCommand, platform = process.platform, resolves = resolvesFromRoot } = {}) {
  if (!root || !data) return { ok: true, skipped: true };
  if (upToDate(root, data)) return { ok: true, skipped: true };
  // Dependencies already resolve from the plugin root (e.g. --plugin-dir checkout): no install, no network.
  if (resolves(root)) return { ok: true, skipped: true };
  try {
    fs.mkdirSync(data, { recursive: true });
    fs.rmSync(path.join(data, SEAL), { force: true });
    for (const f of FILES) fs.copyFileSync(path.join(root, f), path.join(data, f));
    const want = digest(root);
    await run(npmCommand(platform), data);
    if (want !== null) fs.writeFileSync(path.join(data, SEAL), want);
    return { ok: true };
  } catch (e) {
    // Without package.json in the data dir (and no seal) the next session retries.
    fs.rmSync(path.join(data, 'package.json'), { force: true });
    return { ok: false, message: `rogue-heroku-ops: dependency install failed: ${e.message}` };
  }
}

module.exports = { installDeps, npmCommand };

if (require.main === module) {
  installDeps({ root: process.env.CLAUDE_PLUGIN_ROOT, data: process.env.CLAUDE_PLUGIN_DATA }).then((r) => {
    if (!r.ok) process.stderr.write(r.message + '\n');
    process.exit(0);
  });
}
