'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { herokuArgs, gitArgs } = require('../lib/argv');

const cfg = { apps: ['my-app'], repoPath: 'C:\\repo x', deployBranch: 'releaseCandidate' };
const APP = 'my-app';
const P = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-C', 'C:\\repo x'];
const D = 'origin/releaseCandidate';

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

test('git_fetch', () => {
  assert.deepEqual(gitArgs('git_fetch', {}, cfg), { ok: true, args: [...P, '-c', 'credential.helper=manager', 'fetch', 'origin'] });
});

test('git_log: range with format and n', () => {
  assert.deepEqual(gitArgs('git_log', { range: `${D}..HEAD`, format: 'oneline', n: 20 }, cfg).args, [
    ...P, 'log', '--no-ext-diff', '--no-textconv', '--oneline', '-n', '20', `${D}..HEAD`, '--',
  ]);
});

test('git_log: defaults, rev and paths', () => {
  const res = gitArgs('git_log', { rev: 'HEAD', paths: ['src'] }, cfg);
  assert.deepEqual(res.args, [...P, 'log', '--no-ext-diff', '--no-textconv', '-n', '20', 'HEAD', '--', 'src']);
  for (const [format, flag] of [['stat', '--stat'], ['name-only', '--name-only']]) {
    assert.ok(gitArgs('git_log', { rev: 'HEAD', format }, cfg).args.includes(flag));
  }
});

test('git_log: invalid inputs', () => {
  notOk(gitArgs('git_log', { rev: 'HEAD', range: 'HEAD..HEAD' }, cfg));
  notOk(gitArgs('git_log', {}, cfg));
  notOk(gitArgs('git_log', { rev: 'HEAD', format: 'patch' }, cfg));
  notOk(gitArgs('git_log', { rev: 'HEAD', n: 0 }, cfg));
  notOk(gitArgs('git_log', { rev: 'HEAD', n: 201 }, cfg));
  notOk(gitArgs('git_log', { rev: 'HEAD', n: '5' }, cfg));
  notOk(gitArgs('git_log', { rev: '--output=x' }, cfg));
  notOk(gitArgs('git_log', { range: 'HEAD' }, cfg));
  notOk(gitArgs('git_log', { rev: 'HEAD', paths: ['../x'] }, cfg));
  notOk(gitArgs('git_log', { rev: 'HEAD', paths: '-x' }, cfg));
});

test('git_show: rev:path single token', () => {
  const res = gitArgs('git_show', { rev: D, path: 'src/V1__a.sql' }, cfg);
  assert.deepEqual(res.args, [...P, 'show', '--no-textconv', `${D}:src/V1__a.sql`]);
  assert.equal(res.args.at(-1), `${D}:src/V1__a.sql`);
});

test('git_show: without path and with format', () => {
  assert.deepEqual(gitArgs('git_show', { rev: 'HEAD' }, cfg).args, [...P, 'show', '--no-ext-diff', '--no-textconv', 'HEAD']);
  assert.deepEqual(gitArgs('git_show', { rev: 'abc1234', format: 'stat' }, cfg).args, [
    ...P, 'show', '--no-ext-diff', '--no-textconv', '--stat', 'abc1234',
  ]);
  assert.ok(gitArgs('git_show', { rev: 'HEAD', format: 'name-only' }, cfg).args.includes('--name-only'));
});

test('git_show: invalid inputs', () => {
  notOk(gitArgs('git_show', { rev: 'HEAD', path: '../x' }, cfg));
  notOk(gitArgs('git_show', { rev: 'HEAD', path: 'a', format: 'stat' }, cfg));
  notOk(gitArgs('git_show', { path: 'a' }, cfg));
  notOk(gitArgs('git_show', { rev: 'HEAD', format: 'oneline' }, cfg));
});

