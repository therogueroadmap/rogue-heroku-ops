'use strict';

const { validateRev, validateRange, validatePath, validatePaths } = require('./validate');

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

const GIT_PREFIX = (cfg) => ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-C', cfg.repoPath];

// Defense in depth: the tool must be known and the input a plain object with only allowed keys.
function checkInput(tool, input, table) {
  if (typeof tool !== 'string' || !Object.hasOwn(table, tool)) {
    return fail(`La herramienta ${String(tool)} no está soportada.`);
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail('El input debe ser un objeto.');
  }
  for (const key of Object.keys(input)) {
    if (!table[tool].includes(key)) return fail(`El parámetro ${key} no está permitido para ${tool}.`);
  }
  return { ok: true };
}

function has(input, key) {
  return input[key] !== undefined;
}

function validateApp(app, cfg) {
  if (typeof app !== 'string' || !Array.isArray(cfg.apps) || !cfg.apps.includes(app)) {
    return fail(`El parámetro app debe ser una de las apps configuradas: ${(cfg.apps || []).join(', ')}.`);
  }
  return { ok: true, value: app };
}

function validateIntRange(value, name, min, max, def) {
  if (value === undefined) return { ok: true, value: def };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return fail(`El parámetro ${name} debe ser un entero entre ${min} y ${max}.`);
  }
  return { ok: true, value };
}

function validateFormat(format, allowed) {
  if (format === undefined) return { ok: true, flags: [] };
  if (typeof format !== 'string' || !allowed.includes(format)) {
    return fail(`El parámetro format debe ser uno de: ${allowed.join(', ')}.`);
  }
  return { ok: true, flags: [FORMAT_FLAGS[format]] };
}

function validateBool(value, name) {
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== 'boolean') return fail(`El parámetro ${name} debe ser booleano.`);
  return { ok: true, value };
}

function pathsTail(input) {
  const res = validatePaths(input.paths);
  if (!res.ok) return res;
  return { ok: true, tail: res.value.length > 0 ? ['--', ...res.value] : [], list: res.value };
}

function herokuArgs(tool, input, cfg) {
  const check = checkInput(tool, input, HEROKU_KEYS);
  if (!check.ok) return check;
  const app = validateApp(input.app, cfg);
  if (!app.ok) return app;

  if (tool === 'releases_list') {
    const limit = validateIntRange(input.limit, 'limit', 1, 50, 10);
    if (!limit.ok) return limit;
    return ok(['releases', '-n', String(limit.value), '-a', app.value, '--json']);
  }
  if (tool === 'backup_info') {
    if (has(input, 'id') && !(typeof input.id === 'string' && BACKUP_ID_RE.test(input.id))) {
      return fail('El parámetro id debe tener la forma a, b o r seguida de 3 a 6 dígitos (por ejemplo b012).');
    }
    return ok(['pg:backups:info', ...(has(input, 'id') ? [input.id] : []), '-a', app.value]);
  }
  return ok(['pg:backups:capture', '-a', app.value]);
}

function gitLog(input, cfg, P) {
  const hasRev = has(input, 'rev');
  const hasRange = has(input, 'range');
  if (hasRev === hasRange) return fail('Debes indicar exactamente uno de los parámetros rev o range.');
  const target = hasRev ? validateRev(input.rev, cfg.deployBranch) : validateRange(input.range, cfg.deployBranch);
  if (!target.ok) return target;
  const fmt = validateFormat(input.format, ['oneline', 'stat', 'name-only']);
  if (!fmt.ok) return fmt;
  const n = validateIntRange(input.n, 'n', 1, 200, 20);
  if (!n.ok) return n;
  const paths = pathsTail(input);
  if (!paths.ok) return paths;
  return ok([...P, 'log', '--no-ext-diff', '--no-textconv', ...fmt.flags, '-n', String(n.value), target.value, '--', ...paths.list]);
}

function gitShow(input, cfg, P) {
  if (!has(input, 'rev')) return fail('El parámetro rev es obligatorio.');
  const rev = validateRev(input.rev, cfg.deployBranch);
  if (!rev.ok) return rev;
  if (has(input, 'path')) {
    if (has(input, 'format')) return fail('Los parámetros path y format no se pueden combinar.');
    const p = validatePath(input.path);
    if (!p.ok) return p;
    return ok([...P, 'show', '--no-textconv', `${rev.value}:${p.value}`]);
  }
  const fmt = validateFormat(input.format, ['stat', 'name-only']);
  if (!fmt.ok) return fmt;
  return ok([...P, 'show', '--no-ext-diff', '--no-textconv', ...fmt.flags, rev.value]);
}

function gitLsTree(input, cfg, P) {
  if (!has(input, 'rev')) return fail('El parámetro rev es obligatorio.');
  const rev = validateRev(input.rev, cfg.deployBranch);
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

function gitDiff(input, cfg, P) {
  if (!has(input, 'from') || !has(input, 'to')) return fail('Los parámetros from y to son obligatorios.');
  const from = validateRev(input.from, cfg.deployBranch);
  if (!from.ok) return from;
  const to = validateRev(input.to, cfg.deployBranch);
  if (!to.ok) return to;
  const fmt = validateFormat(input.format, ['stat', 'name-only']);
  if (!fmt.ok) return fmt;
  const paths = pathsTail(input);
  if (!paths.ok) return paths;
  return ok([...P, 'diff', '--no-ext-diff', '--no-textconv', ...fmt.flags, `${from.value}..${to.value}`, '--', ...paths.list]);
}

function gitArgs(tool, input, cfg) {
  const check = checkInput(tool, input, GIT_KEYS);
  if (!check.ok) return check;
  const P = GIT_PREFIX(cfg);
  switch (tool) {
    case 'git_fetch': return ok([...P, '-c', 'credential.helper=manager', 'fetch', 'origin']);
    case 'git_log': return gitLog(input, cfg, P);
    case 'git_show': return gitShow(input, cfg, P);
    case 'git_ls_tree': return gitLsTree(input, cfg, P);
    default: return gitDiff(input, cfg, P);
  }
}

module.exports = { herokuArgs, gitArgs };
