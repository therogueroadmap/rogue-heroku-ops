'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/policy');

const cfg = {
  apps: [
    { name: 'my-app', healthUrl: 'https://example.invalid/health', deployBranch: 'main' },
    { name: 'my-app-staging', healthUrl: 'https://example.invalid/health', deployBranch: 'develop' },
  ],
  n1Mode: 'ask',
};
const APP = 'my-app';
const T = 'mcp__plugin_rogue-heroku-ops_heroku-ops__';
const G = 'mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__';

test('constants', () => {
  assert.equal(policy.PLUGIN_AGENT, 'rogue-heroku-ops:heroku-ops');
  assert.equal(policy.MCP_PREFIX, T);
  assert.equal(policy.GAPS_PREFIX, G);
});

test('classifyMcpTool', () => {
  const c = policy.classifyMcpTool;
  assert.deepEqual(c(T + 'pg_info'), { level: 'N0', tool: 'pg_info', server: 'official' });
  assert.deepEqual(c(T + 'pg_psql'), { level: 'N0', tool: 'pg_psql', server: 'official' });
  assert.deepEqual(c(T + 'ps_restart'), { level: 'N1', tool: 'ps_restart', server: 'official' });
  assert.equal(c(T + 'maintenance_on').level, 'N1');
  assert.equal(c(T + 'maintenance_off').level, 'N1');
  for (const t of ['get_app_info', 'deploy_to_heroku', 'made_up_tool', 'get_config']) {
    assert.deepEqual(c(T + t), { level: 'N3', tool: t, server: 'official' });
  }
  assert.deepEqual(c('mcp__heroku-ops__pg_info'), { level: 'N3', tool: null, server: null });
  assert.deepEqual(c('mcp__heroku__pg_info'), { level: 'N3', tool: null, server: null });
  assert.deepEqual(c(undefined), { level: 'N3', tool: null, server: null });
  assert.deepEqual(c('Bash'), { level: 'N3', tool: null, server: null });
});

test('sets contain the exact tools and cannot be mutated', () => {
  assert.equal(policy.MCP_N0.size, 13);
  assert.equal(policy.MCP_N1.size, 3);
  assert.throws(() => policy.MCP_N0.add('deploy_to_heroku'), TypeError);
  assert.throws(() => policy.MCP_N1.delete('ps_restart'), TypeError);
  assert.equal(policy.MCP_N0.has('deploy_to_heroku'), false);
});

test('checkMcpInput', () => {
  const k = policy.checkMcpInput;
  assert.equal(k('ps_list', { app: APP }, cfg).ok, true);
  assert.equal(k('ps_list', { app: 'my-app-staging' }, cfg).ok, true);
  assert.equal(k('ps_list', { app: 'other-app' }, cfg).ok, false);
  assert.equal(k('ps_list', {}, cfg).ok, false);
  assert.equal(k('ps_list', undefined, cfg).ok, false);
  assert.equal(k('ps_list', { app: ['x'] }, cfg).ok, false);
  assert.equal(k('list_apps', {}, cfg).ok, true);
  assert.equal(k('list_apps', { app: 'other-app' }, cfg).ok, false);
  assert.equal(k('pg_outliers', { app: APP, reset: true }, cfg).ok, false);
  assert.equal(k('pg_outliers', { app: APP, reset: false }, cfg).ok, true);
  assert.equal(k('pg_outliers', { app: APP }, cfg).ok, true);
  const numRes = k('pg_outliers', { app: APP, num: 5 }, cfg);
  assert.equal(numRes.ok, false);
  assert.ok(numRes.reason.includes('"app" only'));
  assert.equal(k('pg_outliers', { app: APP, truncate: true }, cfg).ok, false);
  assert.equal(k('pg_outliers', { app: APP, truncate: false }, cfg).ok, false);
  assert.equal(typeof k('ps_list', {}, cfg).reason, 'string');
  assert.equal(k('get_addon_info', { app: APP, addon: 'DATABASE' }, cfg).ok, true);
  assert.equal(k('get_addon_info', { app: APP, addon: 'HEROKU_POSTGRESQL_RED' }, cfg).ok, true);
  assert.equal(k('get_addon_info', { app: APP }, cfg).ok, false);
  assert.equal(k('get_addon_info', { app: APP, addon: 'postgresql-curly-12345' }, cfg).ok, false);
  assert.equal(k('get_addon_info', { app: APP, addon: '1DB' }, cfg).ok, false);
});

