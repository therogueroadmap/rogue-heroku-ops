'use strict';
// Pure module: PreToolUse decision for every tool the agent can call (spec 6).
// Fail closed: unknown tool, unreadable input or any exception -> deny.

const path = require('node:path');
const { MCP_PREFIX, GAPS_PREFIX, classifyMcpTool, checkMcpInput, isPathAllowed } = require('./policy.js');
const { validateReadOnlySql, wrapReadOnly, unwrapReadOnly } = require('./sql.js');

// Cap on any `command` input.
const MAX_COMMAND = 4000;

/** @typedef {import('./policy').Decision} Decision */
/** @typedef {import('./policy').Config} Config */

const deny = (reason) => ({ decision: 'deny', level: 'N3', reason });
const allowN0 = (reason) => ({ decision: 'allow', level: 'N0', reason });

const N1_REASONS = {
  ps_restart: (app) => `${app}: reinicia los dynos; sin pérdida de datos.`,
  maintenance_on: (app) => `${app}: muestra la página de mantenimiento; se revierte con maintenance_off.`,
  maintenance_off: (app) => `${app}: vuelve a servir tráfico.`,
  backup_capture: (app) => `${app}: crea un backup nuevo de la base; no modifica datos; se puede borrar con pg:backups:delete.`,
};

const isSet = (v) => v !== undefined && v !== null;

// Same criteria as rule 5 of shell.js (evaluatePsql): printable ASCII only (typographic
// quotes, CR/LF), and no backtick, "$" or "%" (cmd.exe expands %VAR%).
function evaluateMcpPsql(input, config) {
  if (isSet(input.file) || isSet(input.credential)) {
    return deny('pg_psql con "file" o "credential" no está permitido; solo "command" de solo lectura.');
  }
  const sql = input.command;
  if (typeof sql !== 'string' || sql === '') return deny('pg_psql: falta "command" o está vacío.');
  if (!/^[\x20-\x7E]+$/.test(sql)) {
    return deny('Regla 5 (psql): el comando contiene caracteres no ASCII imprimibles o saltos de línea.');
  }
  if (/[`$%]/.test(sql)) return deny('Regla 5 (psql): el SQL contiene comillas invertidas, "$" o "%".');
  if (unwrapReadOnly(sql) !== null) {
    return allowN0('psql de solo lectura (SQL ya envuelto en transacción de solo lectura).');
  }
  if (config.sqlRewrite !== true) {
    return deny('Regla 5 (psql): el SQL debe venir envuelto en "BEGIN TRANSACTION READ ONLY; ...; ROLLBACK;" y el reescrito automático está desactivado.');
  }
  const v = validateReadOnlySql(sql);
  if (!v.ok) return deny(`Regla 5 (psql): SQL rechazado. ${v.reason}`);
  return {
    decision: 'allow',
    level: 'N0',
    reason: 'psql de solo lectura: el SQL se envolvió en una transacción de solo lectura con ROLLBACK.',
    updatedInput: { ...input, command: wrapReadOnly(v.statement) },
  };
}

function evaluateMcp(toolName, input, config) {
  const { level, tool, server } = classifyMcpTool(toolName);
  if (level === 'N3') return deny(`Herramienta MCP no permitida: ${tool || toolName}.`);
  // APP_NAME::DB targets another app's database (official server only).
  if (server === 'official' && typeof input.database === 'string' && input.database.includes('::')) {
    return deny('El parámetro "database" apunta a otra app (APP::DB); no está permitido.');
  }
  const chk = checkMcpInput(tool, input, config, server);
  if (!chk.ok) return deny(chk.reason);
  if (level === 'N1') {
    const mode = config.n1Mode === 'ask' ? 'ask' : 'deny';
    const what = N1_REASONS[tool](input.app);
    return {
      decision: mode,
      level: 'N1',
      reason: mode === 'ask' ? what : `${tool} requiere que lo ejecute el PO. ${what}`,
    };
  }
  if (server === 'official' && tool === 'pg_psql') return evaluateMcpPsql(input, config);
  return allowN0(`Consulta de solo lectura (${tool}).`);
}

// Glob patterns / Grep globs must not escape the allowed path: no absolute path,
// no ".." anywhere and no brace expansion ({a,..}) that could hide one.
const escapesPath = (p) => typeof p === 'string' && (path.win32.isAbsolute(p) || p.includes('..') || /[{}]/.test(p));

function evaluatePathTool(toolName, input, config, root) {
  const p = toolName === 'Read' ? input.file_path : input.path;
  if (!isPathAllowed(p, [root, config.repoPath])) {
    return deny(`${toolName}: la ruta no está dentro de las carpetas permitidas (el agente y el repositorio).`);
  }
  const pattern = toolName === 'Glob' ? input.pattern : toolName === 'Grep' ? input.glob : undefined;
  if (escapesPath(pattern)) return deny(`${toolName}: el patrón sale de las carpetas permitidas.`);
  return allowN0(`${toolName} dentro de las carpetas permitidas.`);
}

/**
 * @param {object} hookInput
 * @param {Config} config
 * @param {string} root
 * @returns {Decision}
 */
function evaluate(hookInput, config, root) {
  try {
    if (!hookInput || typeof hookInput !== 'object') return deny('Entrada del hook ilegible.');
    const toolName = hookInput.tool_name;
    if (typeof toolName !== 'string') return deny('Entrada del hook sin tool_name.');
    const input = hookInput.tool_input && typeof hookInput.tool_input === 'object' ? hookInput.tool_input : {};
    // Length cap before any regex: bounded cost for every tool that takes a command.
    if (typeof input.command === 'string' && input.command.length > MAX_COMMAND) {
      return deny(`El comando supera ${MAX_COMMAND} caracteres; se deniega sin evaluarlo.`);
    }

    if (toolName.startsWith(MCP_PREFIX) || toolName.startsWith(GAPS_PREFIX)) {
      return evaluateMcp(toolName, input, config);
    }
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      return deny(`${toolName} no está permitido para este agente; usa las herramientas MCP.`);
    }
    if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
      return evaluatePathTool(toolName, input, config, root);
    }
    return deny(`Herramienta no permitida para este agente: ${toolName}.`);
  } catch (_e) {
    return deny('Error interno al evaluar la herramienta; se deniega por defecto.');
  }
}

module.exports = { evaluate, MAX_COMMAND };
