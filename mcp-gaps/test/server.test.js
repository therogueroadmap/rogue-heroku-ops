'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { pickReleaseFields } = require('../lib/tools');

const SERVER = path.join(__dirname, '..', 'server.js');
const PLUGIN_ROOT = path.join(__dirname, '..', '..');
const APP = 'app-test';
const RELEASES_JSON = '[{"version":7,"description":"Deploy abc1234","status":"succeeded","created_at":"2026-11-23T00:00:00Z","user":{"email":"po@x","id":"u1"},"addon_plan_names":["x"],"slug":{"id":"s"},"DATABASE_URL":"postgres://secret"}]';
const SPANISH_MARKERS = /\b(debe|configurada|configurado|parámetro|inválid[ao]|Código|herramienta|no se pudo|salida)\b/i;

const FAKE_CLI = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
fs.writeFileSync(path.join(dir, 'last.json'), JSON.stringify({ args, key: process.env.HEROKU_API_KEY ?? 'unset' }));
let mode = 'ok';
try { mode = fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim(); } catch {}
if (mode === 'warning') { process.stdout.write('Warning: update available\\n' + ${JSON.stringify(RELEASES_JSON)}); }
else if (mode === 'fail') { process.stderr.write('boom'); process.exit(2); }
else if (mode === 'sleep') { setTimeout(() => {}, 30000); }
else if (mode === 'big') { process.stdout.write('x'.repeat(100000)); }
else if (args[0] === 'releases') { process.stdout.write(${JSON.stringify(RELEASES_JSON)}); }
else { process.stdout.write('ok:' + args.join(' ')); }
`;

let tmp, repo, fakeDir, httpServer, healthPort, client;
const clients = [];

function git(...args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
}

function writeConfig(dir, config) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'rogue-heroku-ops.json'), typeof config === 'string' ? config : JSON.stringify(config));
}

function mkProject(config) {
  const dir = fs.mkdtempSync(path.join(tmp, 'proj '));
  if (config !== undefined) writeConfig(dir, config);
  return dir;
}

const appCfg = (name, url, deployBranch = 'main') => ({ name, healthUrl: url, deployBranch });

async function startClient(projectDir, envOverrides = {}) {
  const env = {
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    HEROKU_OPS_TEST_CLI: path.join(fakeDir, 'cli.js'),
    FAKE_DIR: fakeDir,
    HEROKU_API_KEY: 'secret-test',
    ...envOverrides,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'pipe' });
  const c = new Client({ name: 'test', version: '1.0.0' });
  await c.connect(transport);
  clients.push(c);
  return c;
}

// Calls a tool; a schema rejection raised as an exception counts as an error result.
async function call(c, name, args = {}) {
  try {
    return await c.callTool({ name, arguments: args });
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e.message) }] };
  }
}

const text = (res) => res.content.map((p) => p.text).join('\n');
const last = () => JSON.parse(fs.readFileSync(path.join(fakeDir, 'last.json'), 'utf8'));
const setMode = (m) => fs.writeFileSync(path.join(fakeDir, 'mode'), m);
const resetFake = () => {
  fs.rmSync(path.join(fakeDir, 'last.json'), { force: true });
  fs.rmSync(path.join(fakeDir, 'mode'), { force: true });
};
const ALL_TOOLS = [
  'backup_capture', 'backup_info', 'get_config', 'get_procedure', 'git_diff', 'git_fetch', 'git_log',
  'git_ls_tree', 'git_show', 'health_check', 'releases_list',
];

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-srv-'));
  // Project dir with a space in its name: git must run with -C on it.
  repo = path.join(tmp, 'a b', 'repo');
  fakeDir = path.join(tmp, 'fake');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(fakeDir);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'V1__a.sql'), 'create table a(id int);\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first commit');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'second commit');
  const origin = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  // push already creates origin/main locally; drop it so the first git_fetch has something to report.
  git('update-ref', '-d', 'refs/remotes/origin/main');
  fs.writeFileSync(path.join(fakeDir, 'cli.js'), FAKE_CLI);

  httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/partial') {
      res.end(Buffer.concat([Buffer.from('{"status":"UP"}'), Buffer.from([0xC3])]));
      return;
    }
    res.end('{"status":"UP"}');
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  healthPort = httpServer.address().port;
  writeConfig(repo, { apps: [appCfg(APP, `http://127.0.0.1:${healthPort}/health`)] });
  client = await startClient(repo);
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await new Promise((r) => { httpServer.close(r); httpServer.closeAllConnections(); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('listTools returns exactly the 11 tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ALL_TOOLS);
});

test('server starts with missing config; get_config returns isError with setup hint', async () => {
  const c = await startClient(mkProject());
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ALL_TOOLS);
  const res = await call(c, 'get_config');
  assert.equal(res.isError, true);
  assert.match(text(res), /Config file not found/);
  assert.match(text(res), /\/rogue-heroku-ops:setup/);
});

