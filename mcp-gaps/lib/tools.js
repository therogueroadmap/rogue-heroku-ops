'use strict';
// Tool handlers for heroku-ops-gaps. Every handler validates with argv.js first and
// runs files with execFile semantics (runFile): no shell, no .cmd/.bat.
const fs = require('node:fs');
const path = require('node:path');
const { herokuArgs, gitArgs, healthApp } = require('./argv');
const {
  resolveHerokuCommand, buildChildEnv, runFile, HEROKU_TIMEOUT_MS, GIT_TIMEOUT_MS,
} = require('./exec');
const { PROCEDURE_NAMES } = require('./schemas');
const { loadProjectConfig } = require('../../lib/config');

const HEALTH_TIMEOUT_MS = 10000;
const HEALTH_BODY_MAX = 2048;
const TRUNCATED_NOTICE = '[output truncated]';

const HEROKU_TOOLS = ['releases_list', 'backup_info', 'backup_capture'];
const GIT_TOOLS = ['git_fetch', 'git_log', 'git_show', 'git_ls_tree', 'git_diff'];

const textResult = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

function pickReleaseFields(json) {
  if (!Array.isArray(json)) throw new Error('The CLI response is not an array of releases.');
  return json.map((r) => ({
    version: r?.version,
    description: r?.description,
    status: r?.status,
    created_at: r?.created_at,
    user_email: r?.user?.email,
  }));
}

// Maps a runFile result to a tool result (shared by Heroku and git tools).
function formatRun(run, timeoutMs) {
  if (run.timedOut) return textResult(`The ${Math.round(timeoutMs / 1000)} s limit was exceeded.`, true);
  if (run.code !== 0) {
    const detail = run.code === null ? 'The process could not be run' : `Exit code ${run.code}`;
    return textResult(`${detail}${run.stderr ? `\n${run.stderr}` : ''}${run.truncated ? `\n${TRUNCATED_NOTICE}` : ''}`, true);
  }
  const body = run.stdout || '(no output)';
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

// projectDir: CLAUDE_PROJECT_DIR. pluginRoot: CLAUDE_PLUGIN_ROOT (procedures live under it).
// The config is loaded on every call: a missing or invalid one never yields a partial config,
// and a fix made by /rogue-heroku-ops:setup takes effect without restarting the server.
function createHandlers({ projectDir, pluginRoot, env, gitExe = 'git', herokuOverride, platform = process.platform }) {
  const childEnv = () => buildChildEnv(env);
  // HEROKU_OPS_TEST_TIMEOUT_MS is only meant for tests; production uses HEROKU_TIMEOUT_MS (60 s).
  const testTimeout = Number(env.HEROKU_OPS_TEST_TIMEOUT_MS);
  const herokuTimeoutMs = Number.isFinite(testTimeout) && testTimeout > 0 ? testTimeout : HEROKU_TIMEOUT_MS;

  const configError = (loaded) => textResult(`Invalid or missing project configuration:\n- ${loaded.problems.join('\n- ')}`, true);

  // Wraps a handler that needs a valid config.
  const withConfig = (fn) => async (input) => {
    const loaded = loadProjectConfig(projectDir);
    if (!loaded.ok) return configError(loaded);
    return fn(input, loaded.config);
  };

  const heroku = (tool) => withConfig(async (input, config) => {
    const v = herokuArgs(tool, input, config);
    if (!v.ok) return textResult(v.reason, true);
    let cli;
    try {
      cli = resolveHerokuCommand({ platform, env, override: herokuOverride ?? env.HEROKU_OPS_TEST_CLI });
    } catch (e) {
      return textResult(e.message, true);
    }
    const run = await runFile(cli.file, [...cli.prefixArgs, ...v.args], { env: childEnv(), timeoutMs: herokuTimeoutMs });
    if (tool === 'backup_capture' && run.timedOut) {
      return textResult(
        `The ${Math.round(herokuTimeoutMs / 1000)} s limit was exceeded waiting for the CLI; the backup may still be running on Heroku. ` +
        'Check with `pg_backups` or `backup_info` before repeating it.',
        true,
      );
    }
    if (tool !== 'releases_list') return formatRun(run, herokuTimeoutMs);
    if (run.timedOut || run.code !== 0) return formatRun(run, herokuTimeoutMs);
    let json;
    try {
      json = JSON.parse(run.stdout);
    } catch {
      return textResult(`The CLI did not return JSON (${run.stdout.length} characters of output).`, true);
    }
    try {
      return textResult(JSON.stringify(pickReleaseFields(json), null, 2));
    } catch (e) {
      return textResult(e.message, true);
    }
  });

  const git = (tool) => withConfig(async (input, config) => {
    const v = gitArgs(tool, input, { config, projectDir, platform });
    if (!v.ok) return textResult(v.reason, true);
    const run = await runFile(gitExe, v.args, { env: childEnv(), timeoutMs: GIT_TIMEOUT_MS });
    // git fetch reports updated refs on stderr and nothing on stdout.
    if (tool === 'git_fetch' && !run.timedOut && run.code === 0) {
      const updated = run.stderr.trim();
      if (!updated) return textResult('git fetch origin completed. No new references.');
      return textResult(`git fetch origin completed.\n${updated}${run.truncated ? `\n${TRUNCATED_NOTICE}` : ''}`);
    }
    return formatRun(run, GIT_TIMEOUT_MS);
  });

  const healthCheck = withConfig(async (input, config) => {
    const v = healthApp(input, config);
    if (!v.ok) return textResult(v.reason, true);
    const started = Date.now();
    try {
      const res = await fetch(v.app.healthUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: 'manual' });
      const body = await readBodyCapped(res, HEALTH_BODY_MAX);
      return textResult(`HTTP ${res.status} in ${Date.now() - started} ms\n${body}`);
    } catch (e) {
      return textResult(`Could not query the health check: ${e?.message ?? e}`, true);
    }
  });

  const getConfig = withConfig(async (_input, config) => textResult(JSON.stringify(config, null, 2)));

  // The path is built only from the PROCEDURE_NAMES enum, never from free text.
  const getProcedure = async (input) => {
    const name = input?.name;
    if (!PROCEDURE_NAMES.includes(name)) {
      return textResult(`The name parameter must be one of: ${PROCEDURE_NAMES.join(', ')}.`, true);
    }
    try {
      return textResult(fs.readFileSync(path.join(pluginRoot, 'procedures', `${name}.md`), 'utf8'));
    } catch (e) {
      return textResult(`Could not read the ${name} procedure: ${e.code ?? e.message}`, true);
    }
  };

  const handlers = {};
  for (const t of HEROKU_TOOLS) handlers[t] = heroku(t);
  for (const t of GIT_TOOLS) handlers[t] = git(t);
  handlers.health_check = healthCheck;
  handlers.get_config = getConfig;
  handlers.get_procedure = getProcedure;
  return handlers;
}

module.exports = { createHandlers, pickReleaseFields };
