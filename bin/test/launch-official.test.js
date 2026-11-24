'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getToken, buildOfficialSpawn } = require('../launch-official.js');

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
