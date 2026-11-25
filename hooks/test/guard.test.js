'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GUARD = path.join(__dirname, '..', 'guard.js');
const AGENT = 'rogue-heroku-ops:heroku-ops';
const APP = 'my-app';
const T = (t) => 'mcp__plugin_rogue-heroku-ops_heroku-ops__' + t;
const G = (t) => 'mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__' + t;
const CONFIG = {
  apps: [{ name: APP, healthUrl: 'https://my-app.herokuapp.com/health', deployBranch: 'main' }],
  n1Mode: 'ask',
};

function mkProject(config = CONFIG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-project-'));
  if (config !== null) {
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'rogue-heroku-ops.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}
const PROJECT = mkProject();

// project: undefined -> PROJECT; null -> CLAUDE_PROJECT_DIR unset. data: false -> CLAUDE_PLUGIN_DATA unset.
function run(input, { project, data } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-data-'));
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_PLUGIN_DATA;
  if (project !== null) env.CLAUDE_PROJECT_DIR = project === undefined ? PROJECT : project;
  if (data !== false) env.CLAUDE_PLUGIN_DATA = dataDir;
  const r = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env });
  return { ...r, dataDir, auditDir: path.join(dataDir, 'audit') };
}
const out = (r) => JSON.parse(r.stdout).hookSpecificOutput;
const call = (tool_name, tool_input, agent_type = AGENT) => JSON.stringify({ agent_type, tool_name, tool_input });
const bashPs = call('Bash', { command: `heroku ps -a ${APP}` });

const readLine = (r) => {
  const f = fs.readdirSync(r.auditDir)[0];
  const raw = fs.readFileSync(path.join(r.auditDir, f), 'utf8');
  return { raw, line: JSON.parse(raw.trim()) };
};
const sha16 = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 16);

test('stdin not JSON -> deny, exit 0', () => {
  const r = run('not json');
  assert.equal(r.status, 0);
  const o = out(r);
  assert.equal(o.hookEventName, 'PreToolUse');
  assert.equal(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /guard: internal error, blocked for safety/);
});

test('guard.js end-to-end: CLAUDE_PROJECT_DIR unset -> deny JSON on stdout, exit 0', () => {
  const r = run(call(T('ps_list'), { app: APP }), { project: null });
  assert.equal(r.status, 0);
  assert.equal(out(r).permissionDecision, 'deny');
  assert.match(out(r).permissionDecisionReason, /rogue-heroku-ops:setup/);
});

test('missing config file -> deny with the setup hint, exit 0', () => {
  const r = run(call(T('ps_list'), { app: APP }), { project: mkProject(null) });
  assert.equal(r.status, 0);
  assert.equal(out(r).permissionDecision, 'deny');
  assert.match(out(r).permissionDecisionReason, /rogue-heroku-ops:setup/);
});

test('invalid config (bad JSON, unknown key, sqlRewrite) -> deny', () => {
  for (const config of ['{nope', { ...CONFIG, sqlRewrite: true }, { ...CONFIG, extra: 1 }, { apps: [] }]) {
    const r = run(call(T('ps_list'), { app: APP }), { project: mkProject(config) });
    assert.equal(out(r).permissionDecision, 'deny', JSON.stringify(config));
  }
});

test('config not ok: get_config from the agent is allowed', () => {
  const r = run(call(G('get_config'), {}), { project: mkProject(null) });
  assert.equal(out(r).permissionDecision, 'allow');
});

test('Read from the main session -> no output, exit 0, no audit', () => {
  const r = run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(r.auditDir), false);
});

test('plugin tool from the main session -> deny with the agent hint', () => {
  const r = run(call(T('ps_list'), { app: APP }, null));
  assert.equal(out(r).permissionDecision, 'deny');
  assert.equal(out(r).permissionDecisionReason, 'Use the rogue-heroku-ops:heroku-ops agent for Heroku operations.');
});

test('agent Read of .env inside the project -> deny', () => {
  const r = run(call('Read', { file_path: path.join(PROJECT, '.env') }));
  assert.equal(out(r).permissionDecision, 'deny');
  const ok = run(call('Read', { file_path: path.join(PROJECT, 'pom.xml') }));
  assert.equal(out(ok).permissionDecision, 'allow');
});

test('valid config: allowed MCP tool -> allow, and a decision line is audited', () => {
  const r = run(call(G('git_log'), { app: APP, rev: 'HEAD' }));
  assert.equal(r.status, 0);
  assert.equal(out(r).permissionDecision, 'allow');
  const files = fs.readdirSync(r.auditDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^audit-\d{4}-\d{2}\.jsonl$/);
  const { line } = readLine(r);
  assert.equal(line.kind, 'decision');
  assert.equal(line.agent_type, AGENT);
  assert.equal(line.tool, G('git_log'));
  assert.equal(line.decision, 'allow');
  assert.equal(line.level, 'N0');
});

