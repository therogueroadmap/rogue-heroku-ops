'use strict';
const path = require('node:path');

/**
 * @typedef {Object} Config
 * @property {string[]} apps
 * @property {string} healthUrl
 * @property {string} repoPath
 * @property {string} deployBranch
 * @property {string} postgresBin
 * @property {'ask'|'deny'} n1Mode
 * @property {boolean} sqlRewrite
 */

/**
 * @typedef {Object} Decision
 * @property {'allow'|'ask'|'deny'} decision
 * @property {'N0'|'N1'|'N3'} level
 * @property {string} reason  Message for the PO (Spanish).
 * @property {Object} [updatedInput]
 */

// Readonly set: mutators throw, so callers cannot accidentally add tools.
// (Object.freeze does not stop Set#add, hence the subclass.)
class ReadonlySet extends Set {
  constructor(items) {
    super(items);
    this._sealed = true;
  }
  add(v) {
    if (this._sealed) throw new TypeError('ReadonlySet: cannot add');
    return super.add(v);
  }
  delete() { throw new TypeError('ReadonlySet: cannot delete'); }
  clear() { throw new TypeError('ReadonlySet: cannot clear'); }
}

const MCP_PREFIX = 'mcp__heroku-ops__';

const MCP_N0 = new ReadonlySet([
  'list_apps', 'ps_list', 'list_addons', 'get_addon_info', 'get_app_logs',
  'pg_info', 'pg_ps', 'pg_locks', 'pg_outliers', 'pg_backups',
  'pipelines_list', 'pipelines_info', 'pg_psql',
]);

const MCP_N1 = new ReadonlySet(['ps_restart', 'maintenance_on', 'maintenance_off']);

// Second MCP server (heroku-ops-gaps): releases, backups, health and read-only git.
const GAPS_PREFIX = 'mcp__heroku-ops-gaps__';

const GAPS_N0 = new ReadonlySet([
  'releases_list', 'backup_info', 'health_check',
  'git_fetch', 'git_log', 'git_show', 'git_ls_tree', 'git_diff',
]);

const GAPS_N1 = new ReadonlySet(['backup_capture']);

// Allowed input keys per gaps tool; any other key is rejected.
const GAPS_KEYS = Object.freeze({
  releases_list: ['app', 'limit'],
  backup_info: ['app', 'id'],
  backup_capture: ['app'],
  health_check: [],
  git_fetch: [],
  git_log: ['rev', 'range', 'format', 'n', 'paths'],
  git_show: ['rev', 'path', 'format'],
  git_ls_tree: ['rev', 'recursive', 'nameOnly', 'paths'],
  git_diff: ['from', 'to', 'format', 'paths'],
});

// Gaps tools that act on a Heroku app and therefore require a whitelisted `app`.
const GAPS_APP_TOOLS = new Set(['releases_list', 'backup_info', 'backup_capture']);

/**
 * Whitelist classification; anything unknown is N3 (fail closed).
 * @param {string} toolName
 * @returns {{level:'N0'|'N1'|'N3', tool:string|null, server:'official'|'gaps'|null}}
 */
function classifyMcpTool(toolName) {
  if (typeof toolName !== 'string') return { level: 'N3', tool: null, server: null };
  if (toolName.startsWith(GAPS_PREFIX)) {
    const tool = toolName.slice(GAPS_PREFIX.length);
    if (GAPS_N0.has(tool)) return { level: 'N0', tool, server: 'gaps' };
    if (GAPS_N1.has(tool)) return { level: 'N1', tool, server: 'gaps' };
    return { level: 'N3', tool, server: 'gaps' };
  }
  if (!toolName.startsWith(MCP_PREFIX)) return { level: 'N3', tool: null, server: null };
  const tool = toolName.slice(MCP_PREFIX.length);
  if (MCP_N0.has(tool)) return { level: 'N0', tool, server: 'official' };
  if (MCP_N1.has(tool)) return { level: 'N1', tool, server: 'official' };
  return { level: 'N3', tool, server: 'official' };
}

function checkGapsInput(tool, inp, config) {
  const allowed = Object.prototype.hasOwnProperty.call(GAPS_KEYS, tool) ? GAPS_KEYS[tool] : null;
  if (!allowed) return { ok: false, reason: `Herramienta no permitida: ${tool}.` };
  const extra = Object.keys(inp).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    return { ok: false, reason: `${tool}: parámetros no permitidos (${extra.join(', ')}).` };
  }
  if (GAPS_APP_TOOLS.has(tool)) {
    const apps = config && Array.isArray(config.apps) ? config.apps : [];
    if (typeof inp.app !== 'string' || !apps.includes(inp.app)) {
      return { ok: false, reason: 'La app indicada no está permitida (solo: ' + apps.join(', ') + ').' };
    }
  }
  return { ok: true };
}

/**
 * Validates the `app` parameter and forbidden flags. Does not validate SQL.
 * @param {string} tool  Tool name without prefix.
 * @param {Object} input
 * @param {Config} config
 * @param {'official'|'gaps'} [server]
 * @returns {{ok:boolean, reason?:string}}
 */
function checkMcpInput(tool, input, config, server = 'official') {
  const inp = input && typeof input === 'object' ? input : {};
  if (server === 'gaps') return checkGapsInput(tool, inp, config);
  const hasApp = inp.app !== undefined && inp.app !== null;
  if (hasApp || tool !== 'list_apps') {
    const apps = config && Array.isArray(config.apps) ? config.apps : [];
    if (typeof inp.app !== 'string' || !apps.includes(inp.app)) {
      return { ok: false, reason: 'La app indicada no está permitida (solo: ' + apps.join(', ') + ').' };
    }
  }
  // get_addon_info: only an attachment name (DATABASE, HEROKU_POSTGRESQL_RED, ...).
  if (tool === 'get_addon_info' && (typeof inp.addon !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(inp.addon))) {
    return { ok: false, reason: 'get_addon_info: "addon" debe ser un nombre de attachment (por ejemplo DATABASE).' };
  }
  if (tool === 'pg_outliers' && inp.reset === true) {
    return { ok: false, reason: 'pg_outliers con reset reinicia estadísticas; no está permitido.' };
  }
  return { ok: true };
}

/**
 * True only if p resolves inside one of the roots (case-insensitive, win32 semantics).
 * @param {string|undefined} p
 * @param {string[]} roots
 * @returns {boolean}
 */
function isPathAllowed(p, roots) {
  if (typeof p !== 'string' || p === '' || !Array.isArray(roots)) return false;
  const target = path.win32.resolve(p).toLowerCase();
  return roots.some((r) => {
    if (typeof r !== 'string' || r === '') return false;
    const rel = path.win32.relative(path.win32.resolve(r).toLowerCase(), target);
    return rel !== '..' && !rel.startsWith('..\\') && !path.win32.isAbsolute(rel);
  });
}

module.exports = { MCP_PREFIX, MCP_N0, MCP_N1, GAPS_PREFIX, GAPS_N0, GAPS_N1, GAPS_KEYS, classifyMcpTool, checkMcpInput, isPathAllowed };
