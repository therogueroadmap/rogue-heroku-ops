'use strict';
// PreToolUse hook: prints the permission decision as JSON and always exits 0.
// No decision (evaluate returns null) -> no output. Any error (bad stdin, missing or invalid
// config, exception) -> deny. Reads CLAUDE_PROJECT_DIR (project and config location) and
// CLAUDE_PLUGIN_DATA (audit directory) from the environment.

const fs = require('node:fs');
const path = require('node:path');

const INTERNAL_ERROR = 'guard: internal error, blocked for safety';

function auditDecision(hookInput, d) {
  try {
    const { MCP_PREFIX } = require('./lib/policy.js');
    const ae = require('./lib/audit-entry.js');
    const tool = hookInput && typeof hookInput.tool_name === 'string' ? hookInput.tool_name : null;
    const ti = hookInput && hookInput.tool_input;
    const cmd = ti && typeof ti.command === 'string' ? ti.command : '';
    const hasSql = tool === MCP_PREFIX + 'pg_psql' || /pg:psql/i.test(cmd);
    let reason = d.reason;
    if (hasSql) {
      try {
        reason = require('./lib/sql.js').redactSql(d.reason);
      } catch (_e) {
        reason = undefined; // cannot redact: omit rather than log raw SQL
      }
    }
    // A denied shell command is never stored, not even inside the reason. Plain split/join, no regex.
    const isShellDeny = d.decision === 'deny' && (tool === 'Bash' || tool === 'PowerShell');
    if (isShellDeny && cmd !== '' && typeof reason === 'string') reason = reason.split(cmd).join('[command]');
    let input;
    try {
      const { MAX_COMMAND } = require('./lib/evaluate.js');
      const isShell = tool === 'Bash' || tool === 'PowerShell';
      if (d.decision === 'deny' && (isShell || cmd.length > MAX_COMMAND)) {
        // Denied free text is never stored: only exe, sub, length and a short sha256.
        input = ae.summarizeDeniedCommand(cmd);
      } else {
        // Same redaction as the PostToolUse audit (SQL literals, secret-like keys).
        input = ae.summarizeInput(tool, ti);
      }
    } catch (_e) {
      input = undefined; // cannot redact: omit rather than log the raw input
    }
    const entry = {
      ts: new Date().toISOString(),
      kind: 'decision',
      agent_type: hookInput && typeof hookInput.agent_type === 'string' ? hookInput.agent_type : null,
      tool,
      input,
      level: d.level,
      decision: d.decision,
      reason,
    };
    const file = ae.auditFile(process.env, entry.ts);
    if (!file) return; // no CLAUDE_PLUGIN_DATA: nothing is written
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (_e) {
    // swallowed on purpose: the audit must never block the guard
  }
}

let hookInput = null;
let d;
try {
  const { evaluate } = require('./lib/evaluate.js');
  const { loadProjectConfig } = require('../lib/config.js');
  hookInput = JSON.parse(fs.readFileSync(0, 'utf8'));
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  d = evaluate(hookInput, loadProjectConfig(projectDir), projectDir);
  if (d === null) process.exit(0); // no decision: leave the session alone
  if (!d || !['allow', 'ask', 'deny'].includes(d.decision)) throw new Error('bad decision');
} catch (_e) {
  d = { decision: 'deny', level: 'N3', reason: INTERNAL_ERROR };
}

const out = {
  hookEventName: 'PreToolUse',
  permissionDecision: d.decision,
  permissionDecisionReason: d.reason,
};
if (d.updatedInput) out.updatedInput = d.updatedInput;
process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
auditDecision(hookInput, d);
process.exit(0);
