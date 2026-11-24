'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { evaluate } = require('../lib/evaluate.js');
const { SETUP_HINT } = require('../../lib/config.js');

const AGENT = 'rogue-heroku-ops:heroku-ops';
const APP = 'my-app';
const proj = path.join(os.tmpdir(), 'rho-eval-project');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
fs.writeFileSync(path.join(proj, 'pom.xml'), '<project/>');
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
const repo = path.join(os.tmpdir(), 'rho-eval-repo');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src', 'V1__a.sql'), 'SELECT 1;');
fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1');
const withRepo = () =>
  mkCfg({
    apps: [
      { name: APP, healthUrl: 'https://my-app.herokuapp.com/health', deployBranch: 'main', repoPath: repo },
      { name: 'my-app-staging', healthUrl: 'https://my-app-staging.herokuapp.com/health', deployBranch: 'develop' },
    ],
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

test('agent Read, Grep on a file and Grep literal glob: credential extensions anywhere in the name -> deny', () => {
  const names = ['prod.env', 'a.tfvars', 'a.p12', 'x.gpg', 'keystore.jks', 'a.env.', 'A.ENV', 'a.tfvars.json',
    'a.env.bak', '.keystore', 'debug.keystore'];
  for (const name of names) fs.writeFileSync(path.join(proj, 'src', name.replace(/[. ]+$/, '')), 'SECRET=1');
  for (const name of names) {
    const r = ev('Read', { file_path: path.join(proj, 'src', name) });
    assert.equal(r.decision, 'deny', 'Read ' + name);
    assert.match(r.reason, /credential/);
    const f = ev('Grep', { pattern: 'x', path: path.join(proj, 'src', name) });
    assert.equal(f.decision, 'deny', 'Grep file ' + name);
    assert.match(f.reason, /credential/);
    assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: name }).decision, 'deny', 'Grep glob ' + name);
    assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: '**/' + name }).decision, 'deny', 'Grep glob **/' + name);
  }
  for (const glob of ['pom.xml', 'schema.sql', 'README.md']) {
    assert.equal(ev('Grep', { pattern: 'x', path: proj, glob }).decision, 'allow', glob);
  }
  for (const name of ['environment.md', 'keys.md', 'key.txt', 'a~b.txt']) {
    assert.equal(ev('Read', { file_path: path.join(proj, name) }).decision, 'allow', name);
  }
  assert.equal(ev('Glob', { pattern: '**/*', path: proj }).decision, 'allow');
});

test('Grep and Glob need a path inside the project', () => {
  assert.equal(ev('Grep', { pattern: 'x' }).decision, 'deny');
  assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: '*.js' }).decision, 'allow');
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
  assert.equal(ev('Grep', { pattern: 'a{2}..b', path: proj, glob: '*.js' }).decision, 'allow');
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

test('NTFS 8.3 short names (~digit) are denied in Read, Grep and Glob', () => {
  for (const name of ['ENV~1', 'ENV~1.LOC', 'NETRC~1', 'env~2.pro']) {
    const d = ev('Read', { file_path: path.join(proj, name) });
    assert.equal(d.decision, 'deny', name);
    assert.match(d.reason, /credential/);
    assert.equal(ev('Read', { file_path: path.join(proj, name, 'x.txt') }).decision, 'deny', name);
    assert.equal(ev('Grep', { pattern: 'x', path: path.join(proj, name) }).decision, 'deny', name);
    assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: name }).decision, 'deny', name);
    assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: '**/' + name }).decision, 'deny', name);
    assert.equal(ev('Glob', { pattern: '**/' + name, path: proj }).decision, 'deny', name);
  }
  assert.equal(ev('Read', { file_path: path.join(proj, 'a~b.txt') }).decision, 'allow');
});

test('agent Grep over a directory needs a literal, non-credential glob', () => {
  for (const input of [
    { pattern: 'PASSWORD|KEY', path: proj, output_mode: 'content' },
    { pattern: 'x', path: proj, glob: '*' },
    { pattern: 'x', path: proj, glob: '**/*' },
    { pattern: 'x', path: proj, type: 'js' },
    { pattern: 'x', path: path.join(proj, 'src') },
    { pattern: 'x', path: path.join(proj, 'missing-dir'), glob: '*.js' },
  ]) {
    assert.equal(ev('Grep', input).decision, 'deny', JSON.stringify(input));
  }
  const d = ev('Grep', { pattern: 'x', path: proj });
  assert.equal(d.reason, 'Grep over a directory needs a simple glob such as **/*.js or src/*.sql.');
  assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: '**/*.js' }).decision, 'allow');
  assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: 'src\\*' }).decision, 'deny');
  assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: 'src\\*.js' }).decision, 'deny');
  assert.equal(ev('Grep', { pattern: 'x', path: path.join(proj, 'src'), glob: '*.java' }).decision, 'allow');
  // a file path needs no glob
  assert.equal(ev('Grep', { pattern: 'x', path: path.join(proj, 'pom.xml') }).decision, 'allow');
});

