'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { evaluate } = require('../lib/evaluate.js');
const { SETUP_HINT } = require('../../lib/config.js');

const AGENT = 'rogue-heroku-ops:heroku-ops';
const APP = 'my-app';
const proj = path.join(os.tmpdir(), 'rho-eval-project');
const mkCfg = (over = {}) => ({
  ok: true,
  file: path.join(proj, '.claude', 'rogue-heroku-ops.json'),
  config: {
    apps: [
      { name: APP, healthUrl: 'https://my-app.herokuapp.com/health', deployBranch: 'main' },
      { name: 'my-app-staging', healthUrl: 'https://my-app-staging.herokuapp.com/health', deployBranch: 'develop' },
    ],
    n1Mode: 'ask',
    ...over,
  },
});
const okCfg = mkCfg();
const T = (t) => 'mcp__plugin_rogue-heroku-ops_heroku-ops__' + t;
const G = (t) => 'mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__' + t;
// Calls from the plugin agent unless told otherwise.
const ev = (tool_name, tool_input, config = okCfg, agent_type = AGENT) =>
  evaluate({ tool_name, tool_input, agent_type }, config, proj);

// Rule 1
for (const agent of [undefined, 'heroku-ops', 'other:heroku-ops', 'rogue-heroku-ops:heroku-ops-x', 'general-purpose']) {
  test(`plugin tool from agent_type=${agent} -> deny with agent hint`, () => {
    for (const name of [T('ps_list'), G('git_log'), G('get_config')]) {
      const d = evaluate({ tool_name: name, tool_input: { app: APP }, agent_type: agent }, okCfg, proj);
      assert.equal(d.decision, 'deny', name);
      assert.equal(d.reason, 'Use the rogue-heroku-ops:heroku-ops agent for Heroku operations.');
    }
  });
}

// Rule 2
test('Read, Grep and Glob from the main session or another agent -> no decision (null)', () => {
  for (const agent_type of [undefined, 'general-purpose', 'other:heroku-ops']) {
    for (const [tool_name, tool_input] of [
      ['Read', { file_path: '/etc/hosts' }],
      ['Grep', { pattern: 'x', path: '/' }],
      ['Glob', { pattern: '**/.env*' }],
    ]) {
      assert.equal(evaluate({ tool_name, tool_input, agent_type }, okCfg, proj), null, `${tool_name} ${agent_type}`);
    }
  }
});

// Rule 3
test('agent Read inside projectDir allowed, outside denied', () => {
  assert.equal(ev('Read', { file_path: path.join(proj, 'pom.xml') }).decision, 'allow');
  assert.equal(ev('Read', { file_path: 'src/App.java' }).decision, 'allow'); // relative: resolved in the project
  assert.equal(ev('Read', { file_path: path.join(proj, '..', 'other', 'x.txt') }).decision, 'deny');
  assert.equal(ev('Read', { file_path: path.join(os.tmpdir(), 'elsewhere', 'x.txt') }).decision, 'deny');
  assert.equal(ev('Read', { file_path: '../x.txt' }).decision, 'deny');
  assert.equal(ev('Read', {}).decision, 'deny');
  assert.equal(evaluate({ tool_name: 'Read', tool_input: { file_path: 'x' }, agent_type: AGENT }, okCfg, '').decision, 'deny');
});

test('agent Read of .env, .env.local, .netrc, *.pem and other credential files inside projectDir -> deny', () => {
  for (const name of [
    '.env', '.env.local', '.ENV', '.Env.Production', '.netrc', 'server.pem', 'KEY.PEM', 'tls.key',
    'id_rsa', 'id_rsa.pub', '.npmrc', '.pgpass', '.env.', '.env::$DATA', '.env ',
  ]) {
    for (const dir of [proj, path.join(proj, 'sub', 'dir')]) {
      const d = ev('Read', { file_path: path.join(dir, name) });
      assert.equal(d.decision, 'deny', name);
      assert.match(d.reason, /credential/);
    }
  }
  assert.equal(ev('Read', { file_path: path.join(proj, 'environment.md') }).decision, 'allow');
  assert.equal(ev('Read', { file_path: path.join(proj, 'keys.md') }).decision, 'allow');
});

test('Grep and Glob need a path inside the project', () => {
  assert.equal(ev('Grep', { pattern: 'x' }).decision, 'deny');
  assert.equal(ev('Grep', { pattern: 'x', path: proj }).decision, 'allow');
  assert.equal(ev('Glob', { pattern: '*' }).decision, 'deny');
  assert.equal(ev('Glob', { pattern: '*', path: path.join(os.tmpdir(), 'elsewhere') }).decision, 'deny');
  assert.equal(ev('Glob', { pattern: '*', path: proj }).decision, 'allow');
});

