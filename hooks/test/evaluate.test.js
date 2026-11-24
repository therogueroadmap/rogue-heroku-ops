'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { evaluate } = require('../lib/evaluate.js');

const ROOT = path.join(__dirname, '..', '..');
const APP = 'my-app';
const cfg = (over = {}) => ({
  apps: [APP],
  healthUrl: 'https://my-app.herokuapp.com/actuator/health',
  repoPath: 'C:\\Users\\dev\\project',
  deployBranch: 'releaseCandidate',
  postgresBin: 'C:\\Program Files\\PostgreSQL\\18\\bin',
  n1Mode: 'ask',
  sqlRewrite: true,
  ...over,
});
const P = 'mcp__heroku-ops__';
const ev = (tool_name, tool_input, config = cfg()) => evaluate({ tool_name, tool_input }, config, ROOT);

test('MCP N0 with allowed app -> allow', () => {
  const d = ev(P + 'pg_info', { app: APP });
  assert.equal(d.decision, 'allow');
  assert.equal(d.level, 'N0');
});

test('MCP unlisted or N3 tools -> deny', () => {
  assert.equal(ev(P + 'get_app_info', { app: APP }).decision, 'deny');
  assert.equal(ev(P + 'new_tool', { app: APP }).decision, 'deny');
});

test('MCP input with other app -> deny', () => {
  assert.equal(ev(P + 'pg_info', { app: 'other' }).decision, 'deny');
});

test('MCP database with "::" (other app) -> deny', () => {
  const d = ev(P + 'pg_info', { app: APP, database: 'otra-app::DATABASE_URL' });
  assert.equal(d.decision, 'deny');
  assert.equal(ev(P + 'pg_backups', { app: APP, database: 'DATABASE_URL' }).decision, 'allow');
});

test('MCP N1 follows n1Mode, reason in Spanish', () => {
  const a = ev(P + 'ps_restart', { app: APP });
  assert.equal(a.decision, 'ask');
  assert.equal(a.level, 'N1');
  assert.match(a.reason, /reinicia los dynos; sin pérdida de datos/);
  assert.match(a.reason, new RegExp(APP));
  assert.equal(ev(P + 'ps_restart', { app: APP }, cfg({ n1Mode: 'deny' })).decision, 'deny');
  assert.match(ev(P + 'maintenance_on', { app: APP }).reason, /maintenance_off/);
  assert.match(ev(P + 'maintenance_off', { app: APP }).reason, /vuelve a servir tráfico/);
});

test('pg_psql: wraps SQL and keeps other fields', () => {
  const d = ev(P + 'pg_psql', { app: APP, command: 'SELECT 1' });
  assert.equal(d.decision, 'allow');
  assert.equal(d.updatedInput.command, 'BEGIN TRANSACTION READ ONLY; SELECT 1; ROLLBACK;');
  assert.equal(d.updatedInput.app, APP);
});

test('pg_psql: already wrapped SQL passes without rewrite', () => {
  const d = ev(P + 'pg_psql', { app: APP, command: 'BEGIN TRANSACTION READ ONLY; SELECT 1; ROLLBACK;' });
  assert.equal(d.decision, 'allow');
  assert.equal(d.updatedInput, undefined);
});

test('pg_psql: sqlRewrite=false and unwrapped -> deny', () => {
  assert.equal(ev(P + 'pg_psql', { app: APP, command: 'SELECT 1' }, cfg({ sqlRewrite: false })).decision, 'deny');
});

test('pg_psql: file or credential -> deny', () => {
  assert.equal(ev(P + 'pg_psql', { app: APP, command: 'SELECT 1', file: 'x.sql' }).decision, 'deny');
  assert.equal(ev(P + 'pg_psql', { app: APP, command: 'SELECT 1', credential: 'ro' }).decision, 'deny');
});

test('pg_psql: missing, non-string or empty command -> deny', () => {
  assert.equal(ev(P + 'pg_psql', { app: APP }).decision, 'deny');
  assert.equal(ev(P + 'pg_psql', { app: APP, command: 5 }).decision, 'deny');
  assert.equal(ev(P + 'pg_psql', { app: APP, command: '' }).decision, 'deny');
});

test('pg_psql: write SQL -> deny', () => {
  assert.equal(ev(P + 'pg_psql', { app: APP, command: 'DELETE FROM t' }).decision, 'deny');
});

test('pg_psql: non-ASCII, newline, backtick, $ and % -> deny', () => {
  for (const command of [
    'SELECT \u201Cx\u201D',
    'SELECT 1\nFROM t',
    'SELECT 1\r',
    'SELECT `x`',
    'SELECT $1',
    "SELECT 1 WHERE 'a' LIKE '%'",
  ]) {
    assert.equal(ev(P + 'pg_psql', { app: APP, command }).decision, 'deny', JSON.stringify(command));
  }
});

