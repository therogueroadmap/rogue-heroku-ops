'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateConfig, loadProjectConfig, appByName, deployBranches, SETUP_HINT, CONFIG_RELATIVE_PATH } = require('../config');

const CLI = path.join(__dirname, '..', '..', 'bin', 'validate-config.js');
const valid = { apps: [{ name: 'my-app', healthUrl: 'https://my-app.herokuapp.com/health', deployBranch: 'main' }] };

function tmpProject(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-cfg-'));
  if (content !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, CONFIG_RELATIVE_PATH), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('valid minimal config has no problems', () => assert.deepEqual(validateConfig(valid), []));
test('n1Mode defaults to ask', () => assert.equal(loadProjectConfig(tmpProject(valid)).config.n1Mode, 'ask'));
test('n1Mode deny accepted, other values rejected', () => {
  assert.deepEqual(validateConfig({ ...valid, n1Mode: 'deny' }), []);
  assert.ok(validateConfig({ ...valid, n1Mode: 'allow' }).length > 0);
});
test('unknown key rejected (sqlRewrite)', () => assert.ok(validateConfig({ ...valid, sqlRewrite: true }).some(p => p.includes('sqlRewrite'))));
test('unknown key in app rejected', () => assert.ok(validateConfig({ apps: [{ ...valid.apps[0], extra: 1 }] }).some(p => p.includes('extra'))));
test('non-object config rejected', () => { for (const c of [null, [], 'x', 3]) assert.ok(validateConfig(c).length > 0); });
test('apps must be non-empty array of objects with name, healthUrl http(s), deployBranch', () => {
  for (const apps of [[], ['my-app'], [{ name: 'a', healthUrl: 'ftp://x', deployBranch: 'main' }], [{ name: 'a', healthUrl: 'https://x' }], [{ name: 'Bad_Name', healthUrl: 'https://x', deployBranch: 'main' }]])
    assert.ok(validateConfig({ apps }).length > 0);
});
test('duplicate app names rejected', () => assert.ok(validateConfig({ apps: [valid.apps[0], valid.apps[0]] }).length > 0));
test('deployBranch must match branch grammar', () => assert.ok(validateConfig({ apps: [{ ...valid.apps[0], deployBranch: '../x' }] }).length > 0));
test('migrations.appliedQuery must be read-only SQL', () => {
  const m = { repoDir: 'db/migration', filePattern: '^V(\d+)__.+\.sql$' };
  assert.deepEqual(validateConfig({ ...valid, migrations: { ...m, appliedQuery: 'SELECT version, success FROM flyway_schema_history' } }), []);
  assert.ok(validateConfig({ ...valid, migrations: { ...m, appliedQuery: 'DELETE FROM flyway_schema_history' } }).length > 0);
});
test('migrations.filePattern must compile and repoDir be a safe relative path', () => {
  assert.ok(validateConfig({ ...valid, migrations: { repoDir: '../x', appliedQuery: 'SELECT 1', filePattern: '(' } }).length >= 2);
});
test('missing projectDir -> not ok, file null, SETUP_HINT in problems', () => {
  const r = loadProjectConfig(undefined);
  assert.equal(r.ok, false); assert.equal(r.file, null);
  assert.ok(r.problems.join(' ').includes('/rogue-heroku-ops:setup'));
});
test('missing file and broken JSON -> not ok with SETUP_HINT', () => {
  for (const dir of [tmpProject(), tmpProject('{ nope')]) {
    const r = loadProjectConfig(dir);
    assert.equal(r.ok, false);
    assert.equal(r.file, path.join(dir, CONFIG_RELATIVE_PATH));
    assert.ok(r.problems.includes(SETUP_HINT));
  }
});
test('no upward search: config in parent dir is ignored', () => {
  const parent = tmpProject(valid);
  const child = path.join(parent, 'child'); fs.mkdirSync(child);
  assert.equal(loadProjectConfig(child).ok, false);
});
test('loaded config is deeply frozen', () => {
  const r = loadProjectConfig(tmpProject(valid));
  assert.ok(Object.isFrozen(r.config) && Object.isFrozen(r.config.apps) && Object.isFrozen(r.config.apps[0]));
});
test('appByName and deployBranches', () => {
  const cfg = loadProjectConfig(tmpProject({ apps: [valid.apps[0], { ...valid.apps[0], name: 'other-app' }] })).config;
  assert.equal(appByName(cfg, 'other-app').name, 'other-app');
  assert.equal(appByName(cfg, 'nope'), undefined);
  assert.deepEqual(deployBranches(cfg), ['main']);
});
test('validate-config CLI exits 0 on valid and 1 on invalid', () => {
  const ok = tmpProject(valid);
  assert.match(execFileSync(process.execPath, [CLI, ok], { encoding: 'utf8' }), /^OK /);
  const bad = tmpProject({ apps: [] });
  assert.throws(() => execFileSync(process.execPath, [CLI, bad], { encoding: 'utf8', stdio: 'pipe' }), (e) => e.status === 1 && /^INVALID /.test(e.stdout));
});