test('Glob pattern and Grep glob: absolute (either platform), ".." or braces -> deny', () => {
  for (const pattern of ['..', '**/..', 'a..b/*', '..\\x', '{a,b}/*', '**/*.{js,md}', 'x}', '/etc/*', 'C:\\Users\\*', 'C:/Users/*']) {
    assert.equal(ev('Glob', { pattern, path: proj }).decision, 'deny', pattern);
    assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: pattern }).decision, 'deny', pattern);
  }
  assert.equal(ev('Glob', { pattern: '**/*.md', path: proj }).decision, 'allow');
  assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: '*.js' }).decision, 'allow');
  // the Grep regex itself is not a path
  assert.equal(ev('Grep', { pattern: 'a{2}..b', path: proj }).decision, 'allow');
});

test('Glob and Grep aimed at credential files -> deny', () => {
  for (const pattern of ['**/.env*', '.env', '**/.env.*', '**/*.pem', '*.key', 'config/**/id_rsa*', '**/.NETRC', '**/.npmrc', '**/.pgpass', '.e[n]v']) {
    assert.equal(ev('Glob', { pattern, path: proj }).decision, 'deny', pattern);
    assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: pattern }).decision, 'deny', pattern);
  }
  assert.equal(ev('Grep', { pattern: 'x', path: path.join(proj, '.env') }).decision, 'deny');
  assert.equal(ev('Glob', { pattern: '**/*', path: proj }).decision, 'allow');
  assert.equal(ev('Glob', { pattern: 'src/**/*.java', path: proj }).decision, 'allow');
});

// Rule 5 (missing or invalid config)
test('config not ok -> every plugin tool from the agent denied with SETUP_HINT; get_config allowed', () => {
  const bad = { ok: false, problems: ['Config file not found.', SETUP_HINT], file: null };
  for (const name of [T('ps_list'), T('pg_psql'), G('git_log'), G('releases_list'), G('get_procedure'), G('health_check')]) {
    const d = ev(name, { app: APP }, bad);
    assert.equal(d.decision, 'deny', name);
    assert.ok(d.reason.includes(SETUP_HINT), d.reason);
  }
  assert.equal(ev(G('get_config'), {}, bad).decision, 'allow');
  assert.equal(ev(T('get_config'), {}, bad).decision, 'deny'); // not an official-server tool
  assert.equal(ev(T('ps_list'), { app: APP }, null).decision, 'deny');
  // the config exception does not open anything to other agents
  assert.equal(ev(G('get_config'), {}, bad, 'general-purpose').decision, 'deny');
});

// Rule 4
test('MCP N0 with a configured app -> allow', () => {
  const d = ev(T('pg_info'), { app: APP });
  assert.equal(d.decision, 'allow');
  assert.equal(d.level, 'N0');
  assert.equal(ev(T('ps_list'), { app: 'my-app-staging' }).decision, 'allow');
});

test('MCP unlisted or N3 tools -> deny', () => {
  assert.equal(ev(T('get_app_info'), { app: APP }).decision, 'deny');
  assert.equal(ev(T('new_tool'), { app: APP }).decision, 'deny');
});

test('app not configured -> deny', () => {
  assert.equal(ev(T('pg_info'), { app: 'other' }).decision, 'deny');
  assert.equal(ev(T('pg_info'), {}).decision, 'deny');
  assert.equal(ev(G('releases_list'), { app: 'other' }).decision, 'deny');
  assert.equal(ev(G('backup_capture'), { app: 'otra' }).decision, 'deny');
});

test('MCP database with "::" (other app) -> deny', () => {
  assert.equal(ev(T('pg_info'), { app: APP, database: 'other-app::DATABASE_URL' }).decision, 'deny');
  assert.equal(ev(T('pg_backups'), { app: APP, database: 'DATABASE_URL' }).decision, 'allow');
});

test('n1Mode deny -> ps_restart deny with exact operation; ask -> ask', () => {
  const a = ev(T('ps_restart'), { app: APP });
  assert.equal(a.decision, 'ask');
  assert.equal(a.level, 'N1');
  assert.match(a.reason, /restarts the dynos; no data loss/);
  assert.ok(a.reason.includes(APP));
  const d = ev(T('ps_restart'), { app: APP }, mkCfg({ n1Mode: 'deny' }));
  assert.equal(d.decision, 'deny');
  assert.equal(d.level, 'N1');
  assert.ok(d.reason.includes('ps_restart') && d.reason.includes(APP), d.reason);
  assert.match(ev(T('maintenance_on'), { app: APP }).reason, /maintenance_off/);
  assert.match(ev(T('maintenance_off'), { app: APP }).reason, /serves traffic again/);
});

