'use strict';
const path = require('node:path');
const { appByName } = require('../../lib/config.js');
const { isValidBranch } = require('../../mcp-gaps/lib/validate.js');

/**
 * Validated project config (see lib/config.js): apps[{name, healthUrl, deployBranch}],
 * optional migrations, n1Mode.
 * @typedef {Object} Config
 */

/**
 * @typedef {Object} Decision
 * @property {'allow'|'ask'|'deny'} decision
 * @property {'N0'|'N1'|'N3'} level
 * @property {string} reason  Message for the person running the session.
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

// The only agent allowed to use the plugin tools (exact match on the hook input agent_type).
const PLUGIN_AGENT = 'rogue-heroku-ops:heroku-ops';

const MCP_PREFIX = 'mcp__plugin_rogue-heroku-ops_heroku-ops__';

const MCP_N0 = new ReadonlySet([
  'list_apps', 'ps_list', 'list_addons', 'get_addon_info', 'get_app_logs',
  'pg_info', 'pg_ps', 'pg_locks', 'pg_outliers', 'pg_backups',
  'pipelines_list', 'pipelines_info', 'pg_psql',
]);

const MCP_N1 = new ReadonlySet(['ps_restart', 'maintenance_on', 'maintenance_off']);

// Second MCP server (heroku-ops-gaps): config, procedures, releases, backups, health and read-only git.
const GAPS_PREFIX = 'mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__';

const GAPS_N0 = new ReadonlySet([
  'get_config', 'get_procedure', 'releases_list', 'backup_info', 'health_check',
  'git_fetch', 'git_branches', 'git_log', 'git_show', 'git_ls_tree', 'git_diff',
]);

const GAPS_N1 = new ReadonlySet(['backup_capture']);

// Allowed input keys per gaps tool; any other key is rejected.
const GAPS_KEYS = Object.freeze({
  get_config: [],
  get_procedure: ['name'],
  releases_list: ['app', 'limit'],
  backup_info: ['app', 'id'],
  backup_capture: ['app'],
  health_check: ['app'],
  git_fetch: ['app'],
  git_branches: ['app'],
  git_log: ['app', 'rev', 'range', 'format', 'n', 'paths'],
  git_show: ['app', 'rev', 'path', 'format'],
  git_ls_tree: ['app', 'rev', 'recursive', 'nameOnly', 'paths'],
  git_diff: ['app', 'from', 'to', 'format', 'paths'],
});

// Gaps tools that act on a Heroku app and therefore require a configured `app`.
const GAPS_APP_TOOLS = new Set([
  'releases_list', 'backup_info', 'backup_capture', 'health_check',
  'git_fetch', 'git_branches', 'git_log', 'git_show', 'git_ls_tree', 'git_diff',
]);

const PROCEDURES = ['deploy', 'incident', 'routine'];

// Git ref parameters that may name a remote branch: every `origin/<x>` inside them must be a valid branch name.
const GAPS_REF_TOOLS = new Set(['git_log', 'git_show', 'git_ls_tree', 'git_diff']);
const GAPS_REF_KEYS = ['rev', 'range', 'from', 'to'];
// origin/<branch>, up to a revision suffix (~ ^ : @ {), a range operator (..) or whitespace.
const ORIGIN_REF_RE = /origin\/((?:(?!\.\.)[^~^:@{\s])+)/g;

const appNames = (config) => (config && Array.isArray(config.apps) ? config.apps.map((a) => a.name) : []);

function checkApp(app, config) {
  if (typeof app === 'string' && config && Array.isArray(config.apps) && appByName(config, app)) {
    return { ok: true };
  }
  return { ok: false, reason: `The app is not configured (configured: ${appNames(config).join(', ')}).` };
}

function checkOriginRefs(tool, inp) {
  for (const key of GAPS_REF_KEYS) {
    const v = inp[key];
    if (typeof v !== 'string') continue;
    for (const m of v.matchAll(ORIGIN_REF_RE)) {
      if (!isValidBranch(m[1])) {
        return { ok: false, reason: `${tool}: "${key}" references origin/${m[1]}, which is not a valid remote branch name.` };
      }
    }
  }
  return { ok: true };
}

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
  if (!allowed) return { ok: false, reason: `Tool not allowed: ${tool}.` };
  const extra = Object.keys(inp).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    return { ok: false, reason: `${tool}: parameters not allowed (${extra.join(', ')}).` };
  }
  if (GAPS_APP_TOOLS.has(tool)) {
    const chk = checkApp(inp.app, config);
    if (!chk.ok) return chk;
  }
  if (tool === 'get_procedure' && !PROCEDURES.includes(inp.name)) {
    return { ok: false, reason: `get_procedure: "name" must be one of ${PROCEDURES.join(', ')}.` };
  }
  if (GAPS_REF_TOOLS.has(tool)) return checkOriginRefs(tool, inp);
  return { ok: true };
}

/**
 * Validates the `app` parameter, forbidden flags and git refs. Does not validate SQL.
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
    const chk = checkApp(inp.app, config);
    if (!chk.ok) return chk;
  }
  // get_addon_info: only an attachment name (DATABASE, HEROKU_POSTGRESQL_RED, ...).
  if (tool === 'get_addon_info' && (typeof inp.addon !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(inp.addon))) {
    return { ok: false, reason: 'get_addon_info: "addon" must be an attachment name (for example DATABASE).' };
  }
  if (tool === 'pg_outliers' && inp.reset === true) {
    return { ok: false, reason: 'pg_outliers with reset clears statistics; not allowed.' };
  }
  if (tool === 'pg_outliers' && (inp.num !== undefined || inp.truncate !== undefined)) {
    return { ok: false, reason: 'pg_outliers: call it with "app" only; "num" and "truncate" make the Heroku CLI fail. If it still fails, use pg_psql with: SELECT query, calls, total_exec_time FROM pg_stat_statements WHERE userid = (SELECT oid FROM pg_roles WHERE rolname = current_user) ORDER BY total_exec_time DESC LIMIT 3' };
  }
  return { ok: true };
}

const pathApi = (flavor) => (flavor === 'win32' ? path.win32 : path.posix);
const defaultFlavor = () => (process.platform === 'win32' ? 'win32' : 'posix');

/**
 * True only if p resolves inside one of the roots. Windows compares without case.
 * A relative p is resolved against opts.base (default: the first root).
 * @param {string|undefined} p
 * @param {string[]} roots
 * @param {{flavor?: 'win32'|'posix', base?: string}} [opts]
 * @returns {boolean}
 */