test('classifyMcpTool: heroku-ops-gaps server', () => {
  const c = policy.classifyMcpTool;
  assert.deepEqual(c(G + 'releases_list'), { level: 'N0', tool: 'releases_list', server: 'gaps' });
  assert.equal(c(G + 'get_config').level, 'N0');
  assert.equal(c(G + 'get_procedure').level, 'N0');
  assert.equal(c(G + 'backup_capture').level, 'N1');
  assert.equal(c(G + 'git_push').level, 'N3');
  assert.equal(c(T + 'ps_list').server, 'official');
  assert.equal(c('mcp__plugin_rogue-heroku-ops_heroku-ops-gapsx__releases_list').level, 'N3');
  assert.equal(c('Bash').server, null);
  assert.equal(policy.GAPS_N0.size, 11);
  assert.equal(policy.GAPS_N1.size, 1);
  assert.throws(() => policy.GAPS_N0.add('git_push'), TypeError);
  assert.deepEqual(policy.GAPS_KEYS.get_config, []);
  assert.deepEqual(policy.GAPS_KEYS.get_procedure, ['name']);
  assert.deepEqual(policy.GAPS_KEYS.health_check, ['app']);
  assert.deepEqual(policy.GAPS_KEYS.git_fetch, ['app']);
  for (const t of ['git_log', 'git_show', 'git_ls_tree', 'git_diff']) assert.ok(policy.GAPS_KEYS[t].includes('app'), t);
});

test('checkMcpInput: heroku-ops-gaps server', () => {
  const k = policy.checkMcpInput;
  assert.equal(k('releases_list', { app: APP, limit: 5 }, cfg, 'gaps').ok, true);
  assert.equal(k('releases_list', { app: 'otra' }, cfg, 'gaps').ok, false);
  assert.equal(k('releases_list', {}, cfg, 'gaps').ok, false);
  assert.equal(k('git_log', { app: APP, rev: 'HEAD', extra: 1 }, cfg, 'gaps').ok, false);
  assert.equal(k('git_log', { rev: 'HEAD' }, cfg, 'gaps').ok, false); // git needs a configured app
  assert.equal(k('git_log', { app: 'nope', rev: 'HEAD' }, cfg, 'gaps').ok, false);
  assert.equal(k('git_log', { app: APP, rev: 'HEAD' }, cfg, 'gaps').ok, true);
  assert.equal(k('git_fetch', {}, cfg, 'gaps').ok, false);
  assert.equal(k('git_fetch', { app: APP }, cfg, 'gaps').ok, true);
  assert.equal(k('health_check', { app: APP }, cfg, 'gaps').ok, true);
  assert.equal(k('health_check', {}, cfg, 'gaps').ok, false);
  assert.equal(k('get_config', {}, cfg, 'gaps').ok, true);
  assert.equal(k('get_config', { app: APP }, cfg, 'gaps').ok, false);
  assert.equal(k('get_procedure', { name: 'deploy' }, cfg, 'gaps').ok, true);
  assert.equal(k('get_procedure', { name: 'nope' }, cfg, 'gaps').ok, false);
  assert.equal(k('backup_capture', { app: APP }, cfg, 'gaps').ok, true);
  assert.equal(k('backup_info', { app: APP, id: 'b001' }, cfg, 'gaps').ok, true);
});

