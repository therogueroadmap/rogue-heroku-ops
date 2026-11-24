'use strict';

const BRANCH_SEGMENT = String.raw`[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*`;
const BRANCH_RE = new RegExp(`^${BRANCH_SEGMENT}(?:/${BRANCH_SEGMENT})*$`);
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const MAX_PATH_LENGTH = 4096;
const MAX_PATHS = 20;

const REV_MESSAGE = 'The rev parameter must be HEAD, origin/<branch> or a hexadecimal SHA of 7 to 40 characters.';
const RANGE_MESSAGE = 'The range parameter must have the form REV..REV, with each REV being HEAD, origin/<branch> or a hexadecimal SHA of 7 to 40 characters.';

const fail = (reason) => ({ ok: false, reason });

function isValidBranch(name) {
  return typeof name === 'string' && name !== 'HEAD' && BRANCH_RE.test(name);
}

function revMatches(rev) {
  if (typeof rev !== 'string') return false;
  if (rev === 'HEAD' || SHA_RE.test(rev)) return true;
  return rev.startsWith('origin/') && isValidBranch(rev.slice('origin/'.length));
}

function validateRev(rev) {
  if (!revMatches(rev)) {
    return fail(REV_MESSAGE);
  }
  return { ok: true, value: rev };
}

function validateRange(range) {
  const expected = RANGE_MESSAGE;
  if (typeof range !== 'string') return fail(expected);
  const parts = range.split('..');
  if (parts.length !== 2 || !revMatches(parts[0]) || !revMatches(parts[1])) {
    return fail(expected);
  }
  return { ok: true, value: range, from: parts[0], to: parts[1] };
}

function validatePath(p) {
  const expected = 'The path parameter must be a relative path of up to 4096 characters, with segments separated by / that start with a letter, digit or _ and use only letters, digits, _, . and -.';
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LENGTH) return fail(expected);
  if (!p.split('/').every((seg) => SEGMENT_RE.test(seg))) return fail(expected);
  return { ok: true, value: p };
}

function validatePaths(ps) {
  if (ps === undefined) return { ok: true, value: [] };
  if (!Array.isArray(ps)) return fail('The paths parameter must be an array of relative paths.');
  if (ps.length > MAX_PATHS) return fail(`The paths parameter allows at most ${MAX_PATHS} paths.`);
  const value = [];
  for (const p of ps) {
    const res = validatePath(p);
    if (!res.ok) return fail(`The paths parameter contains an invalid path. ${res.reason}`);
    value.push(res.value);
  }
  return { ok: true, value };
}

// Patterns for the zod schema: a first barrier, looser than the validation above.
// argv.js stays authoritative (it validates with validateRev/validateRange).
const unanchored = (re) => re.source.replace(/^\^/, '').replace(/\$$/, '');
const REV_SOURCE = `(?:HEAD|${unanchored(SHA_RE)}|origin/${unanchored(BRANCH_RE)})`;
const PATH_PATTERN = new RegExp(`^${unanchored(SEGMENT_RE)}(?:/${unanchored(SEGMENT_RE)})*$`);
const REV_PATTERN = new RegExp(`^${REV_SOURCE}$`);
const RANGE_PATTERN = new RegExp(`^${REV_SOURCE}\\.\\.${REV_SOURCE}$`);

module.exports = { BRANCH_RE, isValidBranch, validateRev, validateRange, validatePath, validatePaths, REV_PATTERN, RANGE_PATTERN, PATH_PATTERN, REV_MESSAGE, RANGE_MESSAGE };
