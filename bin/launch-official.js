#!/usr/bin/env node
'use strict';
// Launcher for the official Heroku MCP server. Reads the token from the local
// Heroku CLI session and passes it only through the child's environment: it is
// never written to disk, logs, or this process's stdout/stderr.
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { resolveHerokuCli, isFile } = require('../mcp-gaps/lib/exec.js');

const OFFICIAL_PACKAGE = '@heroku/mcp-server@1.2.15';
const TOKEN_TIMEOUT_MS = 15000;
const NO_SESSION_MESSAGE =
  'rogue-heroku-ops: no Heroku CLI session. Run "heroku login" and restart Claude Code.';

function noSession() {
  return { ok: false, message: NO_SESSION_MESSAGE };
}

// herokuFile: path to a CLI script run with node (tests only, HEROKU_OPS_TEST_HEROKU).
async function getToken({ herokuFile, env = process.env, platform = process.platform } = {}) {
  let file;
  let args;
  if (herokuFile) {
    file = process.execPath;
    args = [herokuFile, 'auth:token'];
  } else if (platform === 'win32') {
    try {
      const r = resolveHerokuCli({
        localAppData: env.LOCALAPPDATA,
        programFiles: env.ProgramFiles,
      });
      file = r.node;
      args = [r.script, 'auth:token'];
    } catch (err) {
      return { ok: false, message: `rogue-heroku-ops: Heroku CLI not found (${err.message}).` };
    }
  } else {
    file = 'heroku';
    args = ['auth:token'];
  }

  return new Promise((resolve) => {
    // CLI stdout/stderr are consumed only to extract the token; never reproduced.
    execFile(file, args, { env, timeout: TOKEN_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      const token = err ? '' : String(stdout).trim();
      resolve(token ? { ok: true, token } : noSession());
    });
  });
}

// Case-insensitive env key lookup (Windows may expose Path or PATH).
function envKey(env, name) {
  return Object.keys(env || {}).find((k) => k.toLowerCase() === name.toLowerCase());
}

function versionKey(name) {
  return /^\d+(\.\d+)*$/.test(name) ? name.split('.').map(Number) : null;
}

function compareVersionKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// Windows only: the EDB PostgreSQL installer does not add its bin folder to PATH, but the
// official server runs `heroku pg:*`, which needs psql. Returns the bin folder of the highest
// installed version under %ProgramFiles%\PostgreSQL, or null when nothing needs changing
// (not win32, psql already on PATH, or no installation found).
function findPsqlDir({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  const pathKey = envKey(env, 'PATH');
  const dirs = String((pathKey && env[pathKey]) || '').split(';').filter(Boolean);
  if (dirs.some((d) => isFile(path.join(d, 'psql.exe')))) return null;

  const pfKey = envKey(env, 'ProgramFiles');
  if (!pfKey || !env[pfKey]) return null;
  const root = path.join(env[pfKey], 'PostgreSQL');
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const best = names
    .map((name) => ({ name, key: versionKey(name) }))
    .filter((e) => e.key && isFile(path.join(root, e.name, 'bin', 'psql.exe')))
    .sort((a, b) => compareVersionKeys(b.key, a.key))[0];
  return best ? path.join(root, best.name, 'bin') : null;
}

function buildOfficialSpawn({ token, env = process.env, platform = process.platform } = {}) {
  const childEnv = { ...env, HEROKU_API_KEY: token };
  const psqlDir = findPsqlDir({ env, platform });
  if (psqlDir) {
    const key = envKey(childEnv, 'PATH') || 'PATH';
    childEnv[key] = childEnv[key] ? `${psqlDir};${childEnv[key]}` : psqlDir;
  }
  if (platform === 'win32') {
    // Run npx through node directly: no npx.cmd, so no shell is needed.
    const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    return { file: process.execPath, args: [npxCli, '-y', OFFICIAL_PACKAGE], env: childEnv };
  }
  return { file: 'npx', args: ['-y', OFFICIAL_PACKAGE], env: childEnv };
}

async function main() {
  const t = await getToken({ herokuFile: process.env.HEROKU_OPS_TEST_HEROKU });
  if (!t.ok) {
    process.stderr.write(`${t.message}\n`);
    return 1;
  }
  const s = buildOfficialSpawn({ token: t.token, env: process.env });
  const child = spawn(s.file, s.args, { env: s.env, stdio: 'inherit', windowsHide: true });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  return new Promise((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(`rogue-heroku-ops: failed to start official MCP server (${err.code || 'error'}).\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

module.exports = { getToken, buildOfficialSpawn, findPsqlDir };

if (require.main === module) {
  main().then((code) => process.exit(code));
}
