'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateConfig, loadProjectConfig, appByName, deployBranches, repoDirFor, readRoots, NO_REPO_REASON, SETUP_HINT, CONFIG_RELATIVE_PATH } = require('../config');

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
test('healthUrl with embedded credentials rejected without echoing them', () => {
  for (const healthUrl of ['https://u:p@x.example/h', 'https://u@x.example/h', 'https://:p@x.example/h']) {
    const problems = validateConfig({ apps: [{ ...valid.apps[0], healthUrl }] });
    assert.ok(problems.some(p => p.includes('must not contain credentials')), healthUrl);
    assert.ok(problems.every(p => !p.includes('u:p') && !p.includes(':p@')), healthUrl);
  }
});
test('duplicate app names rejected', () => assert.ok(validateConfig({ apps: [valid.apps[0], valid.apps[0]] }).length > 0));
test('deployBranch must match branch grammar', () => assert.ok(validateConfig({ apps: [{ ...valid.apps[0], deployBranch: '../x' }] }).length > 0));
const withApp = (extra) => ({ apps: [{ ...valid.apps[0], ...extra }] });
function fakeRepo({ gitFile = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-repo-'));
  if (gitFile) fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere');
  else fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}
const repoProblems = (p) => validateConfig(withApp({ repoPath: p })).filter((x) => x.includes('apps[0].repoPath'));

test('migrations.appliedQuery must be read-only SQL', () => {
  const m = { repoDir: 'db/migration', filePattern: '^V([0-9]+)__.+[.]sql$' };
  assert.deepEqual(validateConfig(withApp({ migrations: { ...m, appliedQuery: 'SELECT version, success FROM flyway_schema_history' } })), []);
  assert.ok(validateConfig(withApp({ migrations: { ...m, appliedQuery: 'DELETE FROM flyway_schema_history' } })).some((p) => p.includes('apps[0].migrations.appliedQuery')));
});
test('migrations.filePattern must compile and repoDir be a safe relative path', () => {
  const problems = validateConfig(withApp({ migrations: { repoDir: '../x', appliedQuery: 'SELECT 1', filePattern: '(' } }));
  assert.ok(problems.some((p) => p.includes('apps[0].migrations.repoDir')));
  assert.ok(problems.some((p) => p.includes('apps[0].migrations.filePattern')));
});
test('root migrations rejected with migration hint', () => {
  const m = { repoDir: 'db/migration', appliedQuery: 'SELECT 1', filePattern: '^V' };
  assert.ok(validateConfig({ ...valid, migrations: m }).includes('config: migrations moved into each app in 0.2.0; run /rogue-heroku-ops:setup to migrate.'));
});
test('repoPath absolute git root accepted', () => assert.deepEqual(validateConfig(withApp({ repoPath: fakeRepo() })), []));
test('repoPath with .git file (worktree) accepted', () => assert.deepEqual(validateConfig(withApp({ repoPath: fakeRepo({ gitFile: true }) })), []));
test('repoPath trailing separator accepted', () => assert.deepEqual(validateConfig(withApp({ repoPath: fakeRepo() + path.sep })), []));
test('repoPath rejected: relative', () => assert.ok(repoProblems('some/relative').length > 0));
test('repoPath rejected: with .. segment', () => {
  const repo = fakeRepo();
  const sneaky = repo + path.sep + '..' + path.sep + path.basename(repo);
  assert.ok(repoProblems(sneaky).length > 0);
});
test('repoPath rejected: drive root', { skip: process.platform !== 'win32' }, () => assert.ok(repoProblems(`C:${path.sep}`).length > 0));
test('repoPath rejected: UNC', { skip: process.platform !== 'win32' }, () => assert.ok(repoProblems(['', '', 'server', 'share', 'repo'].join(path.sep)).length > 0));
test('repoPath rejected: posix root', { skip: process.platform === 'win32' }, () => assert.ok(repoProblems('/').length > 0));
test('repoPath rejected: missing dir', () => assert.ok(repoProblems(path.join(os.tmpdir(), 'rho-does-not-exist-xyz')).length > 0));
test('repoPath rejected: dir without .git', () => assert.ok(repoProblems(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-nogit-'))).length > 0));
test('repoPath rejected: non-string', () => assert.ok(repoProblems(42).length > 0));

test('repoDirFor returns repoPath', () => {
  const repo = fakeRepo();
  const cfg = loadProjectConfig(tmpProject(withApp({ repoPath: repo }))).config;
  assert.deepEqual(repoDirFor(cfg, 'my-app', tmpProject(valid)), { ok: true, dir: repo, source: 'repoPath' });
});
test('repoDirFor strips trailing separator from repoPath', () => {
  const repo = fakeRepo();
  const cfg = { apps: [{ ...valid.apps[0], repoPath: repo + path.sep }] };
  assert.equal(repoDirFor(cfg, 'my-app', 'x').dir, repo);
});
test('repoDirFor falls back to project only when project has its own .git', () => {
  const withGit = fakeRepo();
  assert.deepEqual(repoDirFor(valid, 'my-app', withGit), { ok: true, dir: withGit, source: 'project' });
  const noGit = tmpProject(valid);
  assert.deepEqual(repoDirFor(valid, 'my-app', noGit), { ok: false, reason: NO_REPO_REASON('my-app') });
});
test('NO_REPO_REASON text', () => assert.equal(NO_REPO_REASON('my-app'), 'App my-app has no repository: set repoPath in the config or open the session in the repository root.'));
test('repoDirFor does not use a parent repo', () => {
  const parent = fakeRepo();
  const child = path.join(parent, 'child'); fs.mkdirSync(child);
  assert.equal(repoDirFor(valid, 'my-app', child).ok, false);
});
test('repoDirFor unknown app', () => assert.equal(repoDirFor(valid, 'nope', fakeRepo()).ok, false));
test('readRoots dedupes and keeps project first', () => {
  const project = tmpProject(valid);
  const repo = fakeRepo();
  const other = process.platform === 'win32' ? repo.toUpperCase() : repo;
  const cfg = { apps: [{ ...valid.apps[0], repoPath: repo }, { ...valid.apps[0], name: 'other-app', repoPath: other }] };
  const roots = readRoots(cfg, project);
  assert.equal(roots.length, 2);
  assert.equal(roots[0], project);
  assert.equal(roots[1], repo);
});
test('config becomes invalid after repoPath is removed', () => {
  const repo = fakeRepo();
  const project = tmpProject(withApp({ repoPath: repo }));
  assert.equal(loadProjectConfig(project).ok, true);
  fs.rmSync(repo, { recursive: true });
  const r = loadProjectConfig(project);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('apps[0].repoPath')));
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