function isPathAllowed(p, roots, opts = {}) {
  if (typeof p !== 'string' || p === '' || !Array.isArray(roots)) return false;
  const flavor = opts.flavor || defaultFlavor();
  const api = pathApi(flavor);
  const norm = (x) => (flavor === 'win32' ? x.toLowerCase() : x);
  const base = typeof opts.base === 'string' && opts.base !== '' ? opts.base : roots[0];
  if (typeof base !== 'string' || base === '') return false;
  const target = norm(api.resolve(base, p));
  return roots.some((r) => {
    if (typeof r !== 'string' || r === '') return false;
    const rel = api.relative(norm(api.resolve(r)), target);
    return rel !== '..' && !rel.startsWith('..' + api.sep) && !api.isAbsolute(rel);
  });
}

/**
 * The longest root that contains p (same resolution as isPathAllowed), or null.
 * @param {string|undefined} p
 * @param {string[]} roots
 * @param {{flavor?: 'win32'|'posix', base?: string}} [opts]
 * @returns {string|null}
 */
function containingRoot(p, roots, opts = {}) {
  if (typeof p !== 'string' || p === '' || !Array.isArray(roots)) return null;
  const flavor = opts.flavor || defaultFlavor();
  const api = pathApi(flavor);
  const norm = (x) => (flavor === 'win32' ? x.toLowerCase() : x);
  const base = typeof opts.base === 'string' && opts.base !== '' ? opts.base : roots[0];
  if (typeof base !== 'string' || base === '') return null;
  const target = norm(api.resolve(base, p));
  let best = null;
  let bestLen = -1;
  for (const r of roots) {
    if (typeof r !== 'string' || r === '') continue;
    const resolved = norm(api.resolve(r));
    const rel = api.relative(resolved, target);
    if (rel === '..' || rel.startsWith('..' + api.sep) || api.isAbsolute(rel)) continue;
    if (resolved.length > bestLen) {
      best = r;
      bestLen = resolved.length;
    }
  }
  return best;
}

// Credential file names, compared lowercase on every platform.
const CREDENTIAL_NAME_RES = [
  /^\.env/, /^\.netrc$/, /^_netrc$/, /\.pem$/, /\.key$/, /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^\.npmrc$/, /^\.pgpass$/, /^\.git-credentials$/, /^\.credentials\.json$/,
];
const CREDENTIAL_SAMPLES = [
  '.env', '.env.local', '.env.production', '.netrc', '_netrc', 'a.pem', 'server.key',
  'id_rsa', 'id_rsa.pub', 'id_ed25519', '.npmrc', '.pgpass', '.git-credentials', '.credentials.json',
];

