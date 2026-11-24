'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveHerokuCli, resolveHerokuCommand, buildChildEnv, runFile, utf8CompleteLength,
  HEROKU_TIMEOUT_MS, GIT_TIMEOUT_MS, MAX_STDOUT, MAX_STDERR,
} = require('../lib/exec.js');

const tmpDirs = [];
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hops-exec-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function mkVersion(clientDir, ver) {
  const bin = path.join(clientDir, ver, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node.exe'), '');
  fs.writeFileSync(path.join(bin, 'run.js'), '');
}
function writeCmd(clientDir, ver) {
  fs.mkdirSync(path.join(clientDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(clientDir, 'bin', 'heroku.cmd'),
    `@echo off\r\n"%~dp0..\\${ver}\\bin\\heroku.cmd" %*\r\n`
  );
}
function writeScript(dir, body) {
  const f = path.join(dir, 's' + Math.random().toString(36).slice(2) + '.js');
  fs.writeFileSync(f, body);
  return f;
}
const WIN = { skip: process.platform !== 'win32' };
const endsWith = (p, parts) => p.endsWith(path.join(...parts));

test('constants', () => {
  assert.strictEqual(HEROKU_TIMEOUT_MS, 60000);
  assert.strictEqual(GIT_TIMEOUT_MS, 30000);
  assert.strictEqual(MAX_STDOUT, 65536);
  assert.strictEqual(MAX_STDERR, 4096);
});

test('resolve: follows the version named by heroku.cmd', WIN, () => {
  const la = mkTmp();
  const client = path.join(la, 'heroku', 'client');
  mkVersion(client, '11.13.0-x');
  mkVersion(client, '11.14.0-847d18e');
  writeCmd(client, '11.14.0-847d18e');
  const r = resolveHerokuCli({ localAppData: la, programFiles: path.join(la, 'pf') });
  assert.ok(endsWith(r.node, ['11.14.0-847d18e', 'bin', 'node.exe']), r.node);
  assert.ok(endsWith(r.script, ['11.14.0-847d18e', 'bin', 'run.js']), r.script);
});

test('resolve: returns the new version after an auto-update', WIN, () => {
  const la = mkTmp();
  const client = path.join(la, 'heroku', 'client');
  mkVersion(client, '11.14.0-847d18e');
  writeCmd(client, '11.14.0-847d18e');
  const pf = path.join(la, 'pf');
  assert.ok(endsWith(resolveHerokuCli({ localAppData: la, programFiles: pf }).node, ['11.14.0-847d18e', 'bin', 'node.exe']));
  mkVersion(client, '11.15.0-y');
  writeCmd(client, '11.15.0-y');
  assert.ok(endsWith(resolveHerokuCli({ localAppData: la, programFiles: pf }).node, ['11.15.0-y', 'bin', 'node.exe']));
});

test('resolve: without heroku.cmd, the highest semver version', WIN, () => {
  const la = mkTmp();
  const client = path.join(la, 'heroku', 'client');
  mkVersion(client, '11.9.0-a');
  mkVersion(client, '11.14.0-b');
  const r = resolveHerokuCli({ localAppData: la, programFiles: path.join(la, 'pf') });
  assert.ok(endsWith(r.node, ['11.14.0-b', 'bin', 'node.exe']), r.node);
});

test('resolve: Program Files fallback', WIN, () => {
  const la = mkTmp();
  const pf = mkTmp();
  const bin = path.join(pf, 'heroku', 'client', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node.exe'), '');
  fs.writeFileSync(path.join(bin, 'run'), '');
  const r = resolveHerokuCli({ localAppData: la, programFiles: pf });
  assert.strictEqual(r.node, path.join(bin, 'node.exe'));
  assert.strictEqual(r.script, path.join(bin, 'run'));
});

test('resolve: throws when there is no CLI', WIN, () => {
  const la = mkTmp();
  const pf = mkTmp();
  assert.throws(
    () => resolveHerokuCli({ localAppData: la, programFiles: pf }),
    (e) => /^Heroku CLI not found/.test(e.message)
  );
});

test('resolve: override returns process.execPath + script', () => {
  const r = resolveHerokuCli({ localAppData: '', programFiles: '', override: path.join(path.sep, 'x', 'fake.js') });
  assert.deepStrictEqual(r, { node: process.execPath, script: path.join(path.sep, 'x', 'fake.js') });
});

test('buildChildEnv', () => {
  const env = buildChildEnv({ PATH: 'p', HEROKU_API_KEY: 'k', heroku_api_key: 'k2', Heroku_Api_Key: 'k3', X: '1' });
  assert.strictEqual(env.PATH, 'p');
  assert.strictEqual(env.X, '1');
  assert.ok(!Object.keys(env).some((k) => k.toLowerCase() === 'heroku_api_key'));
  assert.strictEqual(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
  assert.strictEqual(env.GCM_INTERACTIVE, 'never');
  assert.strictEqual(env.HEROKU_REDIRECTED, '1');
  assert.strictEqual(env.NO_COLOR, '1');
});

test('runFile: argv arrives intact without a shell', async () => {
  const d = mkTmp();
  const s = writeScript(d, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const args = ['a b', '"q"', '%PATH%', '$HOME', '&', '|', 'x;y'];
  const r = await runFile(process.execPath, [s, ...args], { env: process.env, timeoutMs: 10000 });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout), args);
});

test('runFile: timeout', async () => {
  const d = mkTmp();
  const s = writeScript(d, 'setInterval(()=>{},1000)');
  const t0 = Date.now();
  const r = await runFile(process.execPath, [s], { env: process.env, timeoutMs: 300 });
  assert.strictEqual(r.timedOut, true);
  assert.ok(Date.now() - t0 < 3000);
});

test('runFile: missing or invalid timeoutMs uses the default (does not fire immediately)', async () => {
  const d = mkTmp();
  const s = writeScript(d, 'setTimeout(()=>process.stdout.write("done"),200)');
  for (const timeoutMs of [undefined, 0, -1, NaN, 'x']) {
    const r = await runFile(process.execPath, [s], { env: process.env, timeoutMs });
    assert.strictEqual(r.timedOut, false, String(timeoutMs));
    assert.strictEqual(r.stdout, 'done');
  }
});

test('runFile: stdin cerrado', async () => {
  const d = mkTmp();
  const s = writeScript(d, "process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log('eof'))");
  const r = await runFile(process.execPath, [s], { env: process.env, timeoutMs: 10000 });
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(r.stdout.trim(), 'eof');
});

test('runFile: truncado', async () => {
  const d = mkTmp();
  const s = writeScript(d, "process.stdout.write('x'.repeat(1024*1024))");
  const r = await runFile(process.execPath, [s], { env: process.env, timeoutMs: 10000 });
  assert.ok(r.stdout.length <= 65536);
  assert.strictEqual(r.truncated, true);
});

test('utf8CompleteLength descarta solo una secuencia final incompleta', () => {
  assert.strictEqual(utf8CompleteLength(Buffer.from('abc')), 3);
  assert.strictEqual(utf8CompleteLength(Buffer.from('añ')), 3);
  assert.strictEqual(utf8CompleteLength(Buffer.from([0x61, 0xC3])), 1);
  assert.strictEqual(utf8CompleteLength(Buffer.from([0x61, 0xE2, 0x82])), 1);
  assert.strictEqual(utf8CompleteLength(Buffer.from([0x61, 0xF0, 0x9F, 0x98])), 1);
  assert.strictEqual(utf8CompleteLength(Buffer.from('a😀')), 5);
  assert.strictEqual(utf8CompleteLength(Buffer.alloc(0)), 0);
});

test('runFile: truncation does not split a UTF-8 character', async () => {
  const d = mkTmp();
  const s = writeScript(d, "process.stdout.write('x'.repeat(65535) + 'ñ' + 'y'.repeat(10))");
  const r = await runFile(process.execPath, [s], { env: process.env, timeoutMs: 10000 });
  assert.strictEqual(r.truncated, true);
  assert.ok(!r.stdout.includes('\uFFFD'));
  assert.strictEqual(r.stdout, 'x'.repeat(65535));
});

test('runFile: a timeout cut does not split a UTF-8 character either', async () => {
  const d = mkTmp();
  const s = writeScript(d, "process.stdout.write(Buffer.from([0x78, 0xC3]));setInterval(()=>{},1000)");
  const r = await runFile(process.execPath, [s], { env: process.env, timeoutMs: 1500 });
  assert.strictEqual(r.timedOut, true);
  assert.ok(!r.stdout.endsWith('�'), JSON.stringify(r.stdout));
  assert.strictEqual(r.stdout, 'x');
});

test('runFile: truncated stderr does not split a UTF-8 character either', async () => {
  const d = mkTmp();
  const s = writeScript(d, "process.stderr.write('x'.repeat(4095) + 'ñ')");
  const r = await runFile(process.execPath, [s], { env: process.env, timeoutMs: 10000 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.stderr, 'x'.repeat(4095));
});

test('runFile: exit code', async () => {
  const d = mkTmp();
  const s = writeScript(d, 'process.exit(3)');
  const r = await runFile(process.execPath, [s], { env: process.env, timeoutMs: 10000 });
  assert.strictEqual(r.code, 3);
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(r.truncated, false);
});

test('resolveHerokuCommand: override runs the script with node', () => {
  const script = path.join(path.sep, 'x', 'fake.js');
  assert.deepStrictEqual(resolveHerokuCommand({ override: script, env: {} }), { file: process.execPath, prefixArgs: [script] });
});

test('resolveHerokuCommand: non-Windows finds heroku on PATH', () => {
  const d = mkTmp();
  fs.writeFileSync(path.join(d, 'heroku'), '');
  const r = resolveHerokuCommand({ platform: 'linux', env: { PATH: [mkTmp(), d].join(path.delimiter) } });
  assert.deepStrictEqual(r, { file: path.join(d, 'heroku'), prefixArgs: [] });
});

test('resolveHerokuCommand: non-Windows throws an English error when heroku is not on PATH', () => {
  assert.throws(
    () => resolveHerokuCommand({ platform: 'linux', env: { PATH: mkTmp() } }),
    (e) => /^Heroku CLI not found/.test(e.message)
  );
});
