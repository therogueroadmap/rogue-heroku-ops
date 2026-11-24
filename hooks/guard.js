'use strict';
// PreToolUse hook: prints the permission decision as JSON and always exits 0.
// Any error (bad stdin, missing config, exception) -> deny.
// HEROKU_OPS_CONFIG overrides the config path and HEROKU_OPS_AUDIT_DIR the audit
// directory (both used by tests). --only-agent <name>: stay silent for other agents.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INTERNAL_ERROR = 'guarda: error interno, se bloquea por seguridad';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function onlyAgentArg() {
  const i = process.argv.indexOf('--only-agent');
  if (i === -1) return null;
  const v = process.argv[i + 1];
  // Missing or flag-like value: throw so the caller denies instead of silently disabling the guard.
  if (!v || v.startsWith('--')) throw new Error('--only-agent sin valor');
  return v;
}

function auditDecision(hookInput, d) {
  try {
    const tool = hookInput && typeof hookInput.tool_name === 'string' ? hookInput.tool_name : null;
    const ti = hookInput && hookInput.tool_input;
    const cmd = ti && typeof ti.command === 'string' ? ti.command : '';
    const hasSql = tool === 'mcp__heroku-ops__pg_psql' || /pg:psql/i.test(cmd);
    let reason = d.reason;
    if (hasSql) {
      try {
        reason = require('./lib/sql.js').redactSql(d.reason);
      } catch (_e) {
        reason = undefined; // cannot redact: omit rather than log raw SQL
      }
    }
    // A denied shell command is never stored, not even inside the reason (rule 3 with
    // n1Mode "deny" quotes it for the PO). Plain split/join, no regex.
    const isShellDeny = d.decision === 'deny' && (tool === 'Bash' || tool === 'PowerShell');
    if (isShellDeny && cmd !== '' && typeof reason === 'string') reason = reason.split(cmd).join('[comando]');
    let input;
    try {
      const ae = require('./lib/audit-entry.js');
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
    const now = new Date();
    const entry = {
      ts: now.toISOString(),
      kind: 'decision',
      agent_type: hookInput && typeof hookInput.agent_type === 'string' ? hookInput.agent_type : null,
      tool,
      input,
      level: d.level,
      decision: d.decision,
      reason,
    };
    const dir = process.env.HEROKU_OPS_AUDIT_DIR || path.join(ROOT, 'audit');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `audit-${entry.ts.slice(0, 7)}.jsonl`), JSON.stringify(entry) + '\n');
  } catch (_e) {
    // swallowed on purpose: the audit must never block the guard
  }
}

let hookInput = null;
let d;
try {
  const { evaluate } = require('./lib/evaluate.js');
  hookInput = JSON.parse(fs.readFileSync(0, 'utf8'));
  const only = onlyAgentArg();
  if (only !== null && (!hookInput || hookInput.agent_type !== only)) process.exit(0);
  const cfgPath = process.env.HEROKU_OPS_CONFIG || path.join(ROOT, 'config.json');
  const config = deepFreeze(JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
  d = evaluate(hookInput, config, ROOT);
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