test('git_ls_tree', () => {
  assert.deepEqual(
    gitArgs('git_ls_tree', { rev: D, recursive: true, nameOnly: true, paths: ['src/main/resources/db/migration'] }, cfg).args,
    [...P, 'ls-tree', '-r', '--name-only', D, '--', 'src/main/resources/db/migration'],
  );
  assert.deepEqual(gitArgs('git_ls_tree', { rev: 'HEAD' }, cfg).args, [...P, 'ls-tree', 'HEAD']);
});

test('git_ls_tree: invalid inputs', () => {
  notOk(gitArgs('git_ls_tree', {}, cfg));
  notOk(gitArgs('git_ls_tree', { rev: 'HEAD', recursive: 'true' }, cfg));
  notOk(gitArgs('git_ls_tree', { rev: 'HEAD', nameOnly: 1 }, cfg));
});

test('git_diff', () => {
  const res = gitArgs('git_diff', { from: D, to: 'HEAD', format: 'stat' }, cfg);
  assert.deepEqual(res.args, [...P, 'diff', '--no-ext-diff', '--no-textconv', '--stat', `${D}..HEAD`, '--']);
  assert.deepEqual(gitArgs('git_diff', { from: 'HEAD', to: 'abc1234', paths: ['src'] }, cfg).args, [
    ...P, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD..abc1234', '--', 'src',
  ]);
});

test('git_diff: invalid inputs', () => {
  notOk(gitArgs('git_diff', { from: D }, cfg));
  notOk(gitArgs('git_diff', { to: 'HEAD' }, cfg));
  notOk(gitArgs('git_diff', { from: 'main', to: 'HEAD' }, cfg));
  notOk(gitArgs('git_diff', { from: 'HEAD', to: 'HEAD', format: 'patch' }, cfg));
});

test('R2: unknown keys, non-object input and unknown tool are rejected', () => {
  const r = herokuArgs('releases_list', { app: APP, extra: 'x' }, cfg);
  notOk(r);
  assert.match(r.reason, /extra/);
  notOk(herokuArgs('backup_capture', { app: APP, id: 'b012' }, cfg));
  const g = gitArgs('git_fetch', { remote: 'evil' }, cfg);
  notOk(g);
  assert.match(g.reason, /remote/);
  notOk(gitArgs('git_log', { rev: 'HEAD', from: 'HEAD' }, cfg));
  notOk(gitArgs('git_show', { rev: 'HEAD', paths: ['a'] }, cfg));
  notOk(gitArgs('git_ls_tree', { rev: 'HEAD', n: 1 }, cfg));
  notOk(gitArgs('git_diff', { from: 'HEAD', to: 'HEAD', rev: 'HEAD' }, cfg));
  for (const bad of [null, undefined, 'x', 5, [], ['a']]) {
    notOk(herokuArgs('releases_list', bad, cfg));
    notOk(gitArgs('git_fetch', bad, cfg));
  }
  notOk(herokuArgs('git_log', { app: APP }, cfg));
  notOk(herokuArgs('nope', { app: APP }, cfg));
  notOk(gitArgs('releases_list', {}, cfg));
  notOk(gitArgs('nope', {}, cfg));
  notOk(gitArgs('toString', {}, cfg));
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
    const res = gitArgs(tool, input, cfg);
    assert.equal(res.ok, true, tool);
    assert.deepEqual(res.args.slice(0, 7), P);
    assert.equal(res.args[6], 'C:\\repo x');
    const at = tool === 'git_fetch' ? 9 : 7;
    if (tool === 'git_fetch') assert.deepEqual(res.args.slice(7, 9), ['-c', 'credential.helper=manager']);
    else assert.ok(!res.args.includes('credential.helper=manager'), `${tool}: unexpected credential.helper`);
    assert.equal(res.args[at], subcommands[tool]);
    for (const tok of res.args.slice(at + 1)) {
      if (tok.startsWith('-')) assert.ok(fixed.has(tok), `${tool}: unexpected token ${tok}`);
      if (fixed.has(tok)) seen.add(tok);
    }
  }
  assert.deepEqual([...fixed].filter((t) => !seen.has(t)), [], 'inert entries in fixed');
});
