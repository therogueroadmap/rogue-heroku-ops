'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { toolDefinitions } = require('../lib/schemas');
const { validateRev, validateRange, validatePath, REV_PATTERN, RANGE_PATTERN, PATH_PATTERN } = require('../lib/validate');

const cfg = { apps: [{ name: 'app-test', healthUrl: 'https://x/health', deployBranch: 'release' }], n1Mode: 'ask' };
const defs = toolDefinitions(cfg);
const RB = ['release'];
const parse = (tool, input) => z.object(defs[tool].inputSchema).safeParse(input);
const SHA = 'abc1234';

test('toolDefinitions exposes all 11 tools', () => {
  assert.deepEqual(Object.keys(defs).sort(), [
    'backup_capture', 'backup_info', 'get_config', 'get_procedure', 'git_diff', 'git_fetch', 'git_log', 'git_ls_tree', 'git_show', 'health_check', 'releases_list',
  ]);
});

test('schema rejects rev, range and path with an invalid shape', () => {
  for (const rev of ['--all', '-x', 'HEAD~1', 'main', '../x', 'origin/a b']) {
    assert.equal(parse('git_show', { rev }).success, false, rev);
  }
  for (const range of ['a..b..c', `${SHA}...HEAD`, '--x..HEAD', `HEAD..${SHA};rm`]) {
    assert.equal(parse('git_log', { range }).success, false, range);
  }
  for (const p of ['../x', '/abs', 'a//b', '-x', 'a/.git', 'C:\\x']) {
    assert.equal(parse('git_show', { rev: 'HEAD', path: p }).success, false, p);
  }
});

test('schema rejection message is English', () => {
  const r = parse('git_show', { rev: '--all' });
  assert.match(r.error.issues[0].message, /The rev parameter must be/);
});

test('consistency: everything argv.js accepts, the schema accepts too', () => {
  const revs = ['HEAD', 'origin/release', SHA, 'a'.repeat(40)];
  for (const rev of revs) {
    assert.equal(validateRev(rev, RB).ok, true, rev);
    assert.ok(REV_PATTERN.test(rev), rev);
    assert.equal(parse('git_show', { rev }).success, true, rev);
    assert.equal(parse('git_diff', { from: rev, to: 'HEAD' }).success, true, rev);
  }
  for (const a of revs) for (const b of revs) {
    const range = `${a}..${b}`;
    assert.equal(validateRange(range, RB).ok, true, range);
    assert.ok(RANGE_PATTERN.test(range), range);
    assert.equal(parse('git_log', { range }).success, true, range);
  }
  for (const p of ['src/main/resources/db/migration/V1__x.sql', 'README.md', '_a/b-c.d']) {
    assert.equal(validatePath(p).ok, true, p);
    assert.ok(PATH_PATTERN.test(p), p);
    assert.equal(parse('git_ls_tree', { rev: 'HEAD', paths: [p] }).success, true, p);
  }
});

test('app is an enum of configured apps with a valid config, a plain string otherwise', () => {
  assert.equal(parse('releases_list', { app: 'app-test' }).success, true);
  assert.equal(parse('releases_list', { app: 'other' }).success, false);
  const loose = toolDefinitions(null);
  assert.equal(z.object(loose.releases_list.inputSchema).safeParse({ app: 'anything' }).success, true);
});

test('get_procedure name is restricted to deploy|incident|routine by the schema', () => {
  for (const name of ['deploy', 'incident', 'routine']) assert.equal(parse('get_procedure', { name }).success, true, name);
  for (const name of ['../x', 'deploy.md', '', 'other']) assert.equal(parse('get_procedure', { name }).success, false, name);
});

test('health_check takes an app; get_config takes no parameters', () => {
  assert.deepEqual(Object.keys(defs.health_check.inputSchema), ['app']);
  assert.deepEqual(Object.keys(defs.get_config.inputSchema), []);
});
