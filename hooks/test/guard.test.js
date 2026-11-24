'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GUARD = path.join(__dirname, '..', 'guard.js');
const APP = 'my-app';
// Fixture config (the plugin config location is introduced in a later task).
const FIXTURE = {
  apps: [APP],
  healthUrl: 'https://my-app.herokuapp.com/actuator/health',
  repoPath: 'C:\\Users\\dev\\project',
  deployBranch: 'releaseCandidate',
  postgresBin: 'C:\\Program Files\\PostgreSQL\\18\\bin',
  n1Mode: 'ask',
  sqlRewrite: true,
};
const FIXTURE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fixture-')), 'config.json');
fs.writeFileSync(FIXTURE_PATH, JSON.stringify(FIXTURE));

function run(input, { args = [], env = {} } = {}) {
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-audit-'));
  const r = spawnSync('node', [GUARD, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HEROKU_OPS_CONFIG: FIXTURE_PATH, HEROKU_OPS_AUDIT_DIR: auditDir, ...env },
  });
  return { ...r, auditDir };
}
const out = (r) => JSON.parse(r.stdout).hookSpecificOutput;
const bashPs = JSON.stringify({ tool_name: 'Bash', tool_input: { command: `heroku ps -a ${APP}` } });

test('stdin not JSON -> deny, exit 0', () => {
  const r = run('not json');
  assert.equal(r.status, 0);
  const o = out(r);
  assert.equal(o.hookEventName, 'PreToolUse');
  assert.equal(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /guarda: error interno, se bloquea por seguridad/);
});

test('missing config file -> deny, exit 0', () => {
  const r = run(bashPs, { env: { HEROKU_OPS_CONFIG: path.join(os.tmpdir(), 'no-such-config.json') } });
  assert.equal(r.status, 0);
  assert.equal(out(r).permissionDecision, 'deny');
});

test('invalid config JSON -> deny', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cfg-'));
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, '{nope');
  const r = run(bashPs, { env: { HEROKU_OPS_CONFIG: f } });
  assert.equal(out(r).permissionDecision, 'deny');
});

test('fixture config: allowed MCP tool -> allow, and a decision line is audited', () => {
  const r = run(JSON.stringify({ tool_name: 'mcp__heroku-ops-gaps__git_log', tool_input: { rev: 'HEAD' } }));
  assert.equal(r.status, 0);
  assert.equal(out(r).permissionDecision, 'allow');
  const files = fs.readdirSync(r.auditDir);
  assert.equal(files.length, 1);
  const line = JSON.parse(fs.readFileSync(path.join(r.auditDir, files[0]), 'utf8').trim());
  assert.equal(line.kind, 'decision');
  assert.equal(line.tool, 'mcp__heroku-ops-gaps__git_log');
  assert.equal(line.decision, 'allow');
  assert.equal(line.level, 'N0');
});

test('fixture config: Bash is denied', () => {
  const r = run(bashPs);
  assert.equal(out(r).permissionDecision, 'deny');
  assert.match(out(r).permissionDecisionReason, /Bash/);
});

test('updatedInput is returned for pg_psql', () => {
  const r = run(JSON.stringify({ tool_name: 'mcp__heroku-ops__pg_psql', tool_input: { app: APP, command: 'SELECT 1' } }));
  const o = out(r);
  assert.equal(o.permissionDecision, 'allow');
  assert.equal(o.updatedInput.command, 'BEGIN TRANSACTION READ ONLY; SELECT 1; ROLLBACK;');
});

const readLine = (r) => {
  const f = fs.readdirSync(r.auditDir)[0];
  const raw = fs.readFileSync(path.join(r.auditDir, f), 'utf8');
  return { raw, line: JSON.parse(raw.trim()) };
};
const sha16 = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 16);

test('decision line of a denied MCP pg_psql keeps agent_type and a redacted input', () => {
  const sql = "SELECT 1; DELETE FROM u WHERE email = 'secreto@x.com'";
  const r = run(JSON.stringify({ agent_type: 'heroku-ops', tool_name: 'mcp__heroku-ops__pg_psql', tool_input: { app: APP, command: sql } }));
  assert.equal(out(r).permissionDecision, 'deny');
  const { raw, line } = readLine(r);
  assert.ok(!raw.includes('secreto@x.com'), 'literal in clear in the audit log');
  assert.equal(line.kind, 'decision');
  assert.equal(line.agent_type, 'heroku-ops');
  assert.equal(typeof line.input, 'string');
  assert.ok(line.input.includes("email = '?'"), line.input);
  assert.ok(line.input.includes('DELETE FROM u'), line.input);
});

