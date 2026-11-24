'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { pickReleaseFields } = require('../lib/tools');

const SERVER = path.join(__dirname, '..', 'server.js');
const APP = 'app-test';
const RELEASES_JSON = '[{"version":7,"description":"Deploy abc1234","status":"succeeded","created_at":"2026-11-23T00:00:00Z","user":{"email":"po@x","id":"u1"},"addon_plan_names":["x"],"slug":{"id":"s"},"DATABASE_URL":"postgres://secret"}]';

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

let tmp, repo, fakeDir, cfgPath, httpServer, healthPort, client;
const clients = [];

function git(...args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
}

async function startClient(envOverrides = {}) {
  const env = {
    HEROKU_OPS_CONFIG: cfgPath,
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

async function startClientWithHealth(healthUrl) {
  const f = path.join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ apps: [APP], repoPath: repo, deployBranch: 'main', healthUrl }));
  return startClient({ HEROKU_OPS_CONFIG: f });
}

const text = (res) => res.content.map((p) => p.text).join('\n');
const last = () => JSON.parse(fs.readFileSync(path.join(fakeDir, 'last.json'), 'utf8'));
const setMode = (m) => fs.writeFileSync(path.join(fakeDir, 'mode'), m);
const resetFake = () => {
  fs.rmSync(path.join(fakeDir, 'last.json'), { force: true });
  fs.rmSync(path.join(fakeDir, 'mode'), { force: true });
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-srv-'));
  repo = path.join(tmp, 'repo');
  fakeDir = path.join(tmp, 'fake');
  fs.mkdirSync(repo);
  fs.mkdirSync(fakeDir);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'V1__a.sql'), 'create table a(id int);\n');
  git('add', '.');
  git('commit', '-q', '-m', 'primer commit');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hola\n');
  git('add', '.');
  git('commit', '-q', '-m', 'segundo commit');
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
  cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    apps: [APP], repoPath: repo, deployBranch: 'main', healthUrl: `http://127.0.0.1:${healthPort}/health`,
  }));
  client = await startClient();
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await new Promise((r) => { httpServer.close(r); httpServer.closeAllConnections(); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('listTools devuelve exactamente las 9 herramientas', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'backup_capture', 'backup_info', 'git_diff', 'git_fetch', 'git_log', 'git_ls_tree', 'git_show', 'health_check', 'releases_list',
  ]);
});

test('releases_list pasa args correctos, quita HEROKU_API_KEY y filtra campos', async () => {
  resetFake();
  const res = await client.callTool({ name: 'releases_list', arguments: { app: APP, limit: 3 } });
  assert.notEqual(res.isError, true);
  assert.deepEqual(last().args, ['releases', '-n', '3', '-a', APP, '--json']);
  assert.equal(last().key, 'unset');
  const t = text(res);
  assert.match(t, /Deploy abc1234/);
  assert.match(t, /po@x/);
  assert.doesNotMatch(t, /secret|addon_plan_names|slug/);
});

test('releases_list con salida no JSON devuelve error', async () => {
  resetFake();
  setMode('warning');
  const res = await client.callTool({ name: 'releases_list', arguments: { app: APP } });
  assert.equal(res.isError, true);
  assert.match(text(res), /La CLI no devolvió JSON/);
  assert.doesNotMatch(text(res), /update available|Warning/);
});

test('backup_capture con timeout avisa de que el backup puede seguir en curso', async () => {
  resetFake();
  setMode('sleep');
  const c = await startClient({ HEROKU_OPS_TEST_TIMEOUT_MS: '500' });
  const res = await c.callTool({ name: 'backup_capture', arguments: { app: APP } });
  assert.equal(res.isError, true);
  assert.match(text(res), /el backup puede seguir en curso en Heroku/);
  assert.match(text(res), /pg_backups/);
});

test('backup_capture ejecuta pg:backups:capture', async () => {
  resetFake();
  const res = await client.callTool({ name: 'backup_capture', arguments: { app: APP } });
  assert.notEqual(res.isError, true);
  assert.deepEqual(last().args, ['pg:backups:capture', '-a', APP]);
});

test('app no configurada: error de validación y la CLI no se ejecuta', async () => {
  resetFake();
  const res = await client.callTool({ name: 'releases_list', arguments: { app: 'otra' } });
  assert.equal(res.isError, true);
  assert.equal(fs.existsSync(path.join(fakeDir, 'last.json')), false);
});

test('git_fetch con referencias nuevas confirma el éxito y lista lo actualizado', async () => {
  const res = await client.callTool({ name: 'git_fetch', arguments: {} });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /^git fetch origin completado\./);
  assert.match(text(res), /origin\/main/);
  assert.doesNotMatch(text(res), /\(sin salida\)/);
});

