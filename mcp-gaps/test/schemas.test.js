'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { toolDefinitions } = require('../lib/schemas');
const { validateRev, validateRange, validatePath, REV_PATTERN, RANGE_PATTERN, PATH_PATTERN } = require('../lib/validate');

const cfg = { apps: [{ name: 'app-test', healthUrl: 'https://x/health', deployBranch: 'release' }], n1Mode: 'ask' };
const defs = toolDefinitions(cfg);
const RB = ['release'];
const GIT_TOOLS = ['git_fetch', 'git_log', 'git_show', 'git_ls_tree', 'git_diff'];
// Git tools get the required app filled in unless the input already names one.
const parse = (tool, input) => z.object(defs[tool].inputSchema).safeParse(GIT_TOOLS.includes(tool) ? { app: 'app-test', ...input } : input);
const SHA = 'abc1234';

test('toolDefinitions exposes all 12 tools', () => {
  assert.deepEqual(Object.keys(defs).sort(), [
    'backup_capture', 'backup_info', 'get_config', 'get_procedure', 'git_branches', 'git_diff', 'git_fetch', 'git_log', 'git_ls_tree', 'git_show', 'health_check', 'releases_list',
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

test('the five git tools require app, an enum of configured apps with a valid config', () => {
  for (const tool of GIT_TOOLS) {
    assert.ok('app' in defs[tool].inputSchema, tool);
    const input = { git_log: { rev: 'HEAD' }, git_show: { rev: 'HEAD' }, git_ls_tree: { rev: 'HEAD' }, git_diff: { from: 'HEAD', to: 'HEAD' }, git_fetch: {} }[tool];
    assert.equal(z.object(defs[tool].inputSchema).safeParse(input).success, false, `${tool} without app`);
    assert.equal(parse(tool, input).success, true, tool);
    assert.equal(parse(tool, { ...input, app: 'other' }).success, false, `${tool} unknown app`);
  }
  assert.equal(parse('git_show', { rev: 'origin/feature/x' }).success, true);
  assert.equal(z.object(toolDefinitions(null).git_fetch.inputSchema).safeParse({ app: 'anything' }).success, true);
});

test('git tool descriptions name the repository of the app', () => {
  for (const tool of GIT_TOOLS) assert.doesNotMatch(defs[tool].description, /project repository/, tool);
  assert.match(defs.git_fetch.description, /the repository of the app/);
  assert.match(defs.git_log.description, /the repository of the app/);
  assert.match(defs.git_diff.description, /the repository of the app/);
  assert.equal(defs.git_show.inputSchema.rev.description, 'HEAD, origin/<branch> or a hexadecimal SHA of 7 to 40 characters.');
});
