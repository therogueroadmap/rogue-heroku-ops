'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { herokuArgs, gitArgs, healthApp, GIT_PREFIX } = require('../lib/argv');
const { NO_REPO_REASON } = require('../../lib/config');

const tmpDirs = [];
function tmpDir({ git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-argv-'));
  if (git) fs.mkdirSync(path.join(dir, '.git'));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const PROJECT = tmpDir();
const cfg = { apps: [{ name: 'my-app', healthUrl: 'https://x/health', deployBranch: 'release' }], n1Mode: 'ask' };
const ctx = { config: cfg, projectDir: PROJECT, platform: 'linux' };
const APP = 'my-app';
const P = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-C', PROJECT];
const D = 'origin/release';

// gitArgs with the app parameter filled in unless the input already names one.
const gitApp = (tool, input, c = ctx) => gitArgs(tool, input !== null && typeof input === 'object' && !Array.isArray(input) ? { app: APP, ...input } : input, c);

const notOk = (res) => {
  assert.equal(res.ok, false);
  assert.equal(typeof res.reason, 'string');
  assert.ok(res.reason.length > 0);
};

test('releases_list: default and explicit limit', () => {
  assert.deepEqual(herokuArgs('releases_list', { app: APP }, cfg), {
    ok: true,
    args: ['releases', '-n', '10', '-a', APP, '--json'],
  });
  assert.deepEqual(herokuArgs('releases_list', { app: APP, limit: 50 }, cfg).args, ['releases', '-n', '50', '-a', APP, '--json']);
});

test('releases_list: invalid limit or app', () => {
  for (const limit of [0, 51, '5', 5.5, -1, null, NaN]) notOk(herokuArgs('releases_list', { app: APP, limit }, cfg));
  notOk(herokuArgs('releases_list', { app: 'otra' }, cfg));
  notOk(herokuArgs('releases_list', {}, cfg));
});

test('backup_info: optional id', () => {
  assert.deepEqual(herokuArgs('backup_info', { app: APP }, cfg).args, ['pg:backups:info', '-a', APP]);
  assert.deepEqual(herokuArgs('backup_info', { app: APP, id: 'b012' }, cfg).args, ['pg:backups:info', 'b012', '-a', APP]);
  assert.equal(herokuArgs('backup_info', { app: APP, id: 'r123456' }, cfg).ok, true);
  for (const id of ['b12', 'x0123', 'b1234567', '-b012', 'b012 ', 12345, '']) {
    notOk(herokuArgs('backup_info', { app: APP, id }, cfg));
  }
});

test('backup_capture', () => {
  assert.deepEqual(herokuArgs('backup_capture', { app: APP }, cfg).args, ['pg:backups:capture', '-a', APP]);
  notOk(herokuArgs('backup_capture', { app: 'otra' }, cfg));
});

test('git_fetch adds credential.helper=manager only on win32', () => {
  assert.deepEqual(gitApp('git_fetch', {}, ctx), { ok: true, args: [...P, 'fetch', 'origin'] });
  assert.deepEqual(gitApp('git_fetch', {}, { ...ctx, platform: 'darwin' }).args, [...P, 'fetch', 'origin']);
  assert.deepEqual(gitApp('git_fetch', {}, { ...ctx, platform: 'win32' }).args, [...P, '-c', 'credential.helper=manager', 'fetch', 'origin']);
});

test('git_branches args', () => {
  assert.deepEqual(gitApp('git_branches', {}, ctx), { ok: true, args: [...P, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'] });
  notOk(gitArgs('git_branches', {}, ctx));
  notOk(gitApp('git_branches', { extra: 1 }, ctx));
});

test('GIT_PREFIX uses -C with the given dir', () => {
  assert.deepEqual(GIT_PREFIX(PROJECT), P);
});

test('git tools require app', () => {
  for (const tool of ['git_fetch', 'git_branches', 'git_log', 'git_show', 'git_ls_tree', 'git_diff']) {
    const input = { git_log: { rev: 'HEAD' }, git_show: { rev: 'HEAD' }, git_ls_tree: { rev: 'HEAD' }, git_diff: { from: 'HEAD', to: 'HEAD' }, git_fetch: {}, git_branches: {} }[tool];
    notOk(gitArgs(tool, input, ctx));
    notOk(gitArgs(tool, { app: 'otra', ...input }, ctx));
    notOk(gitArgs(tool, { app: 5, ...input }, ctx));
    assert.equal(gitArgs(tool, { app: APP, ...input }, ctx).ok, true, tool);
  }
});

test('-C points to repoPath of the app', () => {
  const dirA = tmpDir();
  const dirB = tmpDir();
  const multi = { ...ctx, config: { apps: [
    { name: 'app-a', healthUrl: 'https://a/h', deployBranch: 'main', repoPath: dirA },
    { name: 'app-b', healthUrl: 'https://b/h', deployBranch: 'develop', repoPath: dirB },
  ] } };
  const a = gitArgs('git_log', { app: 'app-a', rev: 'HEAD' }, multi);
  const b = gitArgs('git_log', { app: 'app-b', rev: 'HEAD' }, multi);
  assert.deepEqual(a.args.slice(0, 7), GIT_PREFIX(dirA));
  assert.deepEqual(b.args.slice(0, 7), GIT_PREFIX(dirB));
  assert.deepEqual(gitArgs('git_fetch', { app: 'app-b' }, multi).args.slice(5, 7), ['-C', dirB]);
});

test('-C points to project when app has no repoPath and project is a repo root', () => {
  const res = gitArgs('git_show', { app: APP, rev: 'HEAD' }, ctx);
  assert.deepEqual(res.args.slice(5, 7), ['-C', PROJECT]);
});

test('no repository -> error without git args', () => {
  const noGit = { ...ctx, projectDir: tmpDir({ git: false }) };
  for (const [tool, input] of [['git_fetch', {}], ['git_log', { rev: 'HEAD' }], ['git_diff', { from: 'HEAD', to: 'HEAD' }]]) {
    assert.deepEqual(gitArgs(tool, { app: APP, ...input }, noGit), { ok: false, reason: NO_REPO_REASON(APP) });
  }
});

test('any valid remote branch accepted', () => {
  assert.equal(gitApp('git_log', { rev: 'origin/feature/x' }).ok, true);
  assert.equal(gitApp('git_log', { range: 'origin/main..origin/feature/x' }).ok, true);
  assert.equal(gitApp('git_diff', { from: 'origin/release/1.4', to: 'HEAD' }).ok, true);
  notOk(gitApp('git_log', { rev: 'origin/HEAD' }));
  notOk(gitApp('git_diff', { from: 'origin/HEAD', to: 'HEAD' }));
  notOk(gitApp('git_show', { rev: 'feature' }));
});

test('health_check: only a configured app is accepted', () => {
  assert.deepEqual(healthApp({ app: APP }, cfg), { ok: true, app: cfg.apps[0] });
  notOk(healthApp({ app: 'otra' }, cfg));
  notOk(healthApp({}, cfg));
  notOk(healthApp({ app: APP, extra: 1 }, cfg));
});

test('git_log: range with format and n', () => {
  assert.deepEqual(gitApp('git_log', { range: `${D}..HEAD`, format: 'oneline', n: 20 }, ctx).args, [
    ...P, 'log', '--no-ext-diff', '--no-textconv', '--oneline', '-n', '20', `${D}..HEAD`, '--',
  ]);
});

test('git_log: defaults, rev and paths', () => {
  const res = gitApp('git_log', { rev: 'HEAD', paths: ['src'] }, ctx);
  assert.deepEqual(res.args, [...P, 'log', '--no-ext-diff', '--no-textconv', '-n', '20', 'HEAD', '--', 'src']);
  for (const [format, flag] of [['stat', '--stat'], ['name-only', '--name-only']]) {
    assert.ok(gitApp('git_log', { rev: 'HEAD', format }, ctx).args.includes(flag));
  }
});

test('git_log: invalid inputs', () => {
  notOk(gitApp('git_log', { rev: 'HEAD', range: 'HEAD..HEAD' }, ctx));
  notOk(gitApp('git_log', {}, ctx));
  notOk(gitApp('git_log', { rev: 'HEAD', format: 'patch' }, ctx));
  notOk(gitApp('git_log', { rev: 'HEAD', n: 0 }, ctx));
  notOk(gitApp('git_log', { rev: 'HEAD', n: 201 }, ctx));
  notOk(gitApp('git_log', { rev: 'HEAD', n: '5' }, ctx));
  notOk(gitApp('git_log', { rev: '--output=x' }, ctx));
  notOk(gitApp('git_log', { range: 'HEAD' }, ctx));
  notOk(gitApp('git_log', { rev: 'HEAD', paths: ['../x'] }, ctx));
  notOk(gitApp('git_log', { rev: 'HEAD', paths: '-x' }, ctx));
});

test('git_show: rev:path single token', () => {
  const res = gitApp('git_show', { rev: D, path: 'src/V1__a.sql' }, ctx);
  assert.deepEqual(res.args, [...P, 'show', '--no-textconv', `${D}:src/V1__a.sql`]);
  assert.equal(res.args.at(-1), `${D}:src/V1__a.sql`);
});

test('git_show: without path and with format', () => {
  assert.deepEqual(gitApp('git_show', { rev: 'HEAD' }, ctx).args, [...P, 'show', '--no-ext-diff', '--no-textconv', 'HEAD']);
  assert.deepEqual(gitApp('git_show', { rev: 'abc1234', format: 'stat' }, ctx).args, [
    ...P, 'show', '--no-ext-diff', '--no-textconv', '--stat', 'abc1234',
  ]);
  assert.ok(gitApp('git_show', { rev: 'HEAD', format: 'name-only' }, ctx).args.includes('--name-only'));
});

test('git_show: invalid inputs', () => {
  notOk(gitApp('git_show', { rev: 'HEAD', path: '../x' }, ctx));
  notOk(gitApp('git_show', { rev: 'HEAD', path: 'a', format: 'stat' }, ctx));
  notOk(gitApp('git_show', { path: 'a' }, ctx));
  notOk(gitApp('git_show', { rev: 'HEAD', format: 'oneline' }, ctx));
});

test('git_ls_tree', () => {
  assert.deepEqual(
    gitApp('git_ls_tree', { rev: D, recursive: true, nameOnly: true, paths: ['src/main/resources/db/migration'] }, ctx).args,
    [...P, 'ls-tree', '-r', '--name-only', D, '--', 'src/main/resources/db/migration'],
  );
  assert.deepEqual(gitApp('git_ls_tree', { rev: 'HEAD' }, ctx).args, [...P, 'ls-tree', 'HEAD']);
});

test('git_ls_tree: invalid inputs', () => {
  notOk(gitApp('git_ls_tree', {}, ctx));
  notOk(gitApp('git_ls_tree', { rev: 'HEAD', recursive: 'true' }, ctx));
  notOk(gitApp('git_ls_tree', { rev: 'HEAD', nameOnly: 1 }, ctx));
});

test('git_diff', () => {
  const res = gitApp('git_diff', { from: D, to: 'HEAD', format: 'stat' }, ctx);
  assert.deepEqual(res.args, [...P, 'diff', '--no-ext-diff', '--no-textconv', '--stat', `${D}..HEAD`, '--']);
  assert.deepEqual(gitApp('git_diff', { from: 'HEAD', to: 'abc1234', paths: ['src'] }, ctx).args, [
    ...P, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD..abc1234', '--', 'src',
  ]);
});

test('git_diff: invalid inputs', () => {
  notOk(gitApp('git_diff', { from: D }, ctx));
  notOk(gitApp('git_diff', { to: 'HEAD' }, ctx));
  notOk(gitApp('git_diff', { from: 'main', to: 'HEAD' }, ctx));
  notOk(gitApp('git_diff', { from: 'HEAD', to: 'HEAD', format: 'patch' }, ctx));
});

test('R2: unknown keys, non-object input and unknown tool are rejected', () => {
  const r = herokuArgs('releases_list', { app: APP, extra: 'x' }, cfg);
  notOk(r);
  assert.match(r.reason, /extra/);
  notOk(herokuArgs('backup_capture', { app: APP, id: 'b012' }, cfg));
  const g = gitApp('git_fetch', { remote: 'evil' }, ctx);
  notOk(g);
  assert.match(g.reason, /remote/);
  notOk(gitApp('git_log', { rev: 'HEAD', from: 'HEAD' }, ctx));
  notOk(gitApp('git_show', { rev: 'HEAD', paths: ['a'] }, ctx));
  notOk(gitApp('git_ls_tree', { rev: 'HEAD', n: 1 }, ctx));
  notOk(gitApp('git_diff', { from: 'HEAD', to: 'HEAD', rev: 'HEAD' }, ctx));
  for (const bad of [null, undefined, 'x', 5, [], ['a']]) {
    notOk(herokuArgs('releases_list', bad, cfg));
    notOk(gitApp('git_fetch', bad, ctx));
  }
  notOk(herokuArgs('git_log', { app: APP }, cfg));
  notOk(herokuArgs('nope', { app: APP }, cfg));
  notOk(gitApp('releases_list', {}, ctx));
  notOk(gitApp('nope', {}, ctx));
  notOk(gitApp('toString', {}, ctx));
  notOk(herokuArgs('constructor', { app: APP }, cfg));
});

test('invariants: prefix intact and no user token starts with a dash', () => {
  const fixed = new Set(['--no-ext-diff', '--no-textconv', '--oneline', '--stat', '--name-only', '-n', '-r', '--']);
  const seen = new Set();
  const calls = [
    ['git_fetch', {}],
    ['git_log', { range: `${D}..HEAD`, format: 'stat', n: 5, paths: ['src', 'a/b.c'] }],
    ['git_log', { rev: 'HEAD', format: 'oneline' }],
    ['git_show', { rev: 'HEAD', path: 'src/a.sql' }],
    ['git_show', { rev: 'HEAD', format: 'name-only' }],
    ['git_ls_tree', { rev: D, recursive: true, nameOnly: true, paths: ['src'] }],
    ['git_diff', { from: D, to: 'HEAD', format: 'name-only', paths: ['src'] }],
  ];
  const subcommands = { git_fetch: 'fetch', git_log: 'log', git_show: 'show', git_ls_tree: 'ls-tree', git_diff: 'diff' };
  for (const [tool, input] of calls) {
    const res = gitApp(tool, input, ctx);
    assert.equal(res.ok, true, tool);
    assert.deepEqual(res.args.slice(0, 7), P);
    assert.equal(res.args[6], PROJECT);
    const at = 7;
    assert.ok(!res.args.includes('credential.helper=manager'), `${tool}: unexpected credential.helper`);
    assert.equal(res.args[at], subcommands[tool]);
    for (const tok of res.args.slice(at + 1)) {
      if (tok.startsWith('-')) assert.ok(fixed.has(tok), `${tool}: unexpected token ${tok}`);
      if (fixed.has(tok)) seen.add(tok);
    }
  }
  assert.deepEqual([...fixed].filter((t) => !seen.has(t)), [], 'inert entries in fixed');
});

test('git tools reject credential paths', () => {
  for (const path of ['config/prod.env', 'certs/server.key', 'deploy.pem']) {
    const res = gitApp('git_show', { rev: 'HEAD', path }, ctx);
    notOk(res);
    assert.match(res.reason, /credential files through git/);
    notOk(gitApp('git_diff', { from: 'HEAD', to: 'abc1234', paths: ['src', path] }, ctx));
    notOk(gitApp('git_log', { rev: 'HEAD', paths: [path] }, ctx));
    assert.equal(gitApp('git_ls_tree', { rev: 'HEAD', paths: [path] }, ctx).ok, true);
  }
  assert.equal(gitApp('git_show', { rev: 'HEAD', path: 'src/main/App.java' }, ctx).ok, true);
});