test('git_fetch sin novedades lo dice explícitamente', async () => {
  await client.callTool({ name: 'git_fetch', arguments: {} });
  const res = await client.callTool({ name: 'git_fetch', arguments: {} });
  assert.notEqual(res.isError, true);
  assert.equal(text(res), 'git fetch origin completado. Sin referencias nuevas.');
});

test('git_log devuelve el mensaje del segundo commit', async () => {
  const res = await client.callTool({ name: 'git_log', arguments: { rev: 'HEAD', format: 'oneline', n: 5 } });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /segundo commit/);
});

test('git_show devuelve el contenido del archivo', async () => {
  const res = await client.callTool({ name: 'git_show', arguments: { rev: 'HEAD', path: 'src/V1__a.sql' } });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /create table a/);
});

test('git_show con path traversal es error', async () => {
  const res = await client.callTool({ name: 'git_show', arguments: { rev: 'HEAD', path: '../x' } });
  assert.equal(res.isError, true);
});

test('git_ls_tree lista archivos', async () => {
  const res = await client.callTool({ name: 'git_ls_tree', arguments: { rev: 'HEAD', recursive: true, nameOnly: true } });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /src\/V1__a\.sql/);
});

test('git_diff entre dos commits', async () => {
  const sha1 = git('rev-parse', 'HEAD~1').trim();
  const res = await client.callTool({ name: 'git_diff', arguments: { from: sha1, to: 'HEAD', format: 'name-only' } });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /README\.md/);
});

test('health_check devuelve HTTP 200 y el cuerpo', async () => {
  const res = await client.callTool({ name: 'health_check', arguments: {} });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /HTTP 200 en \d+ ms/);
  assert.match(text(res), /"status":"UP"/);
});

test('health_check vacía el decodificador al final del cuerpo', async () => {
  const c = await startClientWithHealth(`http://127.0.0.1:${healthPort}/partial`);
  const res = await c.callTool({ name: 'health_check', arguments: {} });
  assert.notEqual(res.isError, true);
  assert.ok(text(res).endsWith('{"status":"UP"}\uFFFD'), JSON.stringify(text(res)));
});

test('health_check con error de red devuelve isError en español', async () => {
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const c = await startClientWithHealth(`http://127.0.0.1:${port}/health`);
  const res = await c.callTool({ name: 'health_check', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(text(res), /^No se pudo consultar el health check: /);
});

test('CLI con código 2 y stderr devuelve error', async () => {
  resetFake();
  setMode('fail');
  const res = await client.callTool({ name: 'backup_info', arguments: { app: APP } });
  assert.equal(res.isError, true);
  assert.match(text(res), /Código 2/);
  assert.match(text(res), /boom/);
});

test('salida grande se trunca y lo indica', async () => {
  resetFake();
  setMode('big');
  const res = await client.callTool({ name: 'backup_info', arguments: { app: APP } });
  assert.match(text(res), /\[salida truncada\]/);
  assert.ok(text(res).length < 70000);
});

test('sin CLI de Heroku: error en herramientas Heroku, git y health siguen funcionando', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-nocli-'));
  try {
    const c = await startClient({ HEROKU_OPS_TEST_CLI: undefined, LOCALAPPDATA: empty, PROGRAMFILES: empty });
    const r1 = await c.callTool({ name: 'backup_info', arguments: { app: APP } });
    assert.equal(r1.isError, true);
    assert.match(text(r1), /No se encontró la CLI de Heroku/);
    const r2 = await c.callTool({ name: 'git_log', arguments: { rev: 'HEAD', n: 1 } });
    assert.notEqual(r2.isError, true);
    const r3 = await c.callTool({ name: 'health_check', arguments: {} });
    assert.notEqual(r3.isError, true);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('config inválida: el servidor sale con código distinto de 0 y mensaje en español', () => {
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ apps: [], repoPath: repo, deployBranch: 'main', healthUrl: 'ftp://x' }));
  const r = spawnSync(process.execPath, [SERVER], { env: { ...process.env, HEROKU_OPS_CONFIG: bad }, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Configuración inválida/);
});

test('pickReleaseFields conserva solo los campos permitidos y exige un arreglo', () => {
  assert.deepEqual(pickReleaseFields([{ version: 1, description: 'd', status: 's', created_at: 'c', user: { email: 'e' }, x: 1 }]), [
    { version: 1, description: 'd', status: 's', created_at: 'c', user_email: 'e' },
  ]);
  assert.throws(() => pickReleaseFields({}));
});