test('Read: secrets denied, inside ROOT allowed', () => {
  assert.equal(ev('Read', { file_path: 'C:\\Users\\dev\\.netrc' }).decision, 'deny');
  assert.equal(ev('Read', { file_path: path.join(ROOT, 'procedures', 'deploy.md') }).decision, 'allow');
  assert.equal(ev('Read', { file_path: path.join(ROOT, '..', '.credentials.json') }).decision, 'deny');
  assert.equal(ev('Read', { file_path: cfg().repoPath + '\\pom.xml' }).decision, 'allow');
});

test('Grep and Glob need a path inside the roots', () => {
  assert.equal(ev('Grep', { pattern: 'x' }).decision, 'deny');
  assert.equal(ev('Grep', { pattern: 'x', path: ROOT }).decision, 'allow');
  assert.equal(ev('Glob', { pattern: '*' }).decision, 'deny');
  assert.equal(ev('Glob', { pattern: '*', path: 'C:\\Users' }).decision, 'deny');
});

test('Glob pattern and Grep glob: any ".." or braces -> deny', () => {
  for (const pattern of ['..', '**/..', 'a..b/*', '..\\x', '{a,b}/*', '**/*.{js,md}', 'x}']) {
    assert.equal(ev('Glob', { pattern, path: ROOT }).decision, 'deny', pattern);
    assert.equal(ev('Grep', { pattern: 'x', path: ROOT, glob: pattern }).decision, 'deny', pattern);
  }
  assert.equal(ev('Glob', { pattern: '**/*.md', path: ROOT }).decision, 'allow');
  assert.equal(ev('Grep', { pattern: 'x', path: ROOT, glob: '*.js' }).decision, 'allow');
  // the Grep regex itself is not a path
  assert.equal(ev('Grep', { pattern: 'a{2}..b', path: ROOT }).decision, 'allow');
});

test('MCP get_addon_info: addon must be an attachment name', () => {
  assert.equal(ev(P + 'get_addon_info', { app: APP, addon: 'DATABASE' }).decision, 'allow');
  assert.equal(ev(P + 'get_addon_info', { app: APP, addon: 'HEROKU_POSTGRESQL_RED' }).decision, 'allow');
  for (const addon of [undefined, 5, '', 'database', 'postgresql-curly-12345', 'other-app::DATABASE', 'DATABASE_URL x']) {
    assert.equal(ev(P + 'get_addon_info', { app: APP, addon }).decision, 'deny', String(addon));
  }
});

test('other tools -> deny', () => {
  assert.equal(ev('WebFetch', { url: 'https://example.com' }).decision, 'deny');
  assert.equal(ev('Write', { file_path: path.join(ROOT, 'x') }).decision, 'deny');
});

test('Bash and PowerShell are always denied', () => {
  for (const t of ['Bash', 'PowerShell']) {
    const d = ev(t, { command: `heroku ps -a ${APP}` });
    assert.equal(d.decision, 'deny');
    assert.ok(d.reason.includes(t));
    assert.ok(d.reason.includes('no está permitido'), d.reason);
    assert.equal(ev(t, {}).decision, 'deny');
  }
});

const G = 'mcp__heroku-ops-gaps__';

test('gaps N0 tool -> allow N0', () => {
  const d = ev(G + 'git_log', { rev: 'HEAD' });
  assert.equal(d.decision, 'allow');
  assert.equal(d.level, 'N0');
  assert.equal(ev(G + 'health_check', {}).decision, 'allow');
  assert.equal(ev(G + 'releases_list', { app: APP, limit: 5 }).decision, 'allow');
});

test('gaps backup_capture follows n1Mode', () => {
  const a = ev(G + 'backup_capture', { app: APP });
  assert.equal(a.decision, 'ask');
  assert.equal(a.level, 'N1');
  assert.ok(a.reason.includes('crea un backup nuevo'), a.reason);
  assert.equal(ev(G + 'backup_capture', { app: APP }, cfg({ n1Mode: 'deny' })).decision, 'deny');
});

test('gaps unknown tool, extra keys, other app -> deny', () => {
  assert.equal(ev(G + 'git_push', {}).decision, 'deny');
  assert.equal(ev(G + 'git_log', { rev: 'HEAD', extra: 1 }).decision, 'deny');
  assert.equal(ev(G + 'git_log', { rev: 'HEAD', app: APP }).decision, 'deny');
  assert.equal(ev(G + 'backup_capture', { app: 'otra' }).decision, 'deny');
  assert.equal(ev('mcp__heroku-ops-gapsx__git_log', { rev: 'HEAD' }).decision, 'deny');
});

test('garbage hook input -> deny', () => {
  assert.equal(evaluate(null, cfg(), ROOT).decision, 'deny');
  assert.equal(evaluate({}, cfg(), ROOT).decision, 'deny');
  assert.equal(evaluate({ tool_name: 'Read' }, cfg(), ROOT).decision, 'deny');
});
