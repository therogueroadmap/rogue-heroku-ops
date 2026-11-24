'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { installDeps, npmCommand } = require('../install-deps.js');

const no = () => false;
const sealOf = (root) => {
  const h = crypto.createHash('sha256');
  for (const f of ['package.json', 'package-lock.json']) h.update(fs.readFileSync(path.join(root, f)));
  return h.digest('hex');
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-deps-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function setup(name) {
  const root = path.join(tmp, name, 'root');
  const data = path.join(tmp, name, 'data');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  return { root, data };
}

test('first run: copies package files to the data dir and runs npm ci there', async () => {
  const { root, data } = setup('first');
  const calls = [];
  const r = await installDeps({ root, data, run: async (cmd, cwd) => { calls.push({ cmd, cwd }); }, resolves: no });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, data);
  assert.ok(calls[0].cmd.args.includes('ci'));
  assert.equal(fs.readFileSync(path.join(data, 'package.json'), 'utf8'), '{"name":"x"}');
  assert.equal(fs.readFileSync(path.join(data, 'package-lock.json'), 'utf8'), '{"lockfileVersion":3}');
});

test('up to date (matching seal and node_modules present): does nothing', async () => {
  const { root, data } = setup('same');
  fs.mkdirSync(path.join(data, 'node_modules'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(data, 'package.json'));
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(data, 'package-lock.json'));
  fs.writeFileSync(path.join(data, '.install-ok'), sealOf(root));
  let n = 0;
  const r = await installDeps({ root, data, run: async () => { n++; }, resolves: no });
  assert.deepEqual(r, { ok: true, skipped: true });
  assert.equal(n, 0);
});

test('package.json changed: installs again', async () => {
  const { root, data } = setup('changed');
  fs.mkdirSync(path.join(data, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(data, 'package.json'), '{"name":"old"}');
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(data, 'package-lock.json'));
  fs.writeFileSync(path.join(data, '.install-ok'), 'stale-seal');
  let n = 0;
  await installDeps({ root, data, run: async () => { n++; }, resolves: no });
  assert.equal(n, 1);
});

test('install failure: removes the copied package.json so the next session retries, returns ok false', async () => {
  const { root, data } = setup('fail');
  const r = await installDeps({ root, data, run: async () => { throw new Error('boom'); }, resolves: no });
  assert.equal(r.ok, false);
  assert.match(r.message, /boom/);
  assert.equal(fs.existsSync(path.join(data, 'package.json')), false);
});

test('success writes the seal with the sha256 of the root package files', async () => {
  const { root, data } = setup('seal');
  await installDeps({ root, data, run: async () => {}, resolves: no });
  assert.equal(fs.readFileSync(path.join(data, '.install-ok'), 'utf8'), sealOf(root));
});

test('interrupted install (node_modules and identical package files but no seal): reinstalls', async () => {
  const { root, data } = setup('interrupted');
  fs.mkdirSync(path.join(data, 'node_modules'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(data, 'package.json'));
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(data, 'package-lock.json'));
  let n = 0;
  await installDeps({ root, data, run: async () => { n++; }, resolves: no });
  assert.equal(n, 1);
});

test('failed install removes a previous seal', async () => {
  const { root, data } = setup('failseal');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, '.install-ok'), 'old');
  await installDeps({ root, data, run: async () => { throw new Error('x'); }, resolves: no });
  assert.equal(fs.existsSync(path.join(data, '.install-ok')), false);
});

test('dependencies resolve from the plugin root: does not run npm', async () => {
  const { root, data } = setup('resolves');
  let n = 0;
  const r = await installDeps({ root, data, run: async () => { n++; }, resolves: (r0) => r0 === root });
  assert.deepEqual(r, { ok: true, skipped: true });
  assert.equal(n, 0);
});

test('no data dir: skips without touching anything', async () => {
  const { root } = setup('nodata');
  const r = await installDeps({ root, data: undefined, run: async () => { throw new Error('no'); } });
  assert.deepEqual(r, { ok: true, skipped: true });
});

test('npmCommand on win32 runs npm through node npm-cli.js, not npm.cmd', () => {
  const c = npmCommand('win32');
  assert.equal(c.file, process.execPath);
  assert.match(c.args[0], /npm-cli\.js$/);
  assert.equal(npmCommand('linux').file, 'npm');
});
