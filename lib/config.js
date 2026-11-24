'use strict';
// Shared project configuration: loading and validation of .claude/rogue-heroku-ops.json.
// Exact path under the project dir, no upward search. Used by the guard, the gaps server and setup.

const fs = require('node:fs');
const path = require('node:path');
const { BRANCH_RE, PATH_PATTERN } = require('../mcp-gaps/lib/validate');
const { validateReadOnlySql } = require('../hooks/lib/sql');

const CONFIG_RELATIVE_PATH = '.claude/rogue-heroku-ops.json';
const SETUP_HINT = 'Run /rogue-heroku-ops:setup to create or fix .claude/rogue-heroku-ops.json in this project.';

const ROOT_KEYS = ['apps', 'migrations', 'n1Mode'];
const APP_KEYS = ['name', 'healthUrl', 'deployBranch'];
const MIGRATION_KEYS = ['repoDir', 'appliedQuery', 'filePattern'];
const N1_MODES = ['ask', 'deny'];
const APP_NAME_RE = /^[a-z][a-z0-9-]{1,29}$/;

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
  return problems;
}

function validateMigrations(m) {
  if (!isObject(m)) return ['migrations must be an object.'];
  const problems = unknownKeys(m, MIGRATION_KEYS, 'migrations');
  if (typeof m.repoDir !== 'string' || !PATH_PATTERN.test(m.repoDir)) {
    problems.push('migrations.repoDir must be a safe relative path.');
  }
  if (typeof m.appliedQuery !== 'string') {
    problems.push('migrations.appliedQuery must be a string.');
  } else {
    const res = validateReadOnlySql(m.appliedQuery);
    if (!res.ok) problems.push(`migrations.appliedQuery must be read-only SQL: ${res.reason}`);
  }
  if (typeof m.filePattern !== 'string') {
    problems.push('migrations.filePattern must be a string.');
  } else {
    try { new RegExp(m.filePattern); } catch { problems.push('migrations.filePattern must be a valid regular expression.'); }
  }
  return problems;
}

function validateConfig(cfg) {
  if (!isObject(cfg)) return ['Config must be a JSON object.'];
  const problems = unknownKeys(cfg, ROOT_KEYS, 'config');
  if (!Array.isArray(cfg.apps) || cfg.apps.length === 0) {
    problems.push('apps must be a non-empty array.');
  } else {
    const seen = new Set();
    cfg.apps.forEach((app, i) => problems.push(...validateApp(app, i, seen)));
  }
  if (cfg.migrations !== undefined) problems.push(...validateMigrations(cfg.migrations));
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

module.exports = { CONFIG_RELATIVE_PATH, SETUP_HINT, validateConfig, loadProjectConfig, appByName, deployBranches };
