'use strict';
// Pure module: PreToolUse decision for every tool the guard sees (spec 6.5, rules 1 to 5, in order).
// Returns null for "no decision". Fail closed: unknown tool, unreadable input or any exception -> deny.

const fs = require('node:fs');
const path = require('node:path');
const {
  PLUGIN_AGENT, MCP_PREFIX, GAPS_PREFIX, classifyMcpTool, checkMcpInput, isPathAllowed,
  isCredentialPath, patternTargetsCredentials, isSimpleGrepGlob,
} = require('./policy.js');
const { validateReadOnlySql, wrapReadOnly, unwrapReadOnly } = require('./sql.js');

// Cap on any `command` input.
const MAX_COMMAND = 4000;

/** @typedef {import('./policy').Decision} Decision */

const deny = (reason) => ({ decision: 'deny', level: 'N3', reason });
const allowN0 = (reason) => ({ decision: 'allow', level: 'N0', reason });

const AGENT_HINT = `Use the ${PLUGIN_AGENT} agent for Heroku operations.`;

const N1_REASONS = {
  ps_restart: (app) => `${app}: restarts the dynos; no data loss.`,
  maintenance_on: (app) => `${app}: shows the maintenance page; revert with maintenance_off.`,
  maintenance_off: (app) => `${app}: serves traffic again.`,
  backup_capture: (app) => `${app}: creates a new database backup; modifies no data; can be removed with pg:backups:delete.`,
};

const isSet = (v) => v !== undefined && v !== null;