test('agent Grep over a directory: allow-list grammar for glob', () => {
  const g = (glob, p = proj) => ev('Grep', { pattern: 'x', path: p, glob }).decision;
  for (const glob of ['**/*.sql', '*.sql', 'db/migration/*.sql', '**/*.java', 'pom.xml', '**/*.d.ts', 'src/**/*.js']) {
    assert.equal(g(glob), 'allow', glob);
  }
  for (const glob of ['!*.js', '!x', '*.js .env', '*.js,.env', '.e[n]v.dev*', '[.]env.dev*', '**/.env*', '*.pem',
    '*.env', '.env', 'id_rsa', '*', '**/*', '*.*', '{a,b}.js', 'src/../x/*.js', '*.PEM', '*.tar.key', '*.js?', '~1/*.js',
    '.git/*.js', 'src\\*.js', '*.js\n.env', '**/*.', '']) {
    assert.equal(g(glob), 'deny', JSON.stringify(glob));
  }
  assert.equal(ev('Grep', { pattern: 'x', path: proj, glob: '!*.js' }).reason,
    'Grep over a directory needs a simple glob such as **/*.js or src/*.sql.');
});

test('Glob tool keeps its own policy: **/*.sql and ** /* allowed', () => {
  assert.equal(ev('Glob', { pattern: '**/*.sql', path: proj }).decision, 'allow');
  assert.equal(ev('Glob', { pattern: '**/*', path: proj }).decision, 'allow');
});

test('project prefix with ~digit does not count (only the relative part)', () => {
  const p = path.join(os.tmpdir(), 'RUNNER~1', 'rho-proj');
  fs.mkdirSync(path.join(p, 'src'), { recursive: true });
  const e = (name, input) => evaluate({ tool_name: name, tool_input: input, agent_type: AGENT }, okCfg, p);
  assert.equal(e('Read', { file_path: path.join(p, 'src', 'a.txt') }).decision, 'allow');
  assert.equal(e('Read', { file_path: path.join('src', 'a.txt') }).decision, 'allow');
  assert.equal(e('Grep', { pattern: 'x', path: p, glob: '**/*.js' }).decision, 'allow');
  assert.equal(e('Glob', { pattern: '**/*.js', path: p }).decision, 'allow');
  assert.equal(e('Read', { file_path: path.join(p, 'ENV~1') }).decision, 'deny');
  assert.equal(e('Read', { file_path: path.join(p, 'src', '.env') }).decision, 'deny');
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
  const d = ev(G('git_log'), { app: APP, rev: 'HEAD' });
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
  assert.equal(ev(G('git_log'), { app: APP, rev: 'HEAD', extra: 1 }).decision, 'deny');
  assert.equal(ev('mcp__plugin_rogue-heroku-ops_heroku-ops-gapsx__git_log', { rev: 'HEAD' }).decision, 'deny');
  assert.equal(ev('mcp__heroku-ops__ps_list', { app: APP }).decision, 'deny'); // old personal prefix
});

test('git tools require a configured app', () => {
  assert.equal(ev(G('git_log'), { rev: 'origin/main' }).decision, 'deny');
  assert.equal(ev(G('git_log'), { app: 'nope', rev: 'origin/main' }).decision, 'deny');
  assert.equal(ev(G('git_log'), { app: APP, rev: 'origin/main' }).decision, 'allow');
  assert.equal(ev(G('git_fetch'), {}).decision, 'deny');
  assert.equal(ev(G('git_fetch'), { app: APP }).decision, 'allow');
  for (const tool of ['git_show', 'git_ls_tree', 'git_diff']) assert.equal(ev(G(tool), { rev: 'HEAD' }).decision, 'deny', tool);
});

test('git_branches is N0 and requires app', () => {
  assert.equal(ev(G('git_branches'), { app: APP }).decision, 'allow');
  assert.equal(ev(G('git_branches'), {}).decision, 'deny');
});