test('decision line of a denied shell command holds only exe, sub, length and sha256', () => {
  const REPO = 'git -C "C:\\Users\\dev\\project" ';
  const psqlDeny = `$env:Path = "C:\\Program Files\\PostgreSQL\\18\\bin;" + $env:Path; heroku pg:psql -c "SELECT 1; DELETE FROM u WHERE email = 'MRK9x@x.com'" -a ${APP}`;
  const cases = [
    [`heroku config:set DB_PASSWORD=MRK9xValor -a ${APP}`, 'heroku', 'config:set'],
    [`${REPO}diff -p../MRK9x src`, 'git', '[otro]'],
    [`${REPO}diff -pO/etc/MRK9x`, 'git', '[otro]'],
    [`${REPO}show HEAD:../MRK9x`, 'git', '[otro]'],
    [`${REPO}diff X = "MRK9x"`, 'git', '[otro]'],
    ['DB_PASSWORD=MRK9x heroku ps', '[otro]', 'heroku'],
    [psqlDeny, '[otro]', '[otro]'],
  ];
  for (const tool_name of ['Bash', 'PowerShell']) {
    for (const [command, exe, sub] of cases) {
      const r = run(JSON.stringify({ agent_type: 'heroku-ops', tool_name, tool_input: { command } }));
      assert.equal(out(r).permissionDecision, 'deny', command);
      const { raw, line } = readLine(r);
      assert.ok(!raw.includes('MRK9x'), `${tool_name}: denied command text in the audit log: ${raw}`);
      assert.equal(line.kind, 'decision');
      assert.equal(line.decision, 'deny');
      assert.deepEqual(line.input, { exe, sub, length: command.length, sha256: sha16(command) });
    }
  }
});

test('gaps backup_capture with n1Mode deny -> deny', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cfg-'));
  const f = path.join(dir, 'c.json');
  const real = FIXTURE;
  fs.writeFileSync(f, JSON.stringify({ ...real, n1Mode: 'deny' }));
  const r = run(JSON.stringify({ tool_name: 'mcp__heroku-ops-gaps__backup_capture', tool_input: { app: APP } }), { env: { HEROKU_OPS_CONFIG: f } });
  assert.equal(out(r).permissionDecision, 'deny');
  assert.equal(readLine(r).line.level, 'N1');
});

test('300 000-character command: denied, bounded decision line, in Bash, PowerShell and MCP', () => {
  const big = 'heroku ' + 'a=b '.repeat(75000);
  for (const [tool_name, tool_input] of [
    ['Bash', { command: big }],
    ['PowerShell', { command: big }],
    ['mcp__heroku-ops__pg_psql', { app: APP, command: 'SELECT ' + 'x'.repeat(300000) }],
  ]) {
    const t0 = Date.now();
    const r = run(JSON.stringify({ tool_name, tool_input }));
    assert.ok(Date.now() - t0 < 5000, `${tool_name}: guard took ${Date.now() - t0} ms`);
    assert.equal(out(r).permissionDecision, 'deny');
    const { raw, line } = readLine(r);
    assert.ok(raw.length < 1000, `${tool_name}: decision line too long (${raw.length})`);
    assert.equal(line.input.length, tool_input.command.length);
  }
});

test('in-process: evaluate + deny summary of 300 000 characters take less than 200 ms', () => {
  const { evaluate } = require('../lib/evaluate.js');
  const { summarizeDeniedCommand } = require('../lib/audit-entry.js');
  const config = FIXTURE;
  const big = 'git ' + 'a=b '.repeat(75000);
  for (const tool_name of ['Bash', 'PowerShell', 'mcp__heroku-ops__pg_psql']) {
    const t0 = process.hrtime.bigint();
    const d = evaluate({ tool_name, tool_input: { app: APP, command: big } }, config, path.join(__dirname, '..', '..'));
    summarizeDeniedCommand(big);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(d.decision, 'deny');
    assert.ok(ms < 200, `${tool_name}: ${ms} ms`);
  }
});

test('decision line summarizes non-shell input and redacts secret-like keys', () => {
  const r = run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'C:\\x', token: 'abc' } }));
  const f = fs.readdirSync(r.auditDir)[0];
  const line = JSON.parse(fs.readFileSync(path.join(r.auditDir, f), 'utf8').trim());
  assert.equal(line.agent_type, null);
  assert.deepEqual(line.input, { file_path: 'C:\\x', token: '[redacted]' });
});

test('--only-agent: other agent_type -> empty stdout, exit 0, no audit', () => {
  const r = run(JSON.stringify({ agent_type: 'other', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
    { args: ['--only-agent', 'heroku-ops'] });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.readdirSync(r.auditDir).length, 0);
});

test('--only-agent: matching agent_type is evaluated', () => {
  const r = run(JSON.stringify({ agent_type: 'heroku-ops', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
    { args: ['--only-agent', 'heroku-ops'] });
  assert.equal(out(r).permissionDecision, 'deny');
});

test('module load failure (no lib/) -> deny, exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-nolib-'));
  const copy = path.join(dir, 'guard.js');
  fs.copyFileSync(GUARD, copy);
  const r = spawnSync('node', [copy], {
    input: bashPs,
    encoding: 'utf8',
    env: { ...process.env, HEROKU_OPS_AUDIT_DIR: path.join(dir, 'audit') },
  });
  assert.equal(r.status, 0);
  assert.equal(out(r).permissionDecision, 'deny');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--only-agent without value or followed by a flag -> deny, exit 0', () => {
  for (const args of [['--only-agent'], ['--only-agent', '--other']]) {
    const r = run(bashPs, { args });
    assert.equal(r.status, 0);
    assert.equal(out(r).permissionDecision, 'deny');
  }
});

test('PowerShell pg:psql is denied (no rewrite, no updatedInput)', () => {
  const command = `heroku pg:psql -c "SELECT 1" -a ${APP}`;
  const r = run(JSON.stringify({ tool_name: 'PowerShell', tool_input: { command, timeout: 300000 } }));
  const o = out(r);
  assert.equal(o.permissionDecision, 'deny');
  assert.equal(o.updatedInput, undefined);
});
