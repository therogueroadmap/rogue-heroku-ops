'use strict';
// Pure module: builds one audit log entry (spec 6.6). Never stores tool_response content.

const crypto = require('node:crypto');
const path = require('node:path');
const { redactSql } = require('./sql.js');
const { MCP_PREFIX } = require('./policy.js');

const MAX_VALUE = 200;
const SECRET_KEY_RE = /token|key|password|secret|url/i;
const SHELL_TOOLS = ['Bash', 'PowerShell'];
const PSQL_MCP_TOOL = MCP_PREFIX + 'pg_psql';

// -c "..." or -c '...' (also --command), double or single quoted.
const PSQL_C_RE = /(-c|--command)([\s=]+)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/g;

// Bounded fields for a denied shell command: the command itself is never stored
// (it is free text and may hold secrets). Only exe and sub that look like a plain
// lowercase command name (no digits, no uppercase) are kept; anything else is
// "[other]", so Heroku tokens (UUID, HRKU-...) and KEY=value pairs never reach the log.
const TOKEN_PREFIX = 256;
const SAFE_TOKEN_RE = /^-{0,2}[a-z][a-z:-]{0,30}$/;
const OTHER_TOKEN = '[other]';

function safeToken(t) {
  if (typeof t !== 'string') return '';
  return SAFE_TOKEN_RE.test(t) ? t : OTHER_TOKEN;
}

// Strips quotes, directory and .exe/.cmd so "C:\tools\heroku.cmd" becomes "heroku".
function normalizeExe(t) {
  if (typeof t !== 'string') return t;
  const base = t.replace(/^["']+|["']+$/g, '').split(/[\\/]/).pop().toLowerCase();
  return base.replace(/\.(exe|cmd)$/, '');
}

function summarizeDeniedCommand(command) {
  const cmd = typeof command === 'string' ? command : '';
  const tokens = cmd.slice(0, TOKEN_PREFIX).trim().split(/\s+/);
  return {
    exe: safeToken(normalizeExe(tokens[0])),
    sub: safeToken(tokens[1]),
    length: cmd.length,
    sha256: crypto.createHash('sha256').update(cmd, 'utf8').digest('hex').slice(0, 16),
  };
}

function redactShellCommand(command) {
  // Only closed-form commands (allowed by the guard) reach this path; deny lines
  // use summarizeDeniedCommand. psql SQL literals are still redacted.
  if (!/pg:psql/i.test(command)) return command;
  let matched = false;
  const out = command.replace(PSQL_C_RE, (_m, flag, sep, quoted) => {
    matched = true;
    const q = quoted[0];
    let inner = quoted.slice(1, -1);
    if (q === "'") inner = inner.replace(/''/g, "'");
    const red = redactSql(inner);
    return `${flag}${sep}${q}${q === "'" ? red.replace(/'/g, "''") : red}${q}`;
  });
  // Unparsable -c (unterminated quote, stdin, ...): redact the whole command.
  return matched ? out : redactSql(command);
}

function summarizeInput(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (SHELL_TOOLS.includes(toolName)) {
    return redactShellCommand(typeof input.command === 'string' ? input.command : '');
  }
  if (toolName === PSQL_MCP_TOOL) {
    return redactSql(typeof input.command === 'string' ? input.command : '');
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEY_RE.test(k)) out[k] = '[redacted]';
    else if (typeof v === 'string') out[k] = v.slice(0, MAX_VALUE);
    else out[k] = v;
  }
  return out;
}

function buildAuditEntry(hookInput, now) {
  const h = hookInput && typeof hookInput === 'object' ? hookInput : {};
  const resp = h.tool_response && typeof h.tool_response === 'object' ? h.tool_response : {};
  return {
    ts: now.toISOString(),
    agent_type: typeof h.agent_type === 'string' ? h.agent_type : null,
    tool: typeof h.tool_name === 'string' ? h.tool_name : null,
    event: typeof h.hook_event_name === 'string' ? h.hook_event_name : null,
    input: summarizeInput(h.tool_name, h.tool_input),
    error: resp.is_error === true || Boolean(resp.error) ||
      h.hook_event_name === 'PostToolUseFailure' || Boolean(h.error),
  };
}

/**
 * Audit file for a timestamp: ${CLAUDE_PLUGIN_DATA}/audit/audit-YYYY-MM.jsonl (UTC month).
 * Returns null when CLAUDE_PLUGIN_DATA is not set: nothing is written.
 */
function auditFile(env, isoTs) {
  const dataDir = env && env.CLAUDE_PLUGIN_DATA;
  if (typeof dataDir !== 'string' || dataDir === '') return null;
  return path.join(dataDir, 'audit', `audit-${isoTs.slice(0, 7)}.jsonl`);
}

module.exports = { buildAuditEntry, summarizeInput, summarizeDeniedCommand, auditFile, PSQL_MCP_TOOL };
