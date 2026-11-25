'use strict';
// Shared project configuration: loading and validation of .claude/rogue-heroku-ops.json.
// Exact path under the project dir, no upward search. Used by the guard, the gaps server and setup.

const fs = require('node:fs');
const path = require('node:path');
const { BRANCH_RE, PATH_PATTERN } = require('../mcp-gaps/lib/validate');
const { validateReadOnlySql } = require('../hooks/lib/sql');

const CONFIG_RELATIVE_PATH = '.claude/rogue-heroku-ops.json';
const SETUP_HINT = 'Run /rogue-heroku-ops:setup to create or fix .claude/rogue-heroku-ops.json in this project.';

const ROOT_KEYS = ['apps', 'n1Mode'];
const APP_KEYS = ['name', 'healthUrl', 'deployBranch', 'repoPath', 'migrations'];
const ROOT_MIGRATIONS_MESSAGE = 'config: migrations moved into each app in 0.2.0; run /rogue-heroku-ops:setup to migrate.';
const MIGRATION_KEYS = ['repoDir', 'appliedQuery', 'filePattern'];
const N1_MODES = ['ask', 'deny'];
const APP_NAME_RE = /^[a-z][a-z0-9-]{1,29}$/;

const WIN = process.platform === 'win32';
const comparable = (p) => (WIN ? p.toLowerCase() : p);
const SEP_CHARS = WIN ? ['/', String.fromCharCode(92)] : ['/'];
const isSep = (ch) => SEP_CHARS.includes(ch);
const stripTrailingSep = (p) => {
  const root = path.parse(p).root;
  let out = p;
  while (out.length > root.length && isSep(out[out.length - 1])) out = out.slice(0, -1);
  return out;
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function unknownKeys(obj, allowed, where) {
  return Object.keys(obj).filter((k) => !allowed.includes(k)).map((k) => `${where}: unknown key "${k}".`);
}

function validateApp(app, i, seen) {
  const where = `apps[${i}]`;
  if (!isObject(app)) return [`${where} must be an object.`];
  const problems = unknownKeys(app, APP_KEYS, where);
  if (typeof app.name !== 'string' || !APP_NAME_RE.test(app.name)) {
    problems.push(`${where}.name must match ${APP_NAME_RE}.`);
  } else if (seen.has(app.name)) {
    problems.push(`${where}.name "${app.name}" is duplicated.`);
  } else {
    seen.add(app.name);
  }
  let urlOk = false;
  if (typeof app.healthUrl === 'string') {
    try { urlOk = ['http:', 'https:'].includes(new URL(app.healthUrl).protocol); } catch { urlOk = false; }
  }
  if (!urlOk) {
    problems.push(`${where}.healthUrl must be an http(s) URL.`);
  } else {
    const u = new URL(app.healthUrl);
    if (u.username !== '' || u.password !== '') problems.push(`${where}.healthUrl must not contain credentials (user or password).`);
  }
  if (typeof app.deployBranch !== 'string' || !BRANCH_RE.test(app.deployBranch)) {
    problems.push(`${where}.deployBranch must be a valid branch name.`);
  }
  if (app.repoPath !== undefined) problems.push(...validateRepoPath(app.repoPath, `${where}.repoPath`));
  if (app.migrations !== undefined) problems.push(...validateMigrations(app.migrations, `${where}.migrations`));
  return problems;
}

function validateMigrations(m, where) {
  if (!isObject(m)) return [`${where} must be an object.`];
  const problems = unknownKeys(m, MIGRATION_KEYS, where);
  if (typeof m.repoDir !== 'string' || !PATH_PATTERN.test(m.repoDir)) {
    problems.push(`${where}.repoDir must be a safe relative path.`);
  }
  if (typeof m.appliedQuery !== 'string') {
    problems.push(`${where}.appliedQuery must be a string.`);
  } else {
    const res = validateReadOnlySql(m.appliedQuery);
    if (!res.ok) problems.push(`${where}.appliedQuery must be read-only SQL: ${res.reason}`);
  }
  if (typeof m.filePattern !== 'string') {
    problems.push(`${where}.filePattern must be a string.`);
  } else {
    try { new RegExp(m.filePattern); } catch { problems.push(`${where}.filePattern must be a valid regular expression.`); }
  }
  return problems;
}

function validateRepoPath(p, where) {
  if (typeof p !== 'string' || p === '') return [`${where} must be a non-empty string.`];
  if (!path.isAbsolute(p)) return [`${where} must be an absolute path.`];
  if (isSep(p[0]) && isSep(p[1])) return [`${where} must not be a UNC path.`];
  const resolved = path.resolve(p);
  const unified = [...p].map((ch) => (isSep(ch) ? path.sep : ch)).join('');
  if (comparable(resolved) !== comparable(stripTrailingSep(unified)) || unified.split(path.sep).some((s) => s === '.' || s === '..')) {
    return [`${where} must be a normalized path without "." or ".." segments.`];
  }
  if (path.parse(resolved).root === resolved) return [`${where} must not be a filesystem root.`];
  try {
    if (!fs.statSync(p).isDirectory()) return [`${where} must be a directory.`];
    if (!fs.existsSync(path.join(p, '.git'))) return [`${where} must be the root of a git repository (no .git found).`];
  } catch {
    return [`${where} must be an existing directory.`];
  }
  return [];
}

function validateConfig(cfg) {
  if (!isObject(cfg)) return ['Config must be a JSON object.'];
  const { migrations, ...rest } = cfg;
  const problems = unknownKeys(rest, ROOT_KEYS, 'config');
  if (migrations !== undefined) problems.push(ROOT_MIGRATIONS_MESSAGE);
  if (!Array.isArray(cfg.apps) || cfg.apps.length === 0) {
    problems.push('apps must be a non-empty array.');
  } else {
    const seen = new Set();
    cfg.apps.forEach((app, i) => problems.push(...validateApp(app, i, seen)));
  }
  if (cfg.n1Mode !== undefined && !N1_MODES.includes(cfg.n1Mode)) {
    problems.push(`n1Mode must be one of: ${N1_MODES.join(', ')}.`);
  }
  return problems;
}

function deepFreeze(o) {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

function loadProjectConfig(projectDir) {
  if (typeof projectDir !== 'string' || projectDir === '') {
    return { ok: false, problems: ['Project directory is not set (CLAUDE_PROJECT_DIR).', SETUP_HINT], file: null };
  }
  const file = path.join(projectDir, CONFIG_RELATIVE_PATH);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'Config file not found.' : 'Config file is unreadable or not valid JSON.';
    return { ok: false, problems: [why, SETUP_HINT], file };
  }
  const problems = validateConfig(raw);
  if (problems.length > 0) return { ok: false, problems: [...problems, SETUP_HINT], file };
  return { ok: true, config: deepFreeze({ ...raw, n1Mode: raw.n1Mode ?? 'ask' }), file };
}

const appByName = (config, name) => config.apps.find((a) => a.name === name);
const deployBranches = (config) => [...new Set(config.apps.map((a) => a.deployBranch))];

const NO_REPO_REASON = (appName) => `App ${appName} has no repository: set repoPath in the config or open the session in the repository root.`;

// Single source of truth for an app's repository: its repoPath, else the project dir only when it is itself a git root (no parent search).
function repoDirFor(config, appName, projectDir) {
  const app = appByName(config, appName);
  if (!app) return { ok: false, reason: `Unknown app ${appName}.` };
  if (app.repoPath !== undefined) return { ok: true, dir: stripTrailingSep(app.repoPath), source: 'repoPath' };
  if (typeof projectDir === 'string' && projectDir !== '' && fs.existsSync(path.join(projectDir, '.git'))) {
    return { ok: true, dir: projectDir, source: 'project' };
  }
  return { ok: false, reason: NO_REPO_REASON(appName) };
}

// Directories the guard may read from: the project dir first, then each distinct repoPath.
function readRoots(config, projectDir) {
  const roots = [projectDir];
  const seen = new Set([comparable(stripTrailingSep(projectDir))]);
  for (const app of config.apps) {
    if (app.repoPath === undefined) continue;
    const dir = stripTrailingSep(app.repoPath);
    if (seen.has(comparable(dir))) continue;
    seen.add(comparable(dir));
    roots.push(dir);
  }
  return roots;
}

module.exports = { CONFIG_RELATIVE_PATH, SETUP_HINT, NO_REPO_REASON, validateConfig, loadProjectConfig, appByName, deployBranches, repoDirFor, readRoots };
