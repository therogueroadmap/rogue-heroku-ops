'use strict';
// Tool handlers for heroku-ops-gaps. Every handler validates with argv.js first and
// runs files with execFile semantics (runFile): no shell, no .cmd/.bat.
const { herokuArgs, gitArgs } = require('./argv');
const {
  resolveHerokuCli, buildChildEnv, runFile, HEROKU_TIMEOUT_MS, GIT_TIMEOUT_MS,
} = require('./exec');

const HEALTH_TIMEOUT_MS = 10000;
const HEALTH_BODY_MAX = 2048;
const TRUNCATED_NOTICE = '[salida truncada]';

const HEROKU_TOOLS = ['releases_list', 'backup_info', 'backup_capture'];
const GIT_TOOLS = ['git_fetch', 'git_log', 'git_show', 'git_ls_tree', 'git_diff'];

const textResult = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

function pickReleaseFields(json) {
  if (!Array.isArray(json)) throw new Error('La respuesta de la CLI no es un arreglo de releases.');
  return json.map((r) => ({
    version: r?.version,
    description: r?.description,
    status: r?.status,
    created_at: r?.created_at,
    user_email: r?.user?.email,
  }));
}

// Returns a list of problems (empty when the config is valid).
function validateConfig(cfg) {
  const problems = [];
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return ['el archivo debe contener un objeto JSON.'];
  const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!Array.isArray(cfg.apps) || cfg.apps.length === 0 || !cfg.apps.every(nonEmpty)) {
    problems.push('apps debe ser un arreglo no vacío de textos no vacíos.');
  }
  if (!nonEmpty(cfg.repoPath)) problems.push('repoPath debe ser un texto no vacío.');
  if (!nonEmpty(cfg.deployBranch)) problems.push('deployBranch debe ser un texto no vacío.');
  if (!nonEmpty(cfg.healthUrl) || !/^https?:\/\//.test(cfg.healthUrl)) {
    problems.push('healthUrl debe ser un texto que empiece por https:// o http://.');
  }
  return problems;
}

// Maps a runFile result to a tool result (shared by Heroku and git tools).
function formatRun(run, timeoutMs) {
  if (run.timedOut) return textResult(`Se superó el límite de ${Math.round(timeoutMs / 1000)} s.`, true);
  if (run.code !== 0) {
    const detail = run.code === null ? 'No se pudo ejecutar el proceso' : `Código ${run.code}`;
    return textResult(`${detail}${run.stderr ? `\n${run.stderr}` : ''}${run.truncated ? `\n${TRUNCATED_NOTICE}` : ''}`, true);
  }
  const body = run.stdout || '(sin salida)';
  return textResult(run.truncated ? `${body}\n${TRUNCATED_NOTICE}` : body);
}

async function readBodyCapped(res, maxChars) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (out.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    if (out.length < maxChars) out += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.slice(0, maxChars);
}

function createHandlers({ cfg, env, gitExe, herokuOverride }) {
  const childEnv = () => buildChildEnv(env);
  // HEROKU_OPS_TEST_TIMEOUT_MS is only meant for tests; production uses HEROKU_TIMEOUT_MS (60 s).
  const testTimeout = Number(env.HEROKU_OPS_TEST_TIMEOUT_MS);
  const herokuTimeoutMs = Number.isFinite(testTimeout) && testTimeout > 0 ? testTimeout : HEROKU_TIMEOUT_MS;

  const heroku = (tool) => async (input) => {
    const v = herokuArgs(tool, input, cfg);
    if (!v.ok) return textResult(v.reason, true);
    let cli;
    try {
      // Resolved on every call: the CLI may be installed or updated while the server runs.
      cli = resolveHerokuCli({
        localAppData: env.LOCALAPPDATA,
        programFiles: env.ProgramFiles,
        override: herokuOverride ?? env.HEROKU_OPS_TEST_CLI,
      });
    } catch (e) {
      return textResult(e.message, true);
    }
    const run = await runFile(cli.node, [cli.script, ...v.args], { env: childEnv(), timeoutMs: herokuTimeoutMs });
    if (tool === 'backup_capture' && run.timedOut) {
      return textResult(
        `Se superó el límite de ${Math.round(herokuTimeoutMs / 1000)} s esperando a la CLI; el backup puede seguir en curso en Heroku. ` +
        'Compruébalo con `pg_backups` o `backup_info` antes de repetirlo.',
        true,
      );
    }
    if (tool !== 'releases_list') return formatRun(run, herokuTimeoutMs);
    if (run.timedOut || run.code !== 0) return formatRun(run, herokuTimeoutMs);
    let json;
    try {
      json = JSON.parse(run.stdout);
    } catch {
      return textResult(`La CLI no devolvió JSON (${run.stdout.length} caracteres de salida).`, true);
    }
    try {
      return textResult(JSON.stringify(pickReleaseFields(json), null, 2));
    } catch (e) {
      return textResult(e.message, true);
    }
  };

  const git = (tool) => async (input) => {
    const v = gitArgs(tool, input, cfg);
    if (!v.ok) return textResult(v.reason, true);
    const run = await runFile(gitExe, v.args, { env: childEnv(), timeoutMs: GIT_TIMEOUT_MS });
    // git fetch reports updated refs on stderr and nothing on stdout.
    if (tool === 'git_fetch' && !run.timedOut && run.code === 0) {
      const updated = run.stderr.trim();
      if (!updated) return textResult('git fetch origin completado. Sin referencias nuevas.');
      return textResult(`git fetch origin completado.
${updated}${run.truncated ? `
${TRUNCATED_NOTICE}` : ''}`);
    }
    return formatRun(run, GIT_TIMEOUT_MS);
  };

  const healthCheck = async () => {
    const started = Date.now();
    try {
      const res = await fetch(cfg.healthUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: 'manual' });
      const body = await readBodyCapped(res, HEALTH_BODY_MAX);
      return textResult(`HTTP ${res.status} en ${Date.now() - started} ms\n${body}`);
    } catch (e) {
      return textResult(`No se pudo consultar el health check: ${e?.message ?? e}`, true);
    }
  };

  const handlers = {};
  for (const t of HEROKU_TOOLS) handlers[t] = heroku(t);
  for (const t of GIT_TOOLS) handlers[t] = git(t);
  handlers.health_check = healthCheck;
  return handlers;
}

module.exports = { createHandlers, pickReleaseFields, validateConfig };
