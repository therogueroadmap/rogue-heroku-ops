'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRev, validateRange, validatePath, validatePaths } = require('../lib/validate');

const BR = ['release'];

test('validateRev accepts valid revs', () => {
  for (const r of ['HEAD', 'origin/release', 'abc1234', 'a'.repeat(40)]) {
    assert.deepEqual(validateRev(r, BR), { ok: true, value: r }, r);
  }
});

test('validateRev rejects invalid revs', () => {
  const bad = ['head', 'origin/main', 'abc123', 'g'.repeat(7), 'a'.repeat(41), 'HEAD~1', 'HEAD^',
    '--all', '-x', '', ' HEAD', 'HEAD\n', '\uFF28EAD', 42, undefined];
  for (const r of bad) {
    const res = validateRev(r, BR);
    assert.equal(res.ok, false, String(r));
    assert.equal(typeof res.reason, 'string');
    assert.match(res.reason, /rev/);
  }
});

test('validateRev rejects origin/ refs when deployBranch is malformed', () => {
  for (const b of ['a b', 'x..y', '-x', '', 'a/', undefined, 'a.*']) {
    assert.equal(validateRev('origin/' + b, [b]).ok, false, String(b));
  }
  assert.equal(validateRev('origin/feat/x-1', ['feat/x-1']).ok, true);
});

test('validateRange accepts REV..REV', () => {
  assert.deepEqual(validateRange('origin/release..HEAD', BR), {
    ok: true, value: 'origin/release..HEAD', from: 'origin/release', to: 'HEAD',
  });
});

test('validateRange rejects malformed ranges', () => {
  for (const r of ['HEAD...HEAD', 'HEAD..HEAD..HEAD', '..HEAD', 'HEAD..', 'HEAD..origin/main',
    'HEAD .. HEAD', 'HEAD', 42, undefined]) {
    const res = validateRange(r, BR);
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

test('validateRev and validateRange accept origin/<b> for any deploy branch', () => {
  assert.equal(validateRev('origin/develop', ['main', 'develop']).ok, true);
  assert.equal(validateRev('origin/main', ['main', 'develop']).ok, true);
  assert.equal(validateRev('origin/feature', ['main', 'develop']).ok, false);
  assert.equal(validateRange('origin/main..origin/develop', ['main', 'develop']).ok, true);
  assert.equal(validateRange('origin/main..origin/feature', ['main', 'develop']).ok, false);
});

test('validation messages are English', () => {
  assert.match(validateRev('x', BR).reason, /^The rev parameter must be/);
  assert.match(validatePath('../x').reason, /^The path parameter must be/);
});