test('invalid config: every tool except get_config/get_procedure returns isError with problems and setup hint, nothing runs', async () => {
  resetFake();
  const c = await startClient(mkProject({ apps: [], extra: true }));
  const cases = [
    ['releases_list', { app: 'whatever' }], ['backup_info', { app: 'whatever' }], ['backup_capture', { app: 'whatever' }],
    ['health_check', { app: 'whatever' }], ['git_fetch', {}], ['git_log', { rev: 'HEAD' }],
    ['git_show', { rev: 'HEAD' }], ['git_ls_tree', { rev: 'HEAD' }], ['git_diff', { from: 'HEAD', to: 'HEAD' }],
  ];
  for (const [name, args] of cases) {
    const res = await call(c, name, args);
    assert.equal(res.isError, true, name);
    assert.match(text(res), /apps must be a non-empty array/, name);
    assert.match(text(res), /unknown key "extra"/, name);
    assert.match(text(res), /\/rogue-heroku-ops:setup/, name);
  }
  assert.equal(fs.existsSync(path.join(fakeDir, 'last.json')), false);
  const cfgRes = await call(c, 'get_config');
  assert.equal(cfgRes.isError, true);
  assert.match(text(cfgRes), /apps must be a non-empty array/);
  const proc = await call(c, 'get_procedure', { name: 'routine' });
  assert.notEqual(proc.isError, true);
});

test('invalid config: unreadable JSON is reported without leaking file content', async () => {
  const c = await startClient(mkProject('{ not json'));
  const res = await call(c, 'releases_list', { app: 'x' });
  assert.equal(res.isError, true);
  assert.match(text(res), /not valid JSON/);
  assert.match(text(res), /\/rogue-heroku-ops:setup/);
});

test('get_config returns the validated config as JSON', async () => {
  const res = await call(client, 'get_config');
  assert.notEqual(res.isError, true);
  const cfg = JSON.parse(text(res));
  assert.equal(cfg.apps[0].name, APP);
  assert.equal(cfg.n1Mode, 'ask');
});

test('get_procedure returns procedures/routine.md text; rejects name "../x" via schema', async () => {
  const res = await call(client, 'get_procedure', { name: 'routine' });
  assert.notEqual(res.isError, true);
  assert.equal(text(res), fs.readFileSync(path.join(PLUGIN_ROOT, 'procedures', 'routine.md'), 'utf8'));
  for (const name of ['deploy', 'incident']) {
    assert.notEqual((await call(client, 'get_procedure', { name })).isError, true, name);
  }
  for (const name of ['../x', '../package', 'deploy.md', '']) {
    assert.equal((await call(client, 'get_procedure', { name })).isError, true, name);
  }
});

test('get_procedure falls back to the plugin dir when CLAUDE_PLUGIN_ROOT is missing', async () => {
  const c = await startClient(repo, { CLAUDE_PLUGIN_ROOT: undefined });
  const res = await call(c, 'get_procedure', { name: 'deploy' });
  assert.notEqual(res.isError, true);
  assert.equal(text(res), fs.readFileSync(path.join(PLUGIN_ROOT, 'procedures', 'deploy.md'), 'utf8'));
});

