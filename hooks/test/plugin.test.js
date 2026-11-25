'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const policy = require('../lib/policy.js');
const { toolDefinitions } = require('../../mcp-gaps/lib/schemas.js');

const ROOT = path.join(__dirname, '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function parseAgent() {
  const text = fs.readFileSync(path.join(ROOT, 'agents', 'heroku-ops.md'), 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  assert.ok(m, 'agent has frontmatter');
  const keys = [...m[1].matchAll(/^([A-Za-z]+):/gm)].map((x) => x[1]);
  const line = /^tools: (.+)$/m.exec(m[1]);
  assert.ok(line, 'tools is a single comma-separated line');
  const tools = line[1].split(',').map((x) => x.trim());
  return { front: m[1], keys, tools, body: m[2], text };
}

const DEAD_TOOLS = ['pipelines_list', 'pipelines_info'];

test('agent tools = Read, Grep, Glob + every N0/N1 tool with plugin prefixes, no wildcards, no Bash/PowerShell', () => {
  const { tools } = parseAgent();
  const expected = [
    'Read', 'Grep', 'Glob',
    // pipelines_* stay in the guard list but are denied (they need no app), so the agent does not declare them.
    ...[...policy.MCP_N0, ...policy.MCP_N1].filter((t) => !DEAD_TOOLS.includes(t)).map((t) => policy.MCP_PREFIX + t),
    ...[...policy.GAPS_N0, ...policy.GAPS_N1].map((t) => policy.GAPS_PREFIX + t),
  ];
  assert.deepEqual([...tools].sort(), [...expected].sort());
  assert.equal(new Set(tools).size, tools.length);
  for (const t of tools) {
    assert.doesNotMatch(t, /\*/);
    assert.ok(!['Bash', 'PowerShell'].includes(t));
  }
});

test('agent frontmatter description is a quoted scalar (valid YAML)', () => {
  const { front } = parseAgent();
  const m = /^description: (.*)$/m.exec(front);
  assert.ok(m, 'description line');
  assert.match(m[1], /^"[^"]*"$/);
});

test('agent frontmatter has no hooks, mcpServers, permissionMode', () => {
  const { keys, front } = parseAgent();
  for (const k of ['hooks', 'mcpServers', 'permissionMode']) assert.ok(!keys.includes(k), k);
  assert.match(front, /^name: heroku-ops$/m);
  assert.match(front, /^model: sonnet$/m);
  assert.doesNotMatch(front, /^ {2}- /m);
});

test('agent prompt is generic: calls get_config and get_procedure, no fixed paths or app names', () => {
  const { text, body } = parseAgent();
  assert.match(body, /get_config/);
  assert.match(body, /get_procedure/);
  const banned = ['api' + 'transfer', 'mb' + 'sg', 'jr' + 'per', 'Money ' + 'Transfer', 'Claude ' + 'Projects'];
  for (const b of banned) assert.ok(!text.toLowerCase().includes(b.toLowerCase()), b);
  assert.doesNotMatch(text, /[A-Za-z]:\\/);
});

test('every gaps tool in schemas.js is classified in GAPS_N0 or GAPS_N1 and vice versa', () => {
  const names = Object.keys(toolDefinitions(null)).sort();
  const classified = [...policy.GAPS_N0, ...policy.GAPS_N1].sort();
  assert.deepEqual(names, classified);
});

test('hooks.json PreToolUse matcher is universal; PostToolUse matchers stay on plugin tools and Read|Grep|Glob', () => {
  const h = readJson('hooks/hooks.json').hooks;
  assert.equal(h.PreToolUse[0].matcher, '*');
  for (const ev of ['PostToolUse', 'PostToolUseFailure']) {
    const re = new RegExp(h[ev][0].matcher);
    assert.ok(re.test(policy.MCP_PREFIX + 'ps_list'), ev);
    assert.ok(re.test(policy.GAPS_PREFIX + 'get_config'), ev);
    for (const t of ['Read', 'Grep', 'Glob']) assert.ok(re.test(t), `${ev} ${t}`);
    for (const t of ['Bash', 'PowerShell', 'Write', 'mcp__other__ps_list']) assert.ok(!re.test(t), `${ev} ${t}`);
  }
  assert.equal(h.PostToolUseFailure[0].matcher, h.PostToolUse[0].matcher);
});

test('hooks.json hooks run node in exec form (no shell) with the script path in args', () => {
  const h = readJson('hooks/hooks.json').hooks;
  const pre = h.PreToolUse[0].hooks[0];
  assert.equal(pre.type, 'command');
  assert.equal(pre.command, 'node');
  assert.deepEqual(pre.args, ['${CLAUDE_PLUGIN_ROOT}/hooks/guard.js']);
  for (const ev of ['PostToolUse', 'PostToolUseFailure']) {
    assert.equal(h[ev][0].hooks[0].command, 'node', ev);
    assert.deepEqual(h[ev][0].hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/hooks/audit.js'], ev);
  }
});

test('hooks.json PreToolUse guard fails closed: onFailure "block" with a timeout', () => {
  const h = readJson('hooks/hooks.json').hooks;
  for (const entry of h.PreToolUse) {
    for (const hook of entry.hooks) {
      assert.equal(hook.onFailure, 'block', 'every PreToolUse hook must block when it fails, times out or cannot start');
      assert.ok(Array.isArray(hook.args), 'PreToolUse hooks must use exec form (args), not a shell');
      assert.equal(hook.timeout, 30);
    }
  }
});

test('hooks.json SessionStart installs dependencies into CLAUDE_PLUGIN_DATA', () => {
  const h = readJson('hooks/hooks.json').hooks;
  assert.equal(h.SessionStart[0].hooks[0].command, 'node');
  assert.deepEqual(h.SessionStart[0].hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/bin/install-deps.js']);
  assert.equal(h.SessionStart[0].hooks[0].onFailure, undefined);
});

test('.mcp.json: heroku-ops runs node bin/launch-official.js; heroku-ops-gaps env has CLAUDE_PROJECT_DIR and NODE_PATH', () => {
  const s = readJson('.mcp.json').mcpServers;
  assert.equal(s['heroku-ops'].command, 'node');
  assert.deepEqual(s['heroku-ops'].args, ['${CLAUDE_PLUGIN_ROOT}/bin/launch-official.js']);
  const g = s['heroku-ops-gaps'];
  assert.equal(g.command, 'node');
  assert.deepEqual(g.args, ['${CLAUDE_PLUGIN_ROOT}/mcp-gaps/server.js']);
  assert.equal(g.env.CLAUDE_PROJECT_DIR, '${CLAUDE_PROJECT_DIR}');
  assert.equal(g.env.CLAUDE_PLUGIN_ROOT, undefined);
  assert.equal(g.env.NODE_PATH, '${CLAUDE_PLUGIN_DATA}/node_modules');
});

test('guard.js and launch-official.js start from a plugin root with spaces in the path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug in-'));
  try {
    const root = path.join(tmp, 'plug in');
    for (const d of ['hooks', 'lib', 'bin', 'mcp-gaps']) {
      fs.cpSync(path.join(ROOT, d), path.join(root, d), {
        recursive: true,
        filter: (src) => path.basename(src) !== 'test',
      });
    }
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
    const project = path.join(tmp, 'my project');
    fs.mkdirSync(project);
    // Dependencies come from the repo node_modules through NODE_PATH, as in the data-dir pattern.
    const env = {
      ...process.env,
      NODE_PATH: path.join(ROOT, 'node_modules'),
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_PLUGIN_ROOT: root,
    };
    delete env.CLAUDE_PLUGIN_DATA;

    const hookInput = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: policy.MCP_PREFIX + 'ps_list',
      tool_input: { app: 'x' },
    });
    const g = spawnSync(process.execPath, [path.join(root, 'hooks', 'guard.js')], { env, input: hookInput, encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
    const out = JSON.parse(g.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /rogue-heroku-ops:heroku-ops/);

    const fake = path.join(tmp, 'nosession.js');
    fs.writeFileSync(fake, 'process.exit(1);');
    const l = spawnSync(process.execPath, [path.join(root, 'bin', 'launch-official.js')], {
      env: { ...env, HEROKU_OPS_TEST_HEROKU: fake },
      encoding: 'utf8',
    });
    assert.equal(l.status, 1);
    assert.match(l.stderr, /Run "heroku login" and restart Claude Code\./);
    assert.equal(l.stdout, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function setupJsonBlocks() {
  const md = fs.readFileSync(path.join(ROOT, 'skills', 'setup', 'SKILL.md'), 'utf8');
  return [...md.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
}

test('setup allow block = Agent(plugin agent) + every N0 tool, no N1', () => {
  const blocks = setupJsonBlocks().filter((b) => b.permissions && b.permissions.allow);
  assert.equal(blocks.length, 1);
  const allow = blocks[0].permissions.allow;
  assert.equal(new Set(allow).size, allow.length, 'no duplicates');
  const expected = new Set([
    `Agent(${policy.PLUGIN_AGENT})`,
    ...[...policy.MCP_N0].map((t) => policy.MCP_PREFIX + t),
    ...[...policy.GAPS_N0].map((t) => policy.GAPS_PREFIX + t),
  ]);
  assert.deepEqual(new Set(allow), expected);
  for (const t of policy.MCP_N1) assert.ok(!allow.includes(policy.MCP_PREFIX + t), t);
  for (const t of policy.GAPS_N1) assert.ok(!allow.includes(policy.GAPS_PREFIX + t), t);
});

test('setup examples are valid 0.2.0 configs', () => {
  const { validateConfig } = require('../../lib/config.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ex-'));
  try {
    fs.mkdirSync(path.join(tmp, '.git'));
    const configs = setupJsonBlocks().filter((b) => b.apps);
    assert.ok(configs.length >= 1);
    for (const cfg of configs) {
      assert.equal(cfg.migrations, undefined, 'no migrations at the root');
      for (const app of cfg.apps) if (app.repoPath !== undefined) app.repoPath = tmp;
      assert.deepEqual(validateConfig(cfg), []);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
