'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateRev, validateRange, validatePath, validatePaths, isValidBranch,
  REV_PATTERN, RANGE_PATTERN, REV_MESSAGE, RANGE_MESSAGE,
} = require('../lib/validate');

test('validateRev accepts valid revs', () => {
  for (const r of ['HEAD', 'origin/release', 'abc1234', 'a'.repeat(40)]) {
    assert.deepEqual(validateRev(r), { ok: true, value: r }, r);
  }
});

test('validateRev rejects invalid revs', () => {
  const bad = ['head', 'abc123', 'g'.repeat(7), 'a'.repeat(41), 'HEAD~1', 'HEAD^',
    '--all', '-x', '', ' HEAD', 'HEAD\n', '\uFF28EAD', 42, undefined];
  for (const r of bad) {
    const res = validateRev(r);
    assert.equal(res.ok, false, String(r));
    assert.equal(typeof res.reason, 'string');
    assert.match(res.reason, /rev/);
  }
});

test('validateRange accepts REV..REV', () => {
  assert.deepEqual(validateRange('origin/release..HEAD'), {
    ok: true, value: 'origin/release..HEAD', from: 'origin/release', to: 'HEAD',
  });
});

test('validateRange rejects malformed ranges', () => {
  for (const r of ['HEAD...HEAD', 'HEAD..HEAD..HEAD', '..HEAD', 'HEAD..', 'HEAD..origin/a b',
    'HEAD .. HEAD', 'HEAD', 42, undefined]) {
    const res = validateRange(r);
    assert.equal(res.ok, false, String(r));
    assert.match(res.reason, /range/);
  }
});

test('validatePath accepts safe relative paths', () => {
  for (const p of ['src/main/resources/db/migration', 'V1__init.sql', 'a/b.c/d_e-f']) {
    assert.deepEqual(validatePath(p), { ok: true, value: p }, p);
  }
});

test('validatePath rejects unsafe paths', () => {
  const bad = ['../x', 'a/../b', 'a/..', '/etc', 'C:/x', 'C:x', '/c/Users', '\\\\srv\\s', 'a\\b', '\\srv\s', 'a\b',
    ':(top)x', ':/x', '.env', 'a/.git/config', '-x', 'a/-x', '--no-index', 'a//b', 'a/', '~/x',
    'a b', 'a\tb', 'ñ', '*', 'a{b,c}', '', 'a'.repeat(4097), 'a\n', 42, undefined];
  for (const p of bad) {
    const res = validatePath(p);
    assert.equal(res.ok, false, JSON.stringify(p));
    assert.match(res.reason, /path/);
  }
  assert.equal(validatePath('a'.repeat(4096)).ok, true);
});

test('validatePaths', () => {
  assert.deepEqual(validatePaths(undefined), { ok: true, value: [] });
  assert.deepEqual(validatePaths(['a', 'b']), { ok: true, value: ['a', 'b'] });
  assert.equal(validatePaths(['a', '../b']).ok, false);
  assert.equal(validatePaths(Array.from({ length: 21 }, (_, i) => 'f' + i)).ok, false);
  assert.equal(validatePaths(Array.from({ length: 20 }, (_, i) => 'f' + i)).ok, true);
  assert.equal(validatePaths('a').ok, false);
  assert.match(validatePaths('a').reason, /paths/);
});

test('any remote branch accepted', () => {
  for (const r of ['origin/main', 'origin/feature/JIRA-12_fix', 'origin/release/1.4', 'origin/release/2026-12']) {
    assert.deepEqual(validateRev(r), { ok: true, value: r }, r);
  }
  assert.equal(validateRev('origin/anything', ['ignored']).ok, true);
});

test('invalid remote refs rejected', () => {
  for (const r of ['origin/HEAD', 'origin/-x', 'origin/.x', 'origin/x.', 'origin/a..b', 'origin/a b',
    'origin/a~1', 'origin/', 'refs/heads/main', 'main']) {
    assert.deepEqual(validateRev(r), { ok: false, reason: REV_MESSAGE }, r);
  }
});

test('range with dotted branches', () => {
  const res = validateRange('origin/release/1.4..HEAD');
  assert.equal(res.ok, true);
  assert.equal(res.from, 'origin/release/1.4');
  assert.equal(res.to, 'HEAD');
  assert.equal(validateRange('origin/main..origin/feature/x').ok, true);
  assert.deepEqual(validateRange('origin/HEAD..HEAD'), { ok: false, reason: RANGE_MESSAGE });
});

test('REV_PATTERN and RANGE_PATTERN accept dotted branches', () => {
  assert.equal(REV_PATTERN.test('origin/release/1.4'), true);
  assert.equal(RANGE_PATTERN.test('abc1234..origin/release/1.4'), true);
  assert.equal(REV_PATTERN.test('origin/a..b'), false);
});

test('isValidBranch', () => {
  assert.equal(isValidBranch('release/1.4'), true);
  assert.equal(isValidBranch('HEAD'), false);
  assert.equal(isValidBranch('a..b'), false);
  assert.equal(isValidBranch(undefined), false);
});

test('validation messages are English', () => {
  assert.match(validateRev('x').reason, /^The rev parameter must be/);
  assert.match(validatePath('../x').reason, /^The path parameter must be/);
});