test('get_procedure falls back to the plugin dir when CLAUDE_PLUGIN_ROOT is an unexpanded literal', async () => {
  const c = await startClient(repo, { CLAUDE_PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}' });
  const res = await call(c, 'get_procedure', { name: 'routine' });
  assert.notEqual(res.isError, true);
  assert.equal(text(res), fs.readFileSync(path.join(PLUGIN_ROOT, 'procedures', 'routine.md'), 'utf8'));
});

test('releases_list passes correct args, strips HEROKU_API_KEY and filters fields', async () => {
  resetFake();
  const res = await call(client, 'releases_list', { app: APP, limit: 3 });
  assert.notEqual(res.isError, true);
  assert.deepEqual(last().args, ['releases', '-n', '3', '-a', APP, '--json']);
  assert.equal(last().key, 'unset');
  const t = text(res);
  assert.match(t, /Deploy abc1234/);
  assert.match(t, /po@x/);
  assert.doesNotMatch(t, /secret|addon_plan_names|slug/);
});

test('releases_list with non-JSON output returns an error', async () => {
  resetFake();
  setMode('warning');
  const res = await call(client, 'releases_list', { app: APP });
  assert.equal(res.isError, true);
  assert.match(text(res), /The CLI did not return JSON/);
  assert.doesNotMatch(text(res), /update available|Warning/);
});

test('backup_capture timeout warns that the backup may still be running', async () => {
  resetFake();
  setMode('sleep');
  const c = await startClient(repo, { HEROKU_OPS_TEST_TIMEOUT_MS: '500' });
  const res = await call(c, 'backup_capture', { app: APP });
  assert.equal(res.isError, true);
  assert.match(text(res), /the backup may still be running on Heroku/);
  assert.match(text(res), /pg_backups/);
});

test('backup_capture runs pg:backups:capture', async () => {
  resetFake();
  const res = await call(client, 'backup_capture', { app: APP });
  assert.notEqual(res.isError, true);
  assert.deepEqual(last().args, ['pg:backups:capture', '-a', APP]);
});

test('unconfigured app is rejected and the CLI does not run', async () => {
  resetFake();
  for (const tool of ['releases_list', 'backup_info', 'backup_capture', 'health_check']) {
    const res = await call(client, tool, { app: 'other-app' });
    assert.equal(res.isError, true, tool);
  }
  assert.equal(fs.existsSync(path.join(fakeDir, 'last.json')), false);
});

test('server rejects an app outside the config even when the schema accepts any string', async () => {
  // Startup config is invalid (schema uses a plain string); the config is fixed afterwards.
  resetFake();
  const dir = mkProject({ apps: [] });
  const c = await startClient(dir);
  writeConfig(dir, { apps: [appCfg(APP, 'http://127.0.0.1:1/health')] });
  const res = await call(c, 'releases_list', { app: 'other-app' });
  assert.equal(res.isError, true);
  assert.match(text(res), /app parameter must be one of the configured apps/);
  assert.equal(fs.existsSync(path.join(fakeDir, 'last.json')), false);
  const ok = await call(c, 'releases_list', { app: APP });
  assert.notEqual(ok.isError, true);
});

test('git_fetch with new refs confirms success and lists what was updated', async () => {
  const res = await call(client, 'git_fetch');
  assert.notEqual(res.isError, true);
  assert.match(text(res), /^git fetch origin completed\./);
  assert.match(text(res), /origin\/main/);
  assert.doesNotMatch(text(res), /\(no output\)/);
});

test('git_fetch with nothing new says so explicitly', async () => {
  await call(client, 'git_fetch');
  const res = await call(client, 'git_fetch');
  assert.notEqual(res.isError, true);
  assert.equal(text(res), 'git fetch origin completed. No new references.');
});

test('git runs with -C CLAUDE_PROJECT_DIR (path with spaces)', async () => {
  assert.match(repo, / /);
  assert.notEqual(path.resolve(process.cwd()), path.resolve(repo));
  const res = await call(client, 'git_log', { rev: 'HEAD', format: 'oneline', n: 5 });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /second commit/);
});

test('git_show returns file content', async () => {
  const res = await call(client, 'git_show', { rev: 'HEAD', path: 'src/V1__a.sql' });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /create table a/);
});

test('git_show with path traversal is an error', async () => {
  assert.equal((await call(client, 'git_show', { rev: 'HEAD', path: '../x' })).isError, true);
});

test('git rev origin/<other branch> is rejected by the server', async () => {
  const res = await call(client, 'git_show', { rev: 'origin/other' });
  assert.equal(res.isError, true);
  assert.match(text(res), /rev parameter must be/);
});

test('git accepts origin/<deployBranch of any configured app>', async () => {
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  const cfgFile = path.join(repo, '.claude', 'rogue-heroku-ops.json');
  const saved = fs.readFileSync(cfgFile, 'utf8');
  writeConfig(repo, { apps: [appCfg('app-a', 'http://127.0.0.1:1/h', 'main'), appCfg('app-b', 'http://127.0.0.1:1/h', 'develop')] });
  try {
    const c = await startClient(repo);
    const res = await call(c, 'git_log', { rev: 'origin/develop', format: 'oneline', n: 1 });
    assert.notEqual(res.isError, true, text(res));
    assert.match(text(res), /second commit/);
    assert.equal((await call(c, 'git_log', { rev: 'origin/feature', n: 1 })).isError, true);
  } finally {
    fs.writeFileSync(cfgFile, saved);
    git('update-ref', '-d', 'refs/remotes/origin/develop');
  }
});

test('git_ls_tree lists files', async () => {
  const res = await call(client, 'git_ls_tree', { rev: 'HEAD', recursive: true, nameOnly: true });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /src\/V1__a\.sql/);
});

test('git_diff between two commits', async () => {
  const sha1 = git('rev-parse', 'HEAD~1').trim();
  const res = await call(client, 'git_diff', { from: sha1, to: 'HEAD', format: 'name-only' });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /README\.md/);
});