test('checkMcpInput: origin/<x> in rev, range, from and to must be a valid branch name', () => {
  const k = (tool, input) => policy.checkMcpInput(tool, { app: APP, ...input }, cfg, 'gaps').ok;
  assert.equal(k('git_log', { rev: 'origin/main' }), true);
  assert.equal(k('git_log', { rev: 'origin/feature/x' }), true);
  assert.equal(k('git_log', { range: 'origin/main..origin/develop' }), true);
  assert.equal(k('git_log', { range: 'origin/release/1.4..HEAD' }), true);
  assert.equal(k('git_log', { rev: 'origin/HEAD' }), false);
  assert.equal(k('git_log', { rev: 'origin/-x' }), false);
  assert.equal(k('git_log', { rev: 'origin/.x' }), false);
  assert.equal(k('git_log', { rev: 'origin/x.' }), false);
  assert.equal(k('git_log', { range: 'origin/main..origin/-x' }), false);
  assert.equal(k('git_show', { rev: 'origin/-x:f.txt' }), false);
  assert.equal(k('git_ls_tree', { rev: 'origin/-x' }), false);
  assert.equal(k('git_diff', { from: 'origin/main', to: 'origin/-x' }), false);
  assert.equal(k('git_log', { rev: 5 }), true); // non-strings are the server's concern
});

test('containingRoot picks the most specific root', () => {
  const roots = ['/p', '/p/sub/repo'];
  assert.equal(policy.containingRoot('/p/sub/repo/a.sql', roots, { flavor: 'posix' }), '/p/sub/repo');
  assert.equal(policy.containingRoot('/p/other/a.sql', roots, { flavor: 'posix' }), '/p');
  assert.equal(policy.containingRoot('src/a.sql', roots, { flavor: 'posix' }), '/p'); // relative: base defaults to roots[0]
});

test('containingRoot null outside roots', () => {
  assert.equal(policy.containingRoot('/elsewhere/a.sql', ['/p', '/p/sub/repo'], { flavor: 'posix' }), null);
  assert.equal(policy.containingRoot('/p/../x', ['/p'], { flavor: 'posix' }), null);
  assert.equal(policy.containingRoot(undefined, ['/p'], { flavor: 'posix' }), null);
  assert.equal(policy.containingRoot('/p/a', 'nope', { flavor: 'posix' }), null);
});

test('containingRoot win32 is case-insensitive and picks the longest root with mixed separators', () => {
  const roots = ['C:\\Users\\dev\\project', 'c:/users/dev/project/Sub/Repo'];
  assert.equal(policy.containingRoot('C:\\USERS\\dev\\PROJECT\\sub\\repo\\A.sql', roots, { flavor: 'win32' }), 'c:/users/dev/project/Sub/Repo');
  assert.equal(policy.containingRoot('c:/users/dev/project/x.sql', roots, { flavor: 'win32' }), 'C:\\Users\\dev\\project');
  assert.equal(policy.containingRoot('D:\\users\\dev\\project\\x.sql', roots, { flavor: 'win32' }), null);
});

test('isPathAllowed: win32 semantics', () => {
  const ROOT = 'C:\\Users\\dev\\project';
  const ok = (p) => policy.isPathAllowed(p, [ROOT + '\\'], { flavor: 'win32' });
  assert.equal(ok(ROOT + '\\procedures\\deploy.md'), true);
  assert.equal(ok('c:/users/dev/project/src/a.js'), true);
  assert.equal(ok(ROOT), true);
  assert.equal(ok('src\\a.js'), true); // relative: resolved against the first root
  assert.equal(ok('C:\\Users\\dev\\.netrc'), false);
  assert.equal(ok(ROOT + '\\..\\.credentials.json'), false);
  assert.equal(ok('C:\\Users\\dev\\project-evil\\x'), false);
  assert.equal(ok(undefined), false);
  assert.equal(ok(''), false);
  assert.equal(policy.isPathAllowed(ROOT + '\\a', [], { flavor: 'win32' }), false);
  assert.equal(policy.isPathAllowed('E:\\x', [ROOT], { flavor: 'win32' }), false);
});

test('isPathAllowed: posix semantics (case-sensitive)', () => {
  const ROOT = '/home/dev/project';
  const ok = (p) => policy.isPathAllowed(p, [ROOT + '/'], { flavor: 'posix' });
  assert.equal(ok(ROOT + '/src/a.js'), true);
  assert.equal(ok(ROOT), true);
  assert.equal(ok('src/a.js'), true);
  assert.equal(ok('/home/dev/.netrc'), false);
  assert.equal(ok(ROOT + '/../.credentials.json'), false);
  assert.equal(ok('/home/dev/project-evil/x'), false);
  assert.equal(ok('/HOME/DEV/PROJECT/x'), false);
  assert.equal(ok(''), false);
});