test('without CLAUDE_PLUGIN_DATA the guard still decides and writes no file', () => {
  const r = run(call(G('git_log'), { app: APP, rev: 'HEAD' }), { data: false });
  assert.equal(r.status, 0);
  assert.equal(out(r).permissionDecision, 'allow');
  assert.equal(fs.readdirSync(r.dataDir).length, 0);
});

test('Bash from the agent is denied', () => {
  const r = run(bashPs);
  assert.equal(out(r).permissionDecision, 'deny');
  assert.match(out(r).permissionDecisionReason, /Bash/);
});

test('updatedInput is returned for pg_psql', () => {
  const r = run(call(T('pg_psql'), { app: APP, command: 'SELECT 1' }));
  const o = out(r);
  assert.equal(o.permissionDecision, 'allow');
  assert.equal(o.updatedInput.command, 'BEGIN TRANSACTION READ ONLY; SELECT 1; ROLLBACK;');
});

test('git ref to an invalid remote branch name -> deny in the guard', () => {
  const r = run(call(G('git_log'), { app: APP, range: 'origin/main..origin/-x' }));
  assert.equal(out(r).permissionDecision, 'deny');
  assert.match(out(r).permissionDecisionReason, /valid remote branch name/);
});

test('decision line of a denied MCP pg_psql keeps agent_type and a redacted input', () => {
  const sql = "SELECT 1; DELETE FROM u WHERE email = 'secret@x.com'";
  const r = run(call(T('pg_psql'), { app: APP, command: sql }));
  assert.equal(out(r).permissionDecision, 'deny');
  const { raw, line } = readLine(r);
  assert.ok(!raw.includes('secret@x.com'), 'literal in clear in the audit log');
  assert.equal(line.kind, 'decision');
  assert.equal(line.agent_type, AGENT);
  assert.equal(typeof line.input, 'string');
  assert.ok(line.input.includes("email = '?'"), line.input);
  assert.ok(line.input.includes('DELETE FROM u'), line.input);
});

test('decision line of a denied shell command holds only exe, sub, length and sha256', () => {
  const REPO = 'git -C "/home/dev/project" ';
  const psqlDeny = `export PATH="/usr/lib/postgresql/16/bin:$PATH"; heroku pg:psql -c "SELECT 1; DELETE FROM u WHERE email = 'MRK9x@x.com'" -a ${APP}`;
  const cases = [
    [`heroku config:set DB_PASSWORD=MRK9xValor -a ${APP}`, 'heroku', 'config:set'],
    [`${REPO}diff -p../MRK9x src`, 'git', '[other]'],
    [`${REPO}diff -pO/etc/MRK9x`, 'git', '[other]'],
    [`${REPO}show HEAD:../MRK9x`, 'git', '[other]'],
    [`${REPO}diff X = "MRK9x"`, 'git', '[other]'],
    ['DB_PASSWORD=MRK9x heroku ps', '[other]', 'heroku'],
    [psqlDeny, 'export', '[other]'],
  ];
  for (const tool_name of ['Bash', 'PowerShell']) {
    for (const [command, exe, sub] of cases) {
      const r = run(call(tool_name, { command }));
      assert.equal(out(r).permissionDecision, 'deny', command);
      const { raw, line } = readLine(r);
      assert.ok(!raw.includes('MRK9x'), `${tool_name}: denied command text in the audit log: ${raw}`);
      assert.equal(line.kind, 'decision');
      assert.equal(line.decision, 'deny');
      assert.deepEqual(line.input, { exe, sub, length: command.length, sha256: sha16(command) });
    }
  }
});

test('gaps backup_capture with n1Mode deny -> deny, level N1', () => {
  const project = mkProject({ ...CONFIG, n1Mode: 'deny' });
  const r = run(call(G('backup_capture'), { app: APP }), { project });
  assert.equal(out(r).permissionDecision, 'deny');
  assert.equal(readLine(r).line.level, 'N1');
});

test('n1Mode defaults to ask when the config omits it', () => {
  const project = mkProject({ apps: CONFIG.apps });
  const r = run(call(T('ps_restart'), { app: APP }), { project });
  assert.equal(out(r).permissionDecision, 'ask');
});

