'use strict';

const { validateRev, validateRange, validatePath, validatePaths } = require('./validate');
const { appByName, deployBranches } = require('../../lib/config');

const BACKUP_ID_RE = /^[abr]\d{3,6}$/;

const HEROKU_KEYS = {
  releases_list: ['app', 'limit'],
  backup_info: ['app', 'id'],
  backup_capture: ['app'],
};

const GIT_KEYS = {
  git_fetch: [],
  git_log: ['rev', 'range', 'format', 'n', 'paths'],
  git_show: ['rev', 'path', 'format'],
  git_ls_tree: ['rev', 'recursive', 'nameOnly', 'paths'],
  git_diff: ['from', 'to', 'format', 'paths'],
};

const FORMAT_FLAGS = { oneline: '--oneline', stat: '--stat', 'name-only': '--name-only' };

const fail = (reason) => ({ ok: false, reason });
const ok = (args) => ({ ok: true, args });

const GIT_PREFIX = (projectDir) => ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-C', projectDir];

// Defense in depth: the tool must be known and the input a plain object with only allowed keys.
function checkInput(tool, input, table) {
  if (typeof tool !== 'string' || !Object.hasOwn(table, tool)) {
    return fail(`Tool ${String(tool)} is not supported.`);
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail('The input must be an object.');
  }
  for (const key of Object.keys(input)) {
    if (!table[tool].includes(key)) return fail(`The ${key} parameter is not allowed for ${tool}.`);
  }
  return { ok: true };
}

function has(input, key) {
  return input[key] !== undefined;
}

function validateApp(app, config) {
  const found = typeof app === 'string' ? appByName(config, app) : undefined;
  if (!found) {
    return fail(`The app parameter must be one of the configured apps: ${config.apps.map((a) => a.name).join(', ')}.`);
  }
  return { ok: true, value: app, app: found };
}

// health_check: validates the app and returns its config entry (healthUrl).
function healthApp(input, config) {
  const check = checkInput('health_check', input, { health_check: ['app'] });
  if (!check.ok) return check;
  const app = validateApp(input.app, config);
  if (!app.ok) return app;
  return { ok: true, app: app.app };
}

function validateIntRange(value, name, min, max, def) {
  if (value === undefined) return { ok: true, value: def };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return fail(`The ${name} parameter must be an integer between ${min} and ${max}.`);
  }
  return { ok: true, value };
}

function validateFormat(format, allowed) {
  if (format === undefined) return { ok: true, flags: [] };
  if (typeof format !== 'string' || !allowed.includes(format)) {
    return fail(`The format parameter must be one of: ${allowed.join(', ')}.`);
  }
  return { ok: true, flags: [FORMAT_FLAGS[format]] };
}

function validateBool(value, name) {
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== 'boolean') return fail(`The ${name} parameter must be a boolean.`);
  return { ok: true, value };
}

function pathsTail(input) {
  const res = validatePaths(input.paths);
  if (!res.ok) return res;
  return { ok: true, tail: res.value.length > 0 ? ['--', ...res.value] : [], list: res.value };
}

function herokuArgs(tool, input, config) {
  const check = checkInput(tool, input, HEROKU_KEYS);
  if (!check.ok) return check;
  const app = validateApp(input.app, config);
  if (!app.ok) return app;

  if (tool === 'releases_list') {
    const limit = validateIntRange(input.limit, 'limit', 1, 50, 10);
    if (!limit.ok) return limit;
    return ok(['releases', '-n', String(limit.value), '-a', app.value, '--json']);
  }
  if (tool === 'backup_info') {
    if (has(input, 'id') && !(typeof input.id === 'string' && BACKUP_ID_RE.test(input.id))) {
      return fail('The id parameter must be a, b or r followed by 3 to 6 digits (for example b012).');
    }
    return ok(['pg:backups:info', ...(has(input, 'id') ? [input.id] : []), '-a', app.value]);
  }
  return ok(['pg:backups:capture', '-a', app.value]);
}

