'use strict';

const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$/;
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const MAX_PATH_LENGTH = 4096;
const MAX_PATHS = 20;

const REV_MESSAGE = 'El parámetro rev debe ser HEAD, origin/<rama de despliegue> o un SHA hexadecimal de 7 a 40 caracteres.';
const RANGE_MESSAGE = 'El parámetro range debe tener la forma REV..REV, con cada REV igual a HEAD, origin/<rama de despliegue> o un SHA hexadecimal de 7 a 40 caracteres.';

const fail = (reason) => ({ ok: false, reason });

function isValidBranch(deployBranch) {
  return typeof deployBranch === 'string' && BRANCH_RE.test(deployBranch);
}

function revMatches(rev, deployBranch) {
  if (typeof rev !== 'string') return false;
  if (rev === 'HEAD' || SHA_RE.test(rev)) return true;
  // Exact comparison against the validated branch: no regex built from config.
  return isValidBranch(deployBranch) && rev === `origin/${deployBranch}`;
}

function validateRev(rev, deployBranch) {
  if (!revMatches(rev, deployBranch)) {
    return fail(REV_MESSAGE);
  }
  return { ok: true, value: rev };
}

function validateRange(range, deployBranch) {
  const expected = RANGE_MESSAGE;
  if (typeof range !== 'string') return fail(expected);
  const parts = range.split('..');
  if (parts.length !== 2 || !revMatches(parts[0], deployBranch) || !revMatches(parts[1], deployBranch)) {
    return fail(expected);
  }
  return { ok: true, value: range, from: parts[0], to: parts[1] };
}

function validatePath(p) {
  const expected = 'El parámetro path debe ser una ruta relativa de hasta 4096 caracteres, con segmentos separados por / que empiecen por letra, número o _ y solo usen letras, números, _, . y -.';
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LENGTH) return fail(expected);
  if (!p.split('/').every((seg) => SEGMENT_RE.test(seg))) return fail(expected);
  return { ok: true, value: p };
}

function validatePaths(ps) {
  if (ps === undefined) return { ok: true, value: [] };
  if (!Array.isArray(ps)) return fail('El parámetro paths debe ser un arreglo de rutas relativas.');
  if (ps.length > MAX_PATHS) return fail(`El parámetro paths admite como máximo ${MAX_PATHS} rutas.`);
  const value = [];
  for (const p of ps) {
    const res = validatePath(p);
    if (!res.ok) return fail(`El parámetro paths contiene una ruta inválida. ${res.reason}`);
    value.push(res.value);
  }
  return { ok: true, value };
}

// Patrones para el esquema zod: primera barrera, más laxa que la validación de arriba.
// argv.js sigue siendo la validación autoritativa (compara origin/<deployBranch> exacto).
const unanchored = (re) => re.source.replace(/^\^/, '').replace(/\$$/, '');
const REV_SOURCE = `(?:HEAD|${unanchored(SHA_RE)}|origin/${unanchored(BRANCH_RE)})`;
const PATH_PATTERN = new RegExp(`^${unanchored(SEGMENT_RE)}(?:/${unanchored(SEGMENT_RE)})*$`);
const REV_PATTERN = new RegExp(`^${REV_SOURCE}$`);
const RANGE_PATTERN = new RegExp(`^${REV_SOURCE}\\.\\.${REV_SOURCE}$`);

module.exports = { BRANCH_RE, validateRev, validateRange, validatePath, validatePaths, REV_PATTERN, RANGE_PATTERN, PATH_PATTERN, REV_MESSAGE, RANGE_MESSAGE };