test('pg_psql always rewritten to READ ONLY transaction (no sqlRewrite flag)', () => {
  const d = ev(T('pg_psql'), { app: APP, command: 'SELECT 1' });
  assert.equal(d.decision, 'allow');
  assert.equal(d.updatedInput.command, 'BEGIN TRANSACTION READ ONLY; SELECT 1; ROLLBACK;');
  assert.equal(d.updatedInput.app, APP);
  // a config carrying the removed flag does not change the behavior
  const d2 = ev(T('pg_psql'), { app: APP, command: 'SELECT 1' }, mkCfg({ sqlRewrite: false }));
  assert.equal(d2.updatedInput.command, 'BEGIN TRANSACTION READ ONLY; SELECT 1; ROLLBACK;');
});

test('pg_psql: already wrapped SQL passes without rewrite', () => {
  const d = ev(T('pg_psql'), { app: APP, command: 'BEGIN TRANSACTION READ ONLY; SELECT 1; ROLLBACK;' });
  assert.equal(d.decision, 'allow');
  assert.equal(d.updatedInput, undefined);
});

test('pg_psql: file or credential -> deny', () => {
  assert.equal(ev(T('pg_psql'), { app: APP, command: 'SELECT 1', file: 'x.sql' }).decision, 'deny');
  assert.equal(ev(T('pg_psql'), { app: APP, command: 'SELECT 1', credential: 'ro' }).decision, 'deny');
});

test('pg_psql: missing, non-string or empty command -> deny', () => {
  assert.equal(ev(T('pg_psql'), { app: APP }).decision, 'deny');
  assert.equal(ev(T('pg_psql'), { app: APP, command: 5 }).decision, 'deny');
  assert.equal(ev(T('pg_psql'), { app: APP, command: '' }).decision, 'deny');
});

test('pg_psql: write SQL -> deny', () => {
  assert.equal(ev(T('pg_psql'), { app: APP, command: 'DELETE FROM t' }).decision, 'deny');
});

test('pg_psql: non-ASCII, newline, backtick, $ and % -> deny', () => {
  for (const command of [
    'SELECT \u201Cx\u201D',
    'SELECT 1\nFROM t',
    'SELECT 1\r',
    'SELECT `x`',
    'SELECT $1',
    "SELECT 1 WHERE 'a' LIKE '%'",
  ]) {
    assert.equal(ev(T('pg_psql'), { app: APP, command }).decision, 'deny', JSON.stringify(command));
  }
});

test('MCP get_addon_info: addon must be an attachment name', () => {
  assert.equal(ev(T('get_addon_info'), { app: APP, addon: 'DATABASE' }).decision, 'allow');
  assert.equal(ev(T('get_addon_info'), { app: APP, addon: 'HEROKU_POSTGRESQL_RED' }).decision, 'allow');
  for (const addon of [undefined, 5, '', 'database', 'postgresql-curly-12345', 'other-app::DATABASE', 'DATABASE_URL x']) {
    assert.equal(ev(T('get_addon_info'), { app: APP, addon }).decision, 'deny', String(addon));
  }
});

test('gaps N0 tool -> allow N0', () => {
  const d = ev(G('git_log'), { rev: 'HEAD' });
  assert.equal(d.decision, 'allow');
  assert.equal(d.level, 'N0');
  assert.equal(ev(G('releases_list'), { app: APP, limit: 5 }).decision, 'allow');
  assert.equal(ev(G('get_config'), {}).decision, 'allow');
});

test('get_procedure name outside deploy|incident|routine -> deny', () => {
  for (const name of ['deploy', 'incident', 'routine']) assert.equal(ev(G('get_procedure'), { name }).decision, 'allow', name);
  for (const name of [undefined, '', 'Deploy', '../deploy', 'deploy.md', 'other', 5]) {
    assert.equal(ev(G('get_procedure'), { name }).decision, 'deny', String(name));
  }
  assert.equal(ev(G('get_procedure'), { name: 'deploy', extra: 1 }).decision, 'deny');
});

test('health_check without app or with unknown app -> deny', () => {
  assert.equal(ev(G('health_check'), { app: APP }).decision, 'allow');
  assert.equal(ev(G('health_check'), {}).decision, 'deny');
  assert.equal(ev(G('health_check'), { app: 'unknown' }).decision, 'deny');
  assert.equal(ev(G('health_check'), { app: 5 }).decision, 'deny');
});

test('gaps backup_capture follows n1Mode', () => {
  const a = ev(G('backup_capture'), { app: APP });
  assert.equal(a.decision, 'ask');
  assert.equal(a.level, 'N1');
  assert.ok(a.reason.includes('creates a new database backup'), a.reason);
  assert.equal(ev(G('backup_capture'), { app: APP }, mkCfg({ n1Mode: 'deny' })).decision, 'deny');
});