function gitLog(input, branches, P) {
  const hasRev = has(input, 'rev');
  const hasRange = has(input, 'range');
  if (hasRev === hasRange) return fail('Provide exactly one of the rev or range parameters.');
  const target = hasRev ? validateRev(input.rev, branches) : validateRange(input.range, branches);
  if (!target.ok) return target;
  const fmt = validateFormat(input.format, ['oneline', 'stat', 'name-only']);
  if (!fmt.ok) return fmt;
  const n = validateIntRange(input.n, 'n', 1, 200, 20);
  if (!n.ok) return n;
  const paths = pathsTail(input);
  if (!paths.ok) return paths;
  return ok([...P, 'log', '--no-ext-diff', '--no-textconv', ...fmt.flags, '-n', String(n.value), target.value, '--', ...paths.list]);
}

function gitShow(input, branches, P) {
  if (!has(input, 'rev')) return fail('The rev parameter is required.');
  const rev = validateRev(input.rev, branches);
  if (!rev.ok) return rev;
  if (has(input, 'path')) {
    if (has(input, 'format')) return fail('The path and format parameters cannot be combined.');
    const p = validatePath(input.path);
    if (!p.ok) return p;
    return ok([...P, 'show', '--no-textconv', `${rev.value}:${p.value}`]);
  }
  const fmt = validateFormat(input.format, ['stat', 'name-only']);
  if (!fmt.ok) return fmt;
  return ok([...P, 'show', '--no-ext-diff', '--no-textconv', ...fmt.flags, rev.value]);
}

function gitLsTree(input, branches, P) {
  if (!has(input, 'rev')) return fail('The rev parameter is required.');
  const rev = validateRev(input.rev, branches);
  if (!rev.ok) return rev;
  const recursive = validateBool(input.recursive, 'recursive');
  if (!recursive.ok) return recursive;
  const nameOnly = validateBool(input.nameOnly, 'nameOnly');
  if (!nameOnly.ok) return nameOnly;
  const paths = pathsTail(input);
  if (!paths.ok) return paths;
  return ok([
    ...P, 'ls-tree',
    ...(recursive.value ? ['-r'] : []),
    ...(nameOnly.value ? ['--name-only'] : []),
    rev.value, ...paths.tail,
  ]);
}

function gitDiff(input, branches, P) {
  if (!has(input, 'from') || !has(input, 'to')) return fail('The from and to parameters are required.');
  const from = validateRev(input.from, branches);
  if (!from.ok) return from;
  const to = validateRev(input.to, branches);
  if (!to.ok) return to;
  const fmt = validateFormat(input.format, ['stat', 'name-only']);
  if (!fmt.ok) return fmt;
  const paths = pathsTail(input);
  if (!paths.ok) return paths;
  return ok([...P, 'diff', '--no-ext-diff', '--no-textconv', ...fmt.flags, `${from.value}..${to.value}`, '--', ...paths.list]);
}

// ctx: { config, projectDir, platform }. Revs may name origin/<deployBranch of any configured app>.
function gitArgs(tool, input, { config, projectDir, platform = process.platform }) {
  const check = checkInput(tool, input, GIT_KEYS);
  if (!check.ok) return check;
  const P = GIT_PREFIX(projectDir);
  const branches = deployBranches(config);
  switch (tool) {
    // The Git Credential Manager helper only exists on Windows.
    case 'git_fetch': return ok([...P, ...(platform === 'win32' ? ['-c', 'credential.helper=manager'] : []), 'fetch', 'origin']);
    case 'git_log': return gitLog(input, branches, P);
    case 'git_show': return gitShow(input, branches, P);
    case 'git_ls_tree': return gitLsTree(input, branches, P);
    default: return gitDiff(input, branches, P);
  }
}

module.exports = { herokuArgs, gitArgs, healthApp, GIT_PREFIX };