// Credential file extensions: the single list used by Read, Grep (file, literal glob, "*.ext") and Glob.
const GREP_BLOCKED_EXTS = new Set([
  'pem', 'key', 'env', 'p12', 'pfx', 'jks', 'tfvars', 'pgpass', 'netrc', 'keystore', 'asc', 'gpg',
]);

// NTFS aliases: alternate data stream suffix (":$DATA"), trailing dots and spaces.
const normalizeName = (n) => n.toLowerCase().replace(/:.*$/, '').replace(/[. ]+$/, '');
// True if any dot-separated part after the first (prod.env, a.tfvars.json, .keystore) is a credential extension.
const hasBlockedExt = (n) => normalizeName(n).split('.').slice(1).some((e) => GREP_BLOCKED_EXTS.has(e));
const isCredentialName = (n) =>
  hasBlockedExt(n) || CREDENTIAL_NAME_RES.some((re) => re.test(normalizeName(n)));
const SHORT_NAME_RE = /~\d/;
const SHORT_NAME_PATTERN_RE = /~[\d*?[]/;
const segmentsOf = (p) => p.split(/[\\/]/).filter((x) => x !== '' && x !== '.');

/** True if the last segment of a file or directory path is a credential file name. */
function isCredentialPath(p) {
  if (typeof p !== 'string') return false;
  const segs = segmentsOf(p);
  // NTFS 8.3 short names (ENV~1, ENV~1.LOC) alias credential files: any "~digit" segment is denied, on every platform.
  if (segs.some((x) => SHORT_NAME_RE.test(x))) return true;
  return segs.length > 0 && isCredentialName(segs[segs.length - 1]);
}

/** True if any segment is ".git" (any case): git internals (.git/config) can hold a token in the remote URL. */
function hasGitSegment(p) {
  return typeof p === 'string' && segmentsOf(p).some((x) => x.toLowerCase() === '.git');
}

/**
 * True if a Glob pattern or Grep glob can target credential files: some segment, read as a glob,
 * matches a credential name. Segments made only of wildcards ("*", "**") are not a target.
 */
function patternTargetsCredentials(pattern) {
  if (typeof pattern !== 'string') return false;
  if (hasGitSegment(pattern)) return true;
  for (const seg of segmentsOf(pattern)) {
    if (/^[*?]+$/.test(seg)) continue;
    if (SHORT_NAME_PATTERN_RE.test(seg)) return true;
    if (isCredentialName(seg)) return true;
    try {
      const body = seg.toLowerCase().replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      const re = new RegExp('^' + body + '$');
      if (CREDENTIAL_SAMPLES.some((n) => re.test(n))) return true;
    } catch (_e) {
      return true; // unparsable pattern: fail closed
    }
  }
  return false;
}

const GREP_DIR_SEG_RE = /^[A-Za-z0-9._-]+$/;
const GREP_EXT_RE = /^\*\.([A-Za-z0-9]+)(?:\.([A-Za-z0-9]+))?$/;
const GREP_LITERAL_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Allow-list for the `glob` of an agent Grep over a directory. Segments are separated by "/";
 * every segment before the last is "**" or a plain literal (no "..", no leading "."); the last is
 * "*.<ext>" (ext not a credential extension) or a plain non-credential file name (no credential extension
 * in any part). Anything else is false.
 */
function isSimpleGrepGlob(glob) {
  if (typeof glob !== 'string' || glob === '') return false;
  const segs = glob.split('/');
  const last = segs.pop();
  for (const seg of segs) {
    if (seg === '**') continue;
    if (!GREP_DIR_SEG_RE.test(seg) || seg.startsWith('.')) return false;
  }
  const m = GREP_EXT_RE.exec(last);
  if (m) return ![m[1], m[2]].some((e) => e !== undefined && GREP_BLOCKED_EXTS.has(e.toLowerCase()));
  return GREP_LITERAL_RE.test(last) && !hasBlockedExt(last) && !isCredentialName(last);
}

module.exports = {
  isSimpleGrepGlob,
  PLUGIN_AGENT, MCP_PREFIX, MCP_N0, MCP_N1, GAPS_PREFIX, GAPS_N0, GAPS_N1, GAPS_KEYS,
  classifyMcpTool, checkMcpInput, isPathAllowed, containingRoot, isCredentialPath, hasGitSegment, patternTargetsCredentials,
};