test('gaps unknown tool, extra keys, lookalike prefix -> deny', () => {
  assert.equal(ev(G('git_push'), {}).decision, 'deny');
  assert.equal(ev(G('git_log'), { rev: 'HEAD', extra: 1 }).decision, 'deny');
  assert.equal(ev(G('git_log'), { rev: 'HEAD', app: APP }).decision, 'deny');
  assert.equal(ev('mcp__plugin_rogue-heroku-ops_heroku-ops-gapsx__git_log', { rev: 'HEAD' }).decision, 'deny');
  assert.equal(ev('mcp__heroku-ops__ps_list', { app: APP }).decision, 'deny'); // old personal prefix
});

// Ruling 1: origin/<branch> in rev and range must be a configured deployBranch.
test('git refs: origin/<deployBranch> of any app allowed, other branches denied', () => {
  for (const [tool, input] of [
    ['git_log', { rev: 'origin/main' }],
    ['git_log', { rev: 'origin/develop' }],
    ['git_log', { range: 'origin/main..origin/develop' }],
    ['git_log', { range: 'HEAD..origin/main' }],
    ['git_log', { range: 'origin/main...HEAD', n: 5 }],
    ['git_show', { rev: 'origin/main:db/migration/V1__x.sql' }],
    ['git_show', { rev: 'origin/main~2' }],
    ['git_ls_tree', { rev: 'origin/develop', recursive: true }],
    ['git_diff', { from: 'origin/main', to: 'HEAD' }],
    ['git_log', { rev: 'HEAD' }],
    ['git_log', { rev: 'a1b2c3d' }],
  ]) {
    assert.equal(ev(G(tool), input).decision, 'allow', JSON.stringify(input));
  }
  for (const [tool, input] of [
    ['git_log', { rev: 'origin/feature-x' }],
    ['git_log', { rev: 'origin/mainx' }],
    ['git_log', { range: 'origin/main..origin/hotfix' }],
    ['git_log', { range: 'origin/hotfix..origin/main' }],
    ['git_log', { range: 'HEAD..origin/secret' }],
    ['git_log', { rev: '^origin/other' }],
    ['git_log', { rev: 'refs/remotes/origin/other' }],
    ['git_show', { rev: 'origin/other:path/file.txt' }],
    ['git_show', { rev: 'origin/other~1' }],
    ['git_ls_tree', { rev: 'origin/other' }],
    ['git_diff', { from: 'origin/main', to: 'origin/other' }],
    ['git_diff', { from: 'origin/other', to: 'HEAD' }],
  ]) {
    const d = ev(G(tool), input);
    assert.equal(d.decision, 'deny', JSON.stringify(input));
    assert.match(d.reason, /deployBranch/);
  }
});

test('git refs: a branch with slashes must match a deployBranch exactly', () => {
  const cfg = mkCfg({ apps: [{ name: APP, healthUrl: 'https://x.invalid/h', deployBranch: 'release/1.0' }] });
  assert.equal(ev(G('git_log'), { rev: 'origin/release/1.0' }, cfg).decision, 'allow');
  assert.equal(ev(G('git_log'), { range: 'origin/release/1.0..HEAD' }, cfg).decision, 'allow');
  assert.equal(ev(G('git_log'), { rev: 'origin/release' }, cfg).decision, 'deny');
  assert.equal(ev(G('git_log'), { rev: 'origin/release/2.0' }, cfg).decision, 'deny');
});

test('other tools -> deny', () => {
  assert.equal(ev('WebFetch', { url: 'https://example.com' }).decision, 'deny');
  assert.equal(ev('Write', { file_path: path.join(proj, 'x') }).decision, 'deny');
});

test('Bash and PowerShell are always denied', () => {
  for (const t of ['Bash', 'PowerShell']) {
    const d = ev(t, { command: `heroku ps -a ${APP}` });
    assert.equal(d.decision, 'deny');
    assert.ok(d.reason.includes(t));
    assert.ok(d.reason.includes('is not allowed'), d.reason);
    assert.equal(ev(t, {}).decision, 'deny');
  }
});

test('command over the cap -> deny without evaluating', () => {
  assert.equal(ev(T('pg_psql'), { app: APP, command: 'SELECT ' + 'x'.repeat(5000) }).decision, 'deny');
});

test('garbage hook input -> deny', () => {
  assert.equal(evaluate(null, okCfg, proj).decision, 'deny');
  assert.equal(evaluate({}, okCfg, proj).decision, 'deny');
  assert.equal(evaluate({ tool_name: 5 }, okCfg, proj).decision, 'deny');
});
