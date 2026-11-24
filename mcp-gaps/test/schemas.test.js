'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { toolDefinitions } = require('../lib/schemas');
const { validateRev, validateRange, validatePath, REV_PATTERN, RANGE_PATTERN, PATH_PATTERN } = require('../lib/validate');

const cfg = { apps: ['app-test'], repoPath: 'C:\\repo', deployBranch: 'releaseCandidate', healthUrl: 'https://x/health' };
const defs = toolDefinitions(cfg);
const parse = (tool, input) => z.object(defs[tool].inputSchema).safeParse(input);
const SHA = 'abc1234';

test('toolDefinitions expone las 9 herramientas', () => {
  assert.deepEqual(Object.keys(defs).sort(), [
    'backup_capture', 'backup_info', 'git_diff', 'git_fetch', 'git_log', 'git_ls_tree', 'git_show', 'health_check', 'releases_list',
  ]);
});

test('el esquema rechaza rev, range y path con forma inválida', () => {
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

test('el mensaje de rechazo del esquema está en español', () => {
  const r = parse('git_show', { rev: '--all' });
  assert.match(r.error.issues[0].message, /El parámetro rev debe ser/);
});

test('coherencia: todo lo que argv.js acepta, el esquema también', () => {
  const revs = ['HEAD', 'origin/releaseCandidate', SHA, 'a'.repeat(40)];
  for (const rev of revs) {
    assert.equal(validateRev(rev, cfg.deployBranch).ok, true, rev);
    assert.ok(REV_PATTERN.test(rev), rev);
    assert.equal(parse('git_show', { rev }).success, true, rev);
    assert.equal(parse('git_diff', { from: rev, to: 'HEAD' }).success, true, rev);
  }
  for (const a of revs) for (const b of revs) {
    const range = `${a}..${b}`;
    assert.equal(validateRange(range, cfg.deployBranch).ok, true, range);
    assert.ok(RANGE_PATTERN.test(range), range);
    assert.equal(parse('git_log', { range }).success, true, range);
  }
  for (const p of ['src/main/resources/db/migration/V1__x.sql', 'README.md', '_a/b-c.d']) {
    assert.equal(validatePath(p).ok, true, p);
    assert.ok(PATH_PATTERN.test(p), p);
    assert.equal(parse('git_ls_tree', { rev: 'HEAD', paths: [p] }).success, true, p);
  }
});