test('health_check returns HTTP 200 and the body', async () => {
  const res = await call(client, 'health_check', { app: APP });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /HTTP 200 in \d+ ms/);
  assert.match(text(res), /"status":"UP"/);
});

test('health_check uses healthUrl of the requested app', async () => {
  const hits = [];
  const mk = () => new Promise((resolve) => {
    const s = http.createServer((req, res) => { hits.push(`${s.address().port}${req.url}`); res.end(`served-by-${s.address().port}`); });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const [s1, s2] = [await mk(), await mk()];
  try {
    const p1 = s1.address().port;
    const p2 = s2.address().port;
    const dir = mkProject({ apps: [appCfg('app-one', `http://127.0.0.1:${p1}/one`), appCfg('app-two', `http://127.0.0.1:${p2}/two`)] });
    const c = await startClient(dir);
    const r2 = await call(c, 'health_check', { app: 'app-two' });
    assert.match(text(r2), new RegExp(`served-by-${p2}`));
    const r1 = await call(c, 'health_check', { app: 'app-one' });
    assert.match(text(r1), new RegExp(`served-by-${p1}`));
    assert.deepEqual(hits, [`${p2}/two`, `${p1}/one`]);
  } finally {
    for (const s of [s1, s2]) await new Promise((r) => { s.close(r); s.closeAllConnections(); });
  }
});

test('health_check flushes the decoder at the end of the body', async () => {
  const dir = mkProject({ apps: [appCfg(APP, `http://127.0.0.1:${healthPort}/partial`)] });
  const c = await startClient(dir);
  const res = await call(c, 'health_check', { app: APP });
  assert.notEqual(res.isError, true);
  assert.ok(text(res).endsWith('{"status":"UP"}�'), JSON.stringify(text(res)));
});

test('health_check with a network error returns isError in English', async () => {
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const dir = mkProject({ apps: [appCfg(APP, `http://127.0.0.1:${port}/health`)] });
  const c = await startClient(dir);
  const res = await call(c, 'health_check', { app: APP });
  assert.equal(res.isError, true);
  assert.match(text(res), /^Could not query the health check: /);
});

test('CLI exit code 2 with stderr returns an error', async () => {
  resetFake();
  setMode('fail');
  const res = await call(client, 'backup_info', { app: APP });
  assert.equal(res.isError, true);
  assert.match(text(res), /Exit code 2/);
  assert.match(text(res), /boom/);
});

test('large output is truncated and says so', async () => {
  resetFake();
  setMode('big');
  const res = await call(client, 'backup_info', { app: APP });
  assert.match(text(res), /\[output truncated\]/);
  assert.ok(text(res).length < 70000);
});

test('without the Heroku CLI: Heroku tools fail, git and health keep working', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-nocli-'));
  try {
    const whichGit = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    // Hide any real heroku: empty PATH and no Windows install dirs; git is given by absolute path.
    const c = await startClient(repo, {
      HEROKU_OPS_TEST_CLI: undefined, HEROKU_OPS_TEST_GIT: whichGit, PATH: empty, LOCALAPPDATA: empty, PROGRAMFILES: empty, ProgramFiles: empty,
    });
    const r1 = await call(c, 'backup_info', { app: APP });
    assert.equal(r1.isError, true);
    assert.match(text(r1), /Heroku CLI not found/);
    const r2 = await call(c, 'git_log', { rev: 'HEAD', n: 1 });
    assert.notEqual(r2.isError, true, text(r2));
    const r3 = await call(c, 'health_check', { app: APP });
    assert.notEqual(r3.isError, true);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('tool error messages are English', async () => {
  resetFake();
  const texts = [];
  const collect = async (c, name, args) => { const r = await call(c, name, args); assert.equal(r.isError, true, name); texts.push(text(r)); };
  await collect(client, 'releases_list', { app: 'other-app' });
  await collect(client, 'git_show', { rev: 'origin/other' });
  await collect(client, 'git_log', {});
  await collect(client, 'git_show', { rev: 'HEAD', path: '../x' });
  await collect(client, 'git_log', { rev: 'HEAD', n: 0 });
  setMode('fail');
  await collect(client, 'backup_info', { app: APP });
  const noCfg = await startClient(mkProject());
  await collect(noCfg, 'git_fetch', {});
  await collect(noCfg, 'get_config', {});
  for (const t of texts) assert.doesNotMatch(t, SPANISH_MARKERS, t);
});

test('pickReleaseFields keeps only allowed fields and requires an array', () => {
  assert.deepEqual(pickReleaseFields([{ version: 1, description: 'd', status: 's', created_at: 'c', user: { email: 'e' }, x: 1 }]), [
    { version: 1, description: 'd', status: 's', created_at: 'c', user_email: 'e' },
  ]);
  assert.throws(() => pickReleaseFields({}));
});