test('300 000-character command: denied, bounded decision line, in Bash, PowerShell and MCP', () => {
  const big = 'heroku ' + 'a=b '.repeat(75000);
  for (const [tool_name, tool_input] of [
    ['Bash', { command: big }],
    ['PowerShell', { command: big }],
    [T('pg_psql'), { app: APP, command: 'SELECT ' + 'x'.repeat(300000) }],
  ]) {
    const t0 = Date.now();
    const r = run(call(tool_name, tool_input));
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
  const configResult = { ok: true, config: CONFIG, file: null };
  const big = 'git ' + 'a=b '.repeat(75000);
  for (const tool_name of ['Bash', 'PowerShell', T('pg_psql')]) {
    const t0 = process.hrtime.bigint();
    const d = evaluate({ agent_type: AGENT, tool_name, tool_input: { app: APP, command: big } }, configResult, PROJECT);
    summarizeDeniedCommand(big);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(d.decision, 'deny');
    assert.ok(ms < 200, `${tool_name}: ${ms} ms`);
  }
});

test('decision line summarizes non-shell input and redacts secret-like keys', () => {
  const r = run(call(T('ps_list'), { app: APP, token: 'abc' }));
  const { line } = readLine(r);
  assert.equal(line.agent_type, AGENT);
  assert.deepEqual(line.input, { app: APP, token: '[redacted]' });
});

test('decision line of a call without agent_type records null', () => {
  const r = run(call(T('ps_list'), { app: APP }, null));
  assert.equal(readLine(r).line.agent_type, null);
});

test('module load failure (no lib/) -> deny, exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-nolib-'));
  const copy = path.join(dir, 'guard.js');
  fs.copyFileSync(GUARD, copy);
  const r = spawnSync(process.execPath, [copy], {
    input: bashPs,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT, CLAUDE_PLUGIN_DATA: path.join(dir, 'data') },
  });
  assert.equal(r.status, 0);
  assert.equal(out(r).permissionDecision, 'deny');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PowerShell pg:psql is denied (no rewrite, no updatedInput)', () => {
  const command = `heroku pg:psql -c "SELECT 1" -a ${APP}`;
  const r = run(call('PowerShell', { command, timeout: 300000 }));
  const o = out(r);
  assert.equal(o.permissionDecision, 'deny');
  assert.equal(o.updatedInput, undefined);
});

test('main-session non-plugin tools exit 0 with no stdout even without config (before loading anything)', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-noconfig-'));
  for (const tool of ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'Write', 'mcp__other__ps_list']) {
    for (const agent of [null, 'other:agent']) {
      const r = run(call(tool, { file_path: 'x', pattern: 'x', command: 'ls' }, agent), { project: empty });
      assert.equal(r.status, 0, tool);
      assert.equal(r.stdout, '', tool);
      assert.equal(fs.existsSync(r.auditDir), false, tool);
    }
  }
  // the plugin agent without config is still denied for Bash
  const agentBash = run(call('Bash', { command: 'ls' }), { project: empty });
  assert.equal(out(agentBash).permissionDecision, 'deny');
  // plugin tools from the main session are never early-exited
  const plug = run(call(T('ps_list'), { app: APP }, null), { project: empty });
  assert.equal(out(plug).permissionDecision, 'deny');
  const gaps = run(call(G('get_config'), {}, null), { project: empty });
  assert.equal(out(gaps).permissionDecision, 'deny');
  const garbage = run('not json', { project: empty });
  assert.equal(out(garbage).permissionDecision, 'deny');
});

test('main-session Bash/Write exit 0 with no stdout and no audit even when lib/ cannot load', () => {
  // copy guard.js alone into a temp dir with no lib/: any require would fail and deny
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-nolib-'));
  const g = path.join(dir, 'guard.js');
  fs.copyFileSync(GUARD, g);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-nolib-data-'));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  for (const tool of ['Bash', 'Write', 'mcp__other__ps_list']) {
    const r = spawnSync(process.execPath, [g], { input: call(tool, { command: 'ls' }, null), encoding: 'utf8', env });
    assert.equal(r.status, 0, tool);
    assert.equal(r.stdout, '', tool);
  }
  assert.deepEqual(fs.readdirSync(data), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent Write, Agent, bash, Monitor and a foreign MCP are denied and audited without free text in clear', () => {
  const cases = [
    ['Write', { file_path: 'x', content: 'HRKU-secret-abc' }, 'HRKU-secret-abc'],
    ['Agent', { prompt: 'run cat .env' }, 'cat .env'],
    ['mcp__other__ps_list', { file_path: 'x' }, null],
    ['mcp__other__run', { command: 'cat .env' }, 'cat .env'],
    ['bash', { command: 'cat .env' }, 'cat .env'],
    ['Monitor', { command: 'heroku config:get DATABASE_URL -a myapp' }, 'DATABASE_URL'],
  ];
  for (const [tool, input, secret] of cases) {
    const r = run(call(tool, input));
    assert.equal(out(r).permissionDecision, 'deny', tool);
    const { raw, line } = readLine(r);
    assert.equal(line.decision, 'deny', tool);
    if (secret) assert.ok(!raw.includes(secret), tool + ' stored in clear: ' + raw);
  }
});

test('agent ToolSearch -> no output, exit 0, no audit', () => {
  const r = run(call('ToolSearch', { query: 'x' }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(r.auditDir), false);
});

test('main-session call without an agent_type key -> exit 0, no output', () => {
  const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(r.auditDir), false);
});

test('guard.js early-exit literals match policy.js', () => {
  const src = fs.readFileSync(GUARD, 'utf8');
  const policy = require('../lib/policy.js');
  for (const lit of [policy.PLUGIN_AGENT, policy.MCP_PREFIX, policy.GAPS_PREFIX]) assert.ok(src.includes(`'${lit}'`), lit);
});