test('any valid remote branch allowed in refs', () => {
  for (const [tool, input] of [
    ['git_log', { app: APP, rev: 'origin/feature/x' }],
    ['git_log', { app: APP, range: 'origin/release/1.4..HEAD' }],
    ['git_log', { app: APP, range: 'origin/main..origin/develop' }],
    ['git_show', { app: APP, rev: 'origin/main:db/migration/V1__x.sql' }],
    ['git_show', { app: APP, rev: 'origin/hotfix~2' }],
    ['git_ls_tree', { app: APP, rev: 'origin/develop', recursive: true }],
    ['git_diff', { app: APP, from: 'origin/main', to: 'origin/feature/y' }],
    ['git_log', { app: APP, rev: 'HEAD' }],
    ['git_log', { app: APP, rev: 'a1b2c3d' }],
  ]) {
    assert.equal(ev(G(tool), input).decision, 'allow', JSON.stringify(input));
  }
  for (const [tool, input] of [
    ['git_log', { app: APP, rev: 'origin/HEAD' }],
    ['git_log', { app: APP, rev: 'origin/-x' }],
    ['git_log', { app: APP, rev: 'origin/.x' }],
    ['git_log', { app: APP, rev: 'origin/x.' }],
    ['git_log', { app: APP, range: 'HEAD..origin/-x' }],
    ['git_show', { app: APP, rev: 'origin/-x:path/file.txt' }],
    ['git_diff', { app: APP, from: 'origin/main', to: 'origin/HEAD' }],
  ]) {
    const d = ev(G(tool), input);
    assert.equal(d.decision, 'deny', JSON.stringify(input));
    assert.match(d.reason, /valid remote branch name/);
  }
});

// Rule 3 with configured repositories
const repoCfg = withRepo();
const rv = (tool, input, cfg = repoCfg) => ev(tool, input, cfg);

test('Read absolute path inside repoPath -> allow', () => {
  assert.equal(rv('Read', { file_path: path.join(repo, 'src', 'V1__a.sql') }).decision, 'allow');
});

test('Read inside repoPath with other case and forward slashes -> allow (win32)', { skip: process.platform !== 'win32' }, () => {
  const odd = path.join(repo, 'src', 'V1__a.sql').toUpperCase().replace(/\\/g, '/');
  assert.equal(rv('Read', { file_path: odd }).decision, 'allow');
});

test('Read outside project and repoPath -> deny', () => {
  assert.equal(rv('Read', { file_path: path.join(os.tmpdir(), 'rho-elsewhere', 'x.sql') }).decision, 'deny');
  assert.equal(rv('Read', { file_path: path.join(repo + '-x', 'a.sql') }).decision, 'deny');
});

test('Read relative path resolves against project', () => {
  assert.equal(rv('Read', { file_path: '../rho-eval-repo/src/V1__a.sql' }).decision, 'allow');
  assert.equal(rv('Read', { file_path: '../otro/x.sql' }).decision, 'deny');
});

test('credentials inside repoPath -> deny', () => {
  assert.equal(rv('Read', { file_path: path.join(repo, '.env') }).decision, 'deny');
  assert.equal(rv('Grep', { pattern: 'x', path: repo, glob: '**/.env*' }).decision, 'deny');
  assert.equal(rv('Glob', { path: repo, pattern: '**/*.pem' }).decision, 'deny');
});

test('.git internals inside repoPath and the project -> deny (the remote URL may hold a token)', () => {
  const r = (tool, input) => rv(tool, input);
  assert.equal(r('Read', { file_path: path.join(repo, '.git', 'config') }).decision, 'deny');
  assert.match(r('Read', { file_path: path.join(repo, '.git', 'config') }).reason, /\.git/);
  assert.equal(r('Read', { file_path: path.join(proj, '.git', 'config') }).decision, 'deny');
  assert.equal(r('Read', { file_path: path.join(repo, '.GIT', 'config') }).decision, 'deny');
  assert.equal(r('Glob', { path: repo, pattern: '.git/**' }).decision, 'deny');
  assert.equal(r('Glob', { path: repo, pattern: '**/.git/config' }).decision, 'deny');
  assert.equal(r('Grep', { pattern: 'url', path: repo, glob: '**/.git/**' }).decision, 'deny');
  assert.equal(r('Grep', { pattern: 'url', path: path.join(repo, '.git'), glob: '**/*.js' }).decision, 'deny');
  assert.equal(r('Read', { file_path: path.join(repo, 'src', 'V1__a.sql') }).decision, 'allow');
  assert.equal(r('Glob', { path: repo, pattern: '**/*.sql' }).decision, 'allow');
});

test('Grep inside repoPath with a simple glob -> allow', () => {
  assert.equal(rv('Grep', { pattern: 'SELECT', path: repo, glob: '**/*.sql' }).decision, 'allow');
});

test('invalid config -> only project root', () => {
  const bad = { ok: false, problems: ['x'], file: null };
  assert.equal(ev('Read', { file_path: path.join(repo, 'src', 'V1__a.sql') }, bad).decision, 'deny');
  assert.equal(ev('Read', { file_path: path.join(proj, 'pom.xml') }, bad).decision, 'allow');
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

test('pg_outliers with truncate from the plugin agent -> deny with the "app" only reason', () => {
  const d = ev(T('pg_outliers'), { app: APP, truncate: true });
  assert.equal(d.decision, 'deny');
  assert.ok(d.reason.includes('"app" only'), d.reason);
});
