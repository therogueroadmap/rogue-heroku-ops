'use strict';
// Pure module: read-only SQL validation (spec 6.5). When in doubt, reject.

const WRAP_PREFIX = 'BEGIN TRANSACTION READ ONLY; ';
const WRAP_SUFFIX = '; ROLLBACK;';

const FORBIDDEN_WORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE',
  'GRANT', 'REVOKE', 'COPY', 'CALL', 'DO', 'SET', 'LOCK', 'VACUUM', 'REINDEX',
  'COMMIT', 'ROLLBACK', 'BEGIN',
  // beyond the spec: SELECT ... INTO creates a table
  'INTO',
];

// Names matched as whole word followed by "(".
const EFFECT_FUNCTIONS = [
  'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND', 'PG_RELOAD_CONF', 'SET_CONFIG',
  'NEXTVAL', 'SETVAL', 'PG_READ_FILE', 'PG_READ_BINARY_FILE', 'PG_LS_DIR',
  'PG_STAT_STATEMENTS_RESET',
];
// Prefixes (spec: lo_, dblink, pg_write; extras: arbitrary-query and file/admin helpers).
const EFFECT_PREFIXES = [
  'LO_', 'DBLINK', 'PG_WRITE', 'QUERY_TO_XML', 'PG_LS_', 'PG_READ_', 'PG_STAT_FILE',
  'PG_ADVISORY', 'PG_SWITCH', 'PG_CREATE', 'PG_DROP', 'PG_PROMOTE', 'PG_ROTATE',
  'PG_LOGICAL', 'PG_REPLICATION', 'PG_STAT_RESET',
  'PG_FILE_',
  // advisory locks (pg_try_advisory_*) and pg_sleep* hold resources on the server
  'PG_TRY_ADVISORY', 'PG_SLEEP',
];

const FORBIDDEN_RE = new RegExp(`\\b(?:${FORBIDDEN_WORDS.join('|')})\\b`);
const EFFECT_FN_RE = new RegExp(`\\b(?:${EFFECT_FUNCTIONS.join('|')})\\s*\\(`);
const EFFECT_PREFIX_RE = new RegExp(`\\b(?:${EFFECT_PREFIXES.join('|')})\\w*\\s*\\(`);

const fail = (reason) => ({ ok: false, reason });

// Scans SQL respecting '...' literals ('' escape). Comments become a space.
// Returns { text, skeleton } (whitespace collapsed outside literals; skeleton has
// literals emptied to '') or null if a literal or block comment is unterminated.
function scan(sql) {
  let text = '';
  let skeleton = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return null;
      text += sql.slice(i, j + 1);
      skeleton += "''";
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      text += ' ';
      skeleton += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) return null;
      text += ' ';
      skeleton += ' ';
    } else {
      text += c;
      skeleton += c;
      i++;
    }
  }
  return { text, skeleton };
}

// Collapses whitespace runs outside literals to a single space.
function collapse(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (/\s/.test(s[i])) {
      while (i < s.length && /\s/.test(s[i])) i++;
      out += ' ';
    } else {
      out += s[i++];
    }
  }
  return out;
}

function validateReadOnlySql(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') return fail('SQL vacío.');
  if (sql.includes('\\')) return fail('El SQL contiene una barra invertida (comandos de psql o escapes).');
  // Rule 2 forbids "$$"; any "$" is rejected because tagged dollar quoting ($tag$...$tag$) would defeat the literal scan.
  if (sql.includes('$')) return fail('El SQL contiene "$" (dollar quoting no permitido).');
  if (sql.includes('"')) return fail('El SQL contiene comillas dobles (identificadores entrecomillados no permitidos).');

  const scanned = scan(sql);
  if (!scanned) return fail('Literal o comentario de bloque sin cerrar.');

  let statement = collapse(scanned.text).trim();
  let skeleton = collapse(scanned.skeleton).trim();
  if (skeleton.endsWith(';')) {
    statement = statement.slice(0, -1).trimEnd();
    skeleton = skeleton.slice(0, -1).trimEnd();
  }
  if (statement === '') return fail('SQL vacío tras quitar comentarios.');
  if (skeleton.includes(';')) return fail('Se permite una sola sentencia (se detectó ";" adicional).');

  const up = skeleton.toUpperCase();
  const first = /^[A-Z]+\b/.exec(up);
  if (!first || !['SELECT', 'WITH', 'EXPLAIN', 'SHOW'].includes(first[0])) {
    return fail('Solo se permiten sentencias que empiecen por SELECT, WITH, EXPLAIN o SHOW.');
  }
  if (first[0] === 'EXPLAIN' && /\bANALY[ZS]E\b/.test(up)) {
    return fail('EXPLAIN ANALYZE ejecuta la sentencia y no está permitido.');
  }
  const word = FORBIDDEN_RE.exec(up);
  if (word) return fail(`Palabra clave no permitida en SQL de solo lectura: ${word[0]}.`);
  if (EFFECT_FN_RE.test(up) || EFFECT_PREFIX_RE.test(up)) {
    return fail('El SQL llama a una función con efectos o acceso a archivos/conexiones.');
  }
  return { ok: true, statement };
}

function wrapReadOnly(statement) {
  return `${WRAP_PREFIX}${statement}${WRAP_SUFFIX}`;
}

function unwrapReadOnly(sql) {
  if (typeof sql !== 'string') return null;
  if (!sql.startsWith(WRAP_PREFIX) || !sql.endsWith(WRAP_SUFFIX)) return null;
  if (sql.length < WRAP_PREFIX.length + WRAP_SUFFIX.length) return null;
  const inner = sql.slice(WRAP_PREFIX.length, sql.length - WRAP_SUFFIX.length);
  const v = validateReadOnlySql(inner);
  return v.ok && v.statement === inner ? inner : null;
}

// Replaces '...' literals with '?' and bare numbers with ? (for the audit log).
function redactSql(sql) {
  if (typeof sql !== 'string') return '';
  const redactNumbers = (s) =>
    s.replace(/(?<![\w$.])\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?!\w)/g, '?');
  let out = '';
  let buf = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          closed = true;
          break;
        }
        j++;
      }
      out += redactNumbers(buf) + "'?'";
      buf = '';
      i = closed ? j + 1 : n;
    } else {
      buf += sql[i++];
    }
  }
  return out + redactNumbers(buf);
}

module.exports = { validateReadOnlySql, wrapReadOnly, unwrapReadOnly, redactSql };