// SQL criteria: printable ASCII only (no typographic quotes, CR/LF) and no backtick, "$" or "%"
// (cmd.exe expands %VAR%). Valid SQL is always wrapped in a READ ONLY transaction.
function evaluateMcpPsql(input) {
  if (isSet(input.file) || isSet(input.credential)) {
    return deny('pg_psql with "file" or "credential" is not allowed; only a read-only "command".');
  }
  const sql = input.command;
  if (typeof sql !== 'string' || sql === '') return deny('pg_psql: "command" is missing or empty.');
  if (!/^[\x20-\x7E]+$/.test(sql)) {
    return deny('psql rule: the command contains non-printable or non-ASCII characters, or line breaks.');
  }
  if (/[`$%]/.test(sql)) return deny('psql rule: the SQL contains backticks, "$" or "%".');
  if (unwrapReadOnly(sql) !== null) {
    return allowN0('Read-only psql (SQL already wrapped in a read-only transaction).');
  }
  const v = validateReadOnlySql(sql);
  if (!v.ok) return deny(`psql rule: SQL rejected. ${v.reason}`);
  return {
    decision: 'allow',
    level: 'N0',
    reason: 'Read-only psql: the SQL was wrapped in a read-only transaction with ROLLBACK.',
    updatedInput: { ...input, command: wrapReadOnly(v.statement) },
  };
}

function evaluateMcp(toolName, input, config) {
  const { level, tool, server } = classifyMcpTool(toolName);
  if (level === 'N3') return deny(`MCP tool not allowed: ${tool || toolName}.`);
  // APP_NAME::DB targets another app's database (official server only).
  if (server === 'official' && typeof input.database === 'string' && input.database.includes('::')) {
    return deny('The "database" parameter targets another app (APP::DB); not allowed.');
  }
  const chk = checkMcpInput(tool, input, config, server);
  if (!chk.ok) return deny(chk.reason);
  if (level === 'N1') {
    const mode = config.n1Mode === 'deny' ? 'deny' : 'ask';
    const what = N1_REASONS[tool](input.app);
    return {
      decision: mode,
      level: 'N1',
      reason: mode === 'ask' ? what : `${tool} must be run by the person, not the agent. ${what}`,
    };
  }
  if (server === 'official' && tool === 'pg_psql') return evaluateMcpPsql(input);
  return allowN0(`Read-only query (${tool}).`);
}

// Glob patterns / Grep globs must not escape the project: no absolute path (either platform),
// no ".." anywhere and no brace expansion ({a,..}) that could hide one.
const escapesPath = (p) =>
  typeof p === 'string' && (path.win32.isAbsolute(p) || path.posix.isAbsolute(p) || p.includes('..') || /[{}]/.test(p));

function evaluatePathTool(toolName, input, projectDir) {
  const p = toolName === 'Read' ? input.file_path : input.path;
  if (!isPathAllowed(p, [projectDir])) {
    return deny(`${toolName}: the path must be inside the project directory (pass a path inside it).`);
  }
  const pattern = toolName === 'Glob' ? input.pattern : toolName === 'Grep' ? input.glob : undefined;
  if (escapesPath(pattern)) return deny(`${toolName}: the pattern leaves the project directory.`);
  // Only the part below the project counts: an 8.3 segment in the project prefix (such as RUNNER~1) is not a credential.
  const rel = path.relative(path.resolve(projectDir), path.resolve(projectDir, p));
  if (isCredentialPath(rel) || patternTargetsCredentials(pattern)) {
    return deny(`${toolName}: reading .env files and credential files is not allowed.`);
  }
  if (toolName === 'Grep' && !grepScopeOk(p, pattern, projectDir)) {
    return deny('Grep over a directory needs a simple glob such as **/*.js or src/*.sql.');
  }
  return allowN0(`${toolName} inside the project directory.`);
}

// Grep over a directory searches file contents of the whole tree: it needs a glob from the allow-list
// grammar (isSimpleGrepGlob). A file path needs no glob. If the path cannot be inspected: not ok (fail closed).
function grepScopeOk(p, glob, projectDir) {
  let isDir;
  try {
    isDir = fs.statSync(path.resolve(projectDir, p)).isDirectory();
  } catch (_e) {
    return false;
  }
  if (!isDir) return true;
  return isSimpleGrepGlob(glob);
}

/**
 * @param {object} hookInput
 * @param {{ok:boolean, config?:object, problems?:string[]}} configResult  Return of loadProjectConfig.
 * @param {string} projectDir  CLAUDE_PROJECT_DIR.
 * @returns {Decision|null}  null = no decision.
 */
function evaluate(hookInput, configResult, projectDir) {
  try {
    if (!hookInput || typeof hookInput !== 'object') return deny('Unreadable hook input.');
    const toolName = hookInput.tool_name;
    if (typeof toolName !== 'string') return deny('Hook input without tool_name.');
    const input = hookInput.tool_input && typeof hookInput.tool_input === 'object' ? hookInput.tool_input : {};
    // Length cap before any regex: bounded cost for every tool that takes a command.
    if (typeof input.command === 'string' && input.command.length > MAX_COMMAND) {
      return deny(`The command exceeds ${MAX_COMMAND} characters; denied without evaluating it.`);
    }
    const isAgent = hookInput.agent_type === PLUGIN_AGENT;
    const isPluginTool = toolName.startsWith(MCP_PREFIX) || toolName.startsWith(GAPS_PREFIX);
    const isPathTool = toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob';

    // Rule 1: plugin tools only for the plugin agent.
    if (isPluginTool && !isAgent) return deny(AGENT_HINT);
    // Rule 2: the main session and other agents keep their own Read/Grep/Glob.
    if (isPathTool && !isAgent) return null;
    // Rule 3: the agent reads only inside the project, never credentials.
    if (isPathTool) return evaluatePathTool(toolName, input, projectDir);
    // Rules 4 and 5: plugin tools need a valid config; get_config stays open to show the problems.
    if (isPluginTool) {
      if (!configResult || !configResult.ok) {
        if (toolName === GAPS_PREFIX + 'get_config') return allowN0('get_config reports the config problems.');
        const problems = configResult && Array.isArray(configResult.problems) ? configResult.problems : [];
        return deny(`The project config is missing or invalid. ${problems.join(' ')}`.trim());
      }
      return evaluateMcp(toolName, input, configResult.config);
    }
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      return deny(`${toolName} is not allowed for this agent; use the MCP tools.`);
    }
    return deny(`Tool not allowed for this agent: ${toolName}.`);
  } catch (_e) {
    return deny('Internal error while evaluating the tool; denied by default.');
  }
}

module.exports = { evaluate, MAX_COMMAND };