test('hasGitSegment and patternTargetsCredentials: .git segments', () => {
  assert.equal(policy.hasGitSegment('.git/config'), true);
  assert.equal(policy.hasGitSegment('a/.GIT/config'), true);
  assert.equal(policy.hasGitSegment('src/.git'), true);
  assert.equal(policy.hasGitSegment('src/.github/x.yml'), false);
  assert.equal(policy.hasGitSegment('src/a.git'), false);
  assert.equal(policy.hasGitSegment('.gitignore'), false);
  assert.equal(policy.hasGitSegment(5), false);
  assert.equal(policy.patternTargetsCredentials('.git/**'), true);
  assert.equal(policy.patternTargetsCredentials('**/.GIT/config'), true);
  assert.equal(policy.patternTargetsCredentials('**/*.js'), false);
  assert.equal(policy.patternTargetsCredentials('**/.github/*.yml'), false);
});

test('hasGitSegment: NTFS aliases of .git', () => {
  for (const p of ['.git./config', '.git /config', '.GIT.../config', '.git::$INDEX_ALLOCATION/config', 'a\\.git:x\\config']) {
    assert.equal(policy.hasGitSegment(p), true, p);
  }
  for (const p of ['.github/workflows/x.yml', '.gitignore', 'src/git/x.js', '.gitattributes']) {
    assert.equal(policy.hasGitSegment(p), false, p);
  }
});

test('patternTargetsCredentials: wildcard segments that match .git', () => {
  const c = policy.patternTargetsCredentials;
  for (const p of ['.gi?/config', '.g*/config', '.[g]it/config', '.git*/**', '**/.gi?/**', '[.]git/config', '.gi*']) {
    assert.equal(c(p), true, p);
  }
  for (const p of ['**/*.js', 'src/*.sql', '*.md', 'migrations/**', '.github/**']) {
    assert.equal(c(p), false, p);
  }
});

test('isCredentialPath', () => {
  const c = policy.isCredentialPath;
  for (const p of ['.env', 'a/.env.local', 'a\\.ENV', '.netrc', 'x/server.pem', 'k.KEY', 'id_rsa', 'id_rsa.pub', '.npmrc', '.pgpass', '.env.', '.env:stream']) {
    assert.equal(c(p), true, p);
  }
  // Any dot-separated extension in the credential set counts (a.key.md, prod.env.bak), as for Grep "*.key.md".
  for (const p of ['pom.xml', 'environment.md', 'keys', 'key.txt', '', undefined, 5]) assert.equal(c(p), false, String(p));
});

test('isCredentialPath: credential extensions anywhere in the name (single source with the Grep blocked list)', () => {
  const c = policy.isCredentialPath;
  for (const p of ['prod.env', 'a.tfvars', 'a.p12', 'x.gpg', 'keystore.jks', 'a.env.', 'A.ENV', 'sub/prod.env',
    'prod.env::$DATA', 'prod.env ', 'PROD.ENV.', 'a.tfvars.json', 'a.env.bak', '.keystore', 'debug.keystore',
    'a.key.md', 'c.pfx', 's.asc']) {
    assert.equal(c(p), true, p);
  }
});

test('isSimpleGrepGlob: literal file names with a credential extension are rejected', () => {
  const g = policy.isSimpleGrepGlob;
  for (const glob of ['prod.env', 'a.tfvars', 'a.p12', 'x.gpg', 'keystore.jks', 'a.env.', 'A.ENV', '**/prod.env',
    'src/a.tfvars.json', 'a.env.bak', 'debug.keystore']) {
    assert.equal(g(glob), false, glob);
  }
  for (const glob of ['pom.xml', 'schema.sql', 'README.md', '**/*.d.ts', 'src/**/*.java', 'key.txt']) {
    assert.equal(g(glob), true, glob);
  }
});

test('patternTargetsCredentials', () => {
  const c = policy.patternTargetsCredentials;
  for (const p of ['**/.env*', '.env', '*.pem', '**/*.key', 'a/id_rsa*', '.NETRC', '.e[n]v', '[']) assert.equal(c(p), true, p);
  for (const p of ['*', '**/*', '**/*.md', 'src/**/*.java', undefined, 5]) assert.equal(c(p), false, String(p));
});
