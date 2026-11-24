'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReadOnlySql, wrapReadOnly, unwrapReadOnly, redactSql } = require('../lib/sql.js');

const OK = [
  'SELECT 1',
  'select version, description, success from flyway_schema_history order by installed_rank desc limit 20;',
  'WITH x AS (SELECT 1) SELECT * FROM x',
  'EXPLAIN SELECT 1',
  'SHOW server_version',
  "SELECT 'drop table x'",
  "SELECT 'a;b' AS x",
  "SELECT 'it''s -- not a comment'",
  "SELECT '/* nope */' , 2 -- real comment",
  'SELECT 1 /* a */ , /* b */ 2',
  'SELECT 1 /* a /* nested */ still */',
  "SELECT 'x' FROM t WHERE created_at > now()",
  'SELECT query, calls, total_exec_time FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 3',
  'SELECT query, calls, total_exec_time FROM pg_stat_statements WHERE userid = (SELECT oid FROM pg_roles WHERE rolname = current_user) ORDER BY total_exec_time DESC LIMIT 3',
];

const NOT_OK = [
  '',
  '   ',
  '-- comment only',
  'SELECT 1; DELETE FROM t',
  'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
  'EXPLAIN ANALYZE DELETE FROM t',
  'EXPLAIN (ANALYZE) SELECT 1',
  'EXPLAIN (ANALYSE) SELECT 1',
  'EXPLAIN (VERBOSE, ANALYZE true) SELECT 1',
  '/* x */ UPDATE t SET a=1',
  'SELECT 1 -- \n; DROP TABLE t',
  '\\! dir',
  'SELECT pg_terminate_backend(123)',
  "SELECT set_config('a','b',false)",
  "SELECT lo_import('x')",
  'SELECT $$x$$',
  'SELECT "Col" FROM t',
  'UPDATE t SET a = 1',
  'VACUUM',
  // bypass attempts
  'SELECT 1 /* unterminated',
  "SELECT 'unterminated",
  'SELECT 1 /* a /* nested */ ; DELETE FROM t',
  'SeLeCt 1; DeLeTe FROM t',
  'DeLeTe FROM t',
  'SELECT $a$ \' $a$; DELETE FROM t; --\'',
  'SELECT 1;;',
  'SELECT 1; ; ',
  '(SELECT 1)',
  'SELECT * INTO t2 FROM t',
  'SELECT * FROM t FOR UPDATE',
  'SELECT pg_catalog.set_config(\'a\',\'b\',false)',
  "SELECT SET_CONFIG ('a','b',false)",
  "SELECT nextval('s')",
  "SELECT setval('s', 1)",
  "SELECT pg_read_file('/etc/passwd')",
  "SELECT pg_ls_dir('.')",
  "SELECT dblink_exec('x','y')",
  "SELECT pg_write_something(1)",
  'SELECT pg_stat_statements_reset()',
  'SELECT PG_STAT_STATEMENTS_RESET ()',
  'SELECT pg_try_advisory_lock(1)',
  'SELECT pg_try_advisory_xact_lock_shared(1)',
  'SELECT pg_sleep(10)',
  "SELECT pg_sleep_for('1 hour')",
  "SELECT pg_cancel_backend(1)",
  "SELECT query_to_xml('delete from t', true, true, '')",
  'COMMIT',
  'ROLLBACK; SELECT 1',
  'SELECT 1; COMMIT',
  'DO $$ BEGIN END $$',
  'SELECT 1 -- x\r; DROP TABLE t',
  'COPY t TO STDOUT',
  'SET ROLE x',
  'CALL p()',
  'GRANT ALL ON t TO u',
  'TRUNCATE t',
  'ALTER TABLE t ADD c int',
  'CREATE TABLE t (a int)',
  'INSERT INTO t VALUES (1)',
  'MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE',
  'LOCK TABLE t',
  'REINDEX TABLE t',
  'BEGIN',
  'REVOKE ALL ON t FROM u',
  'DROP TABLE t',
];

for (const sql of OK) {
  test(`ok: ${JSON.stringify(sql)}`, () => {
    const r = validateReadOnlySql(sql);
    assert.equal(r.ok, true, r.reason);
    assert.equal(typeof r.statement, 'string');
  });
}

for (const sql of NOT_OK) {
  test(`no ok: ${JSON.stringify(sql)}`, () => {
    const r = validateReadOnlySql(sql);
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
    assert.equal(r.statement, undefined);
  });
}

test('no string input is rejected', () => {
  for (const v of [undefined, null, 5, {}, []]) {
    assert.equal(validateReadOnlySql(v).ok, false);
  }
});

test('statement is normalized', () => {
  const r = validateReadOnlySql("  SELECT   1 -- c\n  /* x */ ,  'a  b'  ;  ");
  assert.equal(r.ok, true);
  assert.equal(r.statement, "SELECT 1 , 'a  b'");
});

test('wrapReadOnly / unwrapReadOnly', () => {
  const w = wrapReadOnly('SELECT 1');
  assert.equal(w, 'BEGIN TRANSACTION READ ONLY; SELECT 1; ROLLBACK;');
  assert.equal(unwrapReadOnly(w), 'SELECT 1');
  assert.equal(unwrapReadOnly('SELECT 1'), null);
  assert.equal(unwrapReadOnly('BEGIN TRANSACTION READ ONLY; SELECT 1;'), null);
  assert.equal(unwrapReadOnly('BEGIN TRANSACTION READ ONLY; ; ROLLBACK;'), null);
  assert.equal(unwrapReadOnly(null), null);
  assert.equal(
    unwrapReadOnly('BEGIN TRANSACTION READ ONLY; SELECT 1; COMMIT; DELETE FROM t; ROLLBACK;'),
    null,
  );
  assert.equal(validateReadOnlySql("SELECT pg_file_write('x','y',false)").ok, false);
});

test('redactSql', () => {
  assert.equal(
    redactSql("SELECT * FROM users WHERE email = 'a@b.c' AND id = 42"),
    "SELECT * FROM users WHERE email = '?' AND id = ?"
  );
  assert.equal(redactSql("SELECT 'it''s', t1.col12 FROM t1 WHERE x = 3.5"), "SELECT '?', t1.col12 FROM t1 WHERE x = ?");
  assert.equal(redactSql("SELECT 'unclosed 123"), "SELECT '?'");
});
