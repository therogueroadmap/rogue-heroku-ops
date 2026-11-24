'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildAuditEntry, summarizeDeniedCommand } = require('../lib/audit-entry.js');

const NOW = new Date('2026-11-23T10:20:30.000Z');
const AUDIT_JS = path.join(__dirname, '..', 'audit.js');
const T = 'mcp__plugin_rogue-heroku-ops_heroku-ops__';
const AGENT = 'rogue-heroku-ops:heroku-ops';

test('Bash pg:psql: SQL literals are redacted', () => {
  const e = buildAuditEntry({
    tool_name: 'Bash',
    agent_type: 'heroku-ops',
    tool_input: { command: `heroku pg:psql -c "SELECT * FROM u WHERE email = 'a@b.c' AND id = 42" -a my-app` },
  }, NOW);
  const s = JSON.stringify(e.input);
  assert.ok(s.includes("'?'"));
  assert.ok(!s.includes('a@b.c'));
  assert.ok(!s.includes('42'));
  assert.ok(s.includes('-a my-app'));
  assert.equal(e.tool, 'Bash');
  assert.equal(e.agent_type, 'heroku-ops');
});

test('entry records hook_event_name as event (null when absent)', () => {
  const a = buildAuditEntry({ tool_name: 'Bash', hook_event_name: 'PostToolUseFailure', tool_input: { command: 'x' } }, NOW);
  assert.equal(a.event, 'PostToolUseFailure');
  const b = buildAuditEntry({ tool_name: 'Bash', tool_input: { command: 'x' } }, NOW);
  assert.equal(b.event, null);
});

test('PowerShell pg:psql with single-quoted -c is redacted', () => {
  const e = buildAuditEntry({
    tool_name: 'PowerShell',
    tool_input: { command: `heroku pg:psql -c 'SELECT * FROM u WHERE email = ''a@b.c''' -a x` },
  }, NOW);
  assert.ok(!JSON.stringify(e.input).includes('a@b.c'));
});

test('pg:psql without parsable -c falls back to redacting the whole command', () => {
  const e = buildAuditEntry({
    tool_name: 'Bash',
    tool_input: { command: `heroku pg:psql -c "SELECT 'a@b.c` },
  }, NOW);
  assert.ok(!JSON.stringify(e.input).includes('a@b.c'));
});

test('non-psql Bash command is kept as is', () => {
  const e = buildAuditEntry({ tool_name: 'Bash', tool_input: { command: 'heroku releases -a my-app' } }, NOW);
  assert.equal(e.input, 'heroku releases -a my-app');
});

test('summarizeDeniedCommand: bounded fields only, never the command', () => {
  const crypto = require('node:crypto');
  for (const [cmd, exe, sub] of [
    ['heroku config:set DB_PASSWORD=s3cr3tValor -a my-app', 'heroku', 'config:set'],
    ['DB_PASSWORD=s3cr3tValor heroku ps', '[other]', 'heroku'],
    ['$env:X="s3cr3tValor"; heroku ps', '[other]', 'heroku'],
    ['git -C "C:\\repo" diff --output=s3cr3tValor', 'git', '[other]'],
    [`${'x'.repeat(100)} ${'y'.repeat(100)}s3cr3tValor`, '[other]', '[other]'],
  ]) {
    const s = summarizeDeniedCommand(cmd);
    assert.deepEqual(Object.keys(s).sort(), ['exe', 'length', 'sha256', 'sub']);
    assert.equal(s.exe, exe);
    assert.equal(s.sub, sub);
    assert.equal(s.length, cmd.length);
    assert.equal(s.sha256, crypto.createHash('sha256').update(cmd).digest('hex').slice(0, 16));
    assert.ok(!JSON.stringify(s).includes('s3cr3tValor'), cmd);
  }
});

test('summarizeDeniedCommand: Heroku-looking tokens (UUID, HRKU-) are stored as [other], no part of them', () => {
  const cases = [
    ['echo 0f3c2a1b-9d8e-4f7a-b6c5-1234567890ab', 'echo', '[other]', '0f3c2a1b-9d8e-4f7a-b6c5-1234567890ab'],
    ['HRKU-AAbbccddeeffgghhiijjkkllmmnnoopp x', '[other]', 'x', 'HRKU-AAbbccddeeffgghhiijjkkllmmnnoopp'],
  ];
  for (const [cmd, exe, sub, token] of cases) {
    const s = summarizeDeniedCommand(cmd);
    assert.equal(s.exe, exe, cmd);
    assert.equal(s.sub, sub, cmd);
    const serialized = JSON.stringify(s).toLowerCase();
    for (const seg of token.split('-').filter((p) => p.length >= 4)) {
      assert.ok(!serialized.includes(seg.toLowerCase()), `${seg} leaked: ${serialized}`);
    }
  }
});

test('summarizeDeniedCommand: legitimate command names keep their value', () => {
  const s = summarizeDeniedCommand('heroku config -a my-app');
  assert.equal(s.exe, 'heroku');
  assert.equal(s.sub, 'config');
  assert.equal(summarizeDeniedCommand('"C:\\tools\\heroku.cmd" config -a x').exe, 'heroku');
  assert.equal(summarizeDeniedCommand('"C:\\Program\\git.exe" log').exe, 'git');
});

test('summarizeDeniedCommand on 300 000 characters is fast', () => {
  const big = 'a=b '.repeat(75000);
  const t0 = process.hrtime.bigint();
  const s = summarizeDeniedCommand(big);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200);
  assert.equal(s.length, 300000);
});

