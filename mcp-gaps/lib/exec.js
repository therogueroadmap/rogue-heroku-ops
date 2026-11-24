'use strict';
// Execution layer: locates the Heroku CLI (node.exe + run.js, never .cmd),
// builds a sanitized child env and runs files with execFile semantics (no shell).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HEROKU_TIMEOUT_MS = 60000;
const GIT_TIMEOUT_MS = 30000;
const MAX_STDOUT = 65536;
const MAX_STDERR = 4096;

const NOT_FOUND_MSG =
  'No se encontró la CLI de Heroku. Instálala o actualízala (https://devcenter.heroku.com/articles/heroku-cli) ' +
  'y vuelve a intentarlo; no hace falta reiniciar el servidor.';

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function versionDirCandidate(clientDir, ver) {
  const node = path.join(clientDir, ver, 'bin', 'node.exe');
  const script = path.join(clientDir, ver, 'bin', 'run.js');
  return isFile(node) && isFile(script) ? { node, script } : null;
}

function semverKey(name) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function resolveHerokuCli({ localAppData, programFiles, override } = {}) {
  if (override) return { node: process.execPath, script: override };

  if (localAppData) {
    const clientDir = path.join(localAppData, 'heroku', 'client');

    // Rule 2: follow the version heroku.cmd points to (kept current by auto-update).
    try {
      const cmd = fs.readFileSync(path.join(clientDir, 'bin', 'heroku.cmd'), 'utf8');
      const m = /"%~dp0\.\.\\([^\\/"]+)\\bin\\heroku\.cmd"/i.exec(cmd);
      if (m && m[1] !== '..' && m[1] !== '.') {
        const found = versionDirCandidate(clientDir, m[1]);
        if (found) return found;
      }
    } catch {
      // no heroku.cmd: fall through
    }

    // Rule 3: highest semver version folder that has node.exe + run.js.
    try {
      const best = fs
        .readdirSync(clientDir)
        .map((name) => ({ name, key: semverKey(name) }))
        .filter((e) => e.key && versionDirCandidate(clientDir, e.name))
        .sort((a, b) => compareSemver(b.key, a.key))[0];
      if (best) return versionDirCandidate(clientDir, best.name);
    } catch {
      // no client dir: fall through
    }
  }

  // Rule 4: system-wide installer.
  if (programFiles) {
    const bin = path.join(programFiles, 'heroku', 'client', 'bin');
    const node = path.join(bin, 'node.exe');
    const script = path.join(bin, 'run');
    if (isFile(node) && isFile(script)) return { node, script };
  }

  throw new Error(NOT_FOUND_MSG);
}

function buildChildEnv(baseEnv) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (k.toLowerCase() !== 'heroku_api_key') env[k] = v;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.HEROKU_REDIRECTED = '1';
  env.NO_COLOR = '1';
  return env;
}

// Length of buf without a trailing incomplete UTF-8 sequence (a cut multi-byte character).
function utf8CompleteLength(buf) {
  const n = buf.length;
  for (let back = 1; back <= 3 && back <= n; back++) {
    const b = buf[n - back];
    if ((b & 0xC0) === 0x80) continue; // continuation byte: keep looking for the lead
    const need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}

function runFile(file, args, opts) {
  const { env, maxStdout = MAX_STDOUT, maxStderr = MAX_STDERR } = opts;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let timer = null;
    const out = { chunks: [], size: 0, max: maxStdout, capped: false };
    const err = { chunks: [], size: 0, max: maxStderr, capped: false };

    const decode = (st) => {
      const buf = Buffer.concat(st.chunks);
      // Only a cut stream (capped or timed out) can end mid-character; one that ended by itself decodes whole.
      return (st.capped || timedOut ? buf.subarray(0, utf8CompleteLength(buf)) : buf).toString('utf8');
    };
    const collect = (buf, st) => {
      if (st.size >= st.max) {
        truncated = true; // keep draining the pipe, but store nothing more
        st.capped = true;
        return;
      }
      const room = st.max - st.size;
      if (buf.length > room) {
        st.chunks.push(buf.subarray(0, room));
        st.size += room;
        truncated = true;
        st.capped = true;
      } else {
        st.chunks.push(buf);
        st.size += buf.length;
      }
    };
    const finish = (code, extraErr) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      let stderr = decode(err);
      if (extraErr) stderr = stderr ? `${stderr}\n${extraErr}` : extraErr;
      resolve({
        code,
        stdout: decode(out),
        stderr,
        truncated,
        timedOut,
      });
    };

    let child;
    try {
      child = spawn(file, args, {
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish(null, e.message);
      return;
    }
    child.stdout.on('data', (b) => collect(b, out));
    child.stderr.on('data', (b) => collect(b, err));
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
      // Do not wait for 'close': a grandchild holding the pipes could delay it.
      finish(null);
    }, timeoutMs);
  });
}

module.exports = {
  resolveHerokuCli,
  buildChildEnv,
  runFile,
  utf8CompleteLength,
  HEROKU_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  MAX_STDOUT,
  MAX_STDERR,
};
