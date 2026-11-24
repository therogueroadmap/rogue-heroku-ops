'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getToken, buildOfficialSpawn, findPsqlDir } = require('../launch-official.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-official-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeCli(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body);
  return file;
}
const noSession = () =>
  fakeCli('nosession.js', "process.stderr.write('SECRET-LIKE-abc123'); process.stdout.write('SECRET-LIKE-abc123'); process.exit(1);");

test('getToken: no session → ok false, message mentions heroku login, never echoes stdout/stderr', async () => {
  const r = await getToken({ herokuFile: noSession(), env: {}, platform: process.platform });
  assert.equal(r.ok, false);
  assert.match(r.message, /heroku login/);
  assert.doesNotMatch(r.message, /SECRET-LIKE/);
});

test('getToken: trims token from stdout', async () => {
  const f = fakeCli('ok.js', "process.stdout.write('tok\\n');");
  const r = await getToken({ herokuFile: f, env: {}, platform: process.platform });
  assert.deepEqual(r, { ok: true, token: 'tok' });
});

test('getToken: empty stdout → ok false', async () => {
  const f = fakeCli('empty.js', "process.stdout.write('  \\n');");
  const r = await getToken({ herokuFile: f, env: {}, platform: process.platform });
  assert.equal(r.ok, false);
  assert.match(r.message, /heroku login/);
});

test('buildOfficialSpawn pins 1.2.15 and sets HEROKU_API_KEY only in child env', () => {
  const env = { PATH: 'x' };
  const s = buildOfficialSpawn({ token: 't', env, platform: 'linux' });
  assert.equal(s.args.at(-1), '@heroku/mcp-server@1.2.15');
  assert.equal(s.env.HEROKU_API_KEY, 't');
  assert.equal(env.HEROKU_API_KEY, undefined);
});

test('buildOfficialSpawn on win32 runs npx through node npx-cli.js, not npx.cmd', () => {
  const s = buildOfficialSpawn({ token: 't', env: {}, platform: 'win32' });
  assert.doesNotMatch(s.file, /\.cmd$/i);
  assert.equal(s.file, process.execPath);
  assert.match(s.args[0], /npx-cli\.js$/);
  assert.equal(s.args.at(-1), '@heroku/mcp-server@1.2.15');
});

test('main: no session → exit code 1, stderr has message, stdout empty', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'launch-official.js')], {
    env: { ...process.env, HEROKU_OPS_TEST_HEROKU: noSession() },
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Run "heroku login" and restart Claude Code\./);
  assert.doesNotMatch(r.stderr, /SECRET-LIKE/);
  assert.equal(r.stdout, '');
});

// Fake PostgreSQL install tree (<ProgramFiles>/PostgreSQL/<version>/bin) under a temp dir.
let pgCount = 0;
function fakePg(versions, { withPsql = true } = {}) {
  const pf = path.join(tmp, `pf${pgCount++}`);
  for (const v of versions) {
    const bin = path.join(pf, 'PostgreSQL', v, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    if (withPsql) fs.writeFileSync(path.join(bin, 'psql.exe'), '');
  }
  fs.mkdirSync(pf, { recursive: true });
  return pf;
}

test('findPsqlDir: picks the highest version numerically (9.6, 16, 18 -> 18)', () => {
  const pf = fakePg(['9.6', '16', '18']);
  assert.equal(findPsqlDir({ env: { ProgramFiles: pf, PATH: '' }, platform: 'win32' }), path.join(pf, 'PostgreSQL', '18', 'bin'));
});

test('findPsqlDir: 9.6 vs 16 is numeric, not textual', () => {
  const pf = fakePg(['9.6', '16']);
  assert.equal(findPsqlDir({ env: { ProgramFiles: pf }, platform: 'win32' }), path.join(pf, 'PostgreSQL', '16', 'bin'));
});

test('findPsqlDir: psql already on PATH -> null', () => {
  const pf = fakePg(['18']);
  const onPath = path.join(tmp, 'onpath');
  fs.mkdirSync(onPath, { recursive: true });
  fs.writeFileSync(path.join(onPath, 'psql.exe'), '');
  assert.equal(findPsqlDir({ env: { ProgramFiles: pf, Path: onPath }, platform: 'win32' }), null);
});

test('findPsqlDir: no installation -> null', () => {
  const pf = path.join(tmp, 'empty-pf');
  fs.mkdirSync(pf, { recursive: true });
  assert.equal(findPsqlDir({ env: { ProgramFiles: pf, PATH: '' }, platform: 'win32' }), null);
  assert.equal(findPsqlDir({ env: { ProgramFiles: fakePg(['18'], { withPsql: false }) }, platform: 'win32' }), null);
});

test('findPsqlDir: non-win32 platform -> null', () => {
  const pf = fakePg(['18']);
  assert.equal(findPsqlDir({ env: { ProgramFiles: pf, PATH: '' }, platform: 'linux' }), null);
  assert.equal(findPsqlDir({ env: { ProgramFiles: pf, PATH: '' }, platform: 'darwin' }), null);
});

test('buildOfficialSpawn win32: prepends the psql folder to the existing PATH key without duplicating it', () => {
  const pf = fakePg(['16', '18']);
  const bin = path.join(pf, 'PostgreSQL', '18', 'bin');
  const upper = buildOfficialSpawn({ token: 't', env: { ProgramFiles: pf, PATH: 'C:\\x' }, platform: 'win32' });
  assert.equal(upper.env.PATH, `${bin};C:\\x`);
  assert.equal(upper.env.Path, undefined);
  const mixed = buildOfficialSpawn({ token: 't', env: { ProgramFiles: pf, Path: 'C:\\x' }, platform: 'win32' });
  assert.equal(mixed.env.Path, `${bin};C:\\x`);
  assert.equal(mixed.env.PATH, undefined);
});

test('buildOfficialSpawn: PATH untouched when no psql is detected or platform is not win32', () => {
  const pf = fakePg(['18']);
  const lin = buildOfficialSpawn({ token: 't', env: { ProgramFiles: pf, PATH: '/usr/bin' }, platform: 'linux' });
  assert.equal(lin.env.PATH, '/usr/bin');
  const none = buildOfficialSpawn({ token: 't', env: { ProgramFiles: path.join(tmp, 'nope'), PATH: 'C:\\x' }, platform: 'win32' });
  assert.equal(none.env.PATH, 'C:\\x');
});