test('allowed non-psql shell command is logged as is (closed forms, no ASSIGN redaction)', () => {
  const e = buildAuditEntry({ tool_name: 'Bash', tool_input: { command: 'git -C "C:\\repo" log --oneline -n 20 origin/releaseCandidate' } }, NOW);
  assert.equal(e.input, 'git -C "C:\\repo" log --oneline -n 20 origin/releaseCandidate');
});

test('mcp pg_psql command is redacted', () => {
  const e = buildAuditEntry({
    tool_name: T + 'pg_psql',
    tool_input: { app: 'x', command: "SELECT * FROM u WHERE email = 'a@b.c'" },
  }, NOW);
  assert.ok(JSON.stringify(e.input).includes("'?'"));
  assert.ok(!JSON.stringify(e.input).includes('a@b.c'));
});

test('secret-like keys are redacted, others kept', () => {
  const e = buildAuditEntry({
    tool_name: T + 'get_app_info',
    tool_input: { app: 'x', api_key: 'abc', DB_URL: 'postgres://u:p@h/d', Password: 'p', my_token: 't', secretX: 's' },
  }, NOW);
  assert.equal(e.input.app, 'x');
  for (const k of ['api_key', 'DB_URL', 'Password', 'my_token', 'secretX']) assert.equal(e.input[k], '[redacted]');
});

test('string values are truncated to 200 chars', () => {
  const e = buildAuditEntry({ tool_name: 'Read', tool_input: { file_path: 'a'.repeat(500) } }, NOW);
  assert.equal(e.input.file_path.length, 200);
});

test('error flag', () => {
  assert.equal(buildAuditEntry({ tool_name: 'X', tool_input: {}, tool_response: { is_error: true } }, NOW).error, true);
  assert.equal(buildAuditEntry({ tool_name: 'X', tool_input: {}, tool_response: { error: 'boom' } }, NOW).error, true);
  assert.equal(buildAuditEntry({ tool_name: 'X', tool_input: {}, tool_response: { stdout: 'ok' } }, NOW).error, false);
  assert.equal(buildAuditEntry({ tool_name: 'X', tool_input: {}, tool_response: 'text' }, NOW).error, false);
  assert.equal(buildAuditEntry({ tool_name: 'X', tool_input: {} }, NOW).error, false);
});

test('ts is ISO UTC and tool_response content is never stored', () => {
  const e = buildAuditEntry({ tool_name: 'X', tool_input: {}, tool_response: { stdout: 'SECRETOUTPUT' } }, NOW);
  assert.equal(e.ts, '2026-11-23T10:20:30.000Z');
  assert.ok(e.ts.endsWith('Z'));
  assert.ok(!JSON.stringify(e).includes('SECRETOUTPUT'));
});

test('missing fields are handled', () => {
  const e = buildAuditEntry({}, NOW);
  assert.equal(e.error, false);
  assert.equal(e.agent_type, null);
  assert.doesNotThrow(() => buildAuditEntry(null, NOW));
});

function runAudit(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const r = spawnSync(process.execPath, [AUDIT_JS], {
    input, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
  });
  return { r, dir };
}

test('audit.js appends one JSONL line, no stdout, exit 0', () => {
  const { r, dir } = runAudit(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'heroku releases' } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const files = fs.readdirSync(path.join(dir, 'audit'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^audit-\d{4}-\d{2}\.jsonl$/);
  const lines = fs.readFileSync(path.join(dir, 'audit', files[0]), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).tool, 'Bash');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit.js exits 0 with no stdout on invalid or empty stdin', () => {
  for (const input of ['not json', '', '{}']) {
    const { r, dir } = runAudit(input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit.js writes to CLAUDE_PLUGIN_DATA/audit/audit-YYYY-MM.jsonl with agent_type', () => {
  const { r, dir } = runAudit(JSON.stringify({ agent_type: AGENT, tool_name: T + 'ps_list', tool_input: { app: 'my-app' } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const month = new Date().toISOString().slice(0, 7);
  const file = path.join(dir, 'audit', `audit-${month}.jsonl`);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(entry.agent_type, AGENT);
  assert.equal(entry.tool, T + 'ps_list');
  assert.equal(entry.ts.slice(0, 7), month);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit.js without CLAUDE_PLUGIN_DATA -> exit 0, no output, no file written', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-nodata-'));
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_DATA;
  const r = spawnSync(process.execPath, [AUDIT_JS], {
    input: JSON.stringify({ agent_type: AGENT, tool_name: 'Read', tool_input: { file_path: 'x' } }),
    encoding: 'utf8', env, cwd,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.readdirSync(cwd).length, 0);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('auditFile: UTC month, null without a data dir', () => {
  const { auditFile } = require('../lib/audit-entry.js');
  assert.equal(auditFile({ CLAUDE_PLUGIN_DATA: path.join('d', 'x') }, '2026-12-31T23:59:59.000Z'),
    path.join('d', 'x', 'audit', 'audit-2026-12.jsonl'));
  assert.equal(auditFile({}, '2026-12-31T23:59:59.000Z'), null);
  assert.equal(auditFile({ CLAUDE_PLUGIN_DATA: '' }, '2026-12-31T23:59:59.000Z'), null);
});

test('PostToolUseFailure marks error true', () => {
  const e = buildAuditEntry({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'heroku ps -a my-app' },
  }, NOW);
  assert.equal(e.error, true);
});

test('root-level error field marks error true', () => {
  const e = buildAuditEntry({
    tool_name: T + 'ps_list',
    tool_input: { app: 'my-app' },
    error: 'boom',
  }, NOW);
  assert.equal(e.error, true);
});

test('successful PostToolUse keeps error false', () => {
  const e = buildAuditEntry({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'heroku ps -a my-app' },
    tool_response: { stdout: 'ok' },
  }, NOW);
  assert.equal(e.error, false);
});
