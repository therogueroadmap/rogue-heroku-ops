'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/policy');

const ROOT = 'C:\\Users\\dev\\plugin-root';
const cfg = {
  apps: ['my-app'],
  healthUrl: 'https://example.invalid/health',
  repoPath: 'C:\\repo',
  deployBranch: 'releaseCandidate',
  postgresBin: 'C:\\Program Files\\PostgreSQL\\18\\bin',
  n1Mode: 'ask',
  sqlRewrite: true,
};
const APP = 'my-app';

test('classifyMcpTool', () => {
  const c = policy.classifyMcpTool;
  assert.deepEqual(c('mcp__heroku-ops__pg_info'), { level: 'N0', tool: 'pg_info', server: 'official' });
  assert.deepEqual(c('mcp__heroku-ops__pg_psql'), { level: 'N0', tool: 'pg_psql', server: 'official' });
  assert.deepEqual(c('mcp__heroku-ops__ps_restart'), { level: 'N1', tool: 'ps_restart', server: 'official' });
  assert.equal(c('mcp__heroku-ops__maintenance_on').level, 'N1');
  assert.equal(c('mcp__heroku-ops__maintenance_off').level, 'N1');
  for (const t of ['get_app_info', 'deploy_to_heroku', 'made_up_tool']) {
    assert.deepEqual(c('mcp__heroku-ops__' + t), { level: 'N3', tool: t, server: 'official' });
  }
  assert.deepEqual(c('mcp__heroku__pg_info'), { level: 'N3', tool: null, server: null });
  assert.deepEqual(c(undefined), { level: 'N3', tool: null, server: null });
  assert.deepEqual(c('Bash'), { level: 'N3', tool: null, server: null });
});

test('sets contain the exact tools and cannot be mutated', () => {
  assert.equal(policy.MCP_PREFIX, 'mcp__heroku-ops__');
  assert.equal(policy.MCP_N0.size, 13);
  assert.equal(policy.MCP_N1.size, 3);
  assert.throws(() => policy.MCP_N0.add('deploy_to_heroku'), TypeError);
  assert.throws(() => policy.MCP_N1.delete('ps_restart'), TypeError);
  assert.equal(policy.MCP_N0.has('deploy_to_heroku'), false);
});

test('checkMcpInput', () => {
  const k = policy.checkMcpInput;
  assert.equal(k('ps_list', { app: APP }, cfg).ok, true);
  assert.equal(k('ps_list', { app: 'other-app' }, cfg).ok, false);
  assert.equal(k('ps_list', {}, cfg).ok, false);
  assert.equal(k('ps_list', undefined, cfg).ok, false);
  assert.equal(k('ps_list', { app: ['x'] }, cfg).ok, false);
  assert.equal(k('list_apps', {}, cfg).ok, true);
  assert.equal(k('list_apps', { app: 'other-app' }, cfg).ok, false);
  assert.equal(k('pg_outliers', { app: APP, reset: true }, cfg).ok, false);
  assert.equal(k('pg_outliers', { app: APP, reset: false }, cfg).ok, true);
  assert.equal(typeof k('ps_list', {}, cfg).reason, 'string');
  assert.equal(k('get_addon_info', { app: APP, addon: 'DATABASE' }, cfg).ok, true);
  assert.equal(k('get_addon_info', { app: APP, addon: 'HEROKU_POSTGRESQL_RED' }, cfg).ok, true);
  assert.equal(k('get_addon_info', { app: APP }, cfg).ok, false);
  assert.equal(k('get_addon_info', { app: APP, addon: 'postgresql-curly-12345' }, cfg).ok, false);
  assert.equal(k('get_addon_info', { app: APP, addon: '1DB' }, cfg).ok, false);
});

test('classifyMcpTool: heroku-ops-gaps server', () => {
  const c = policy.classifyMcpTool;
  assert.deepEqual(c('mcp__heroku-ops-gaps__releases_list'), { level: 'N0', tool: 'releases_list', server: 'gaps' });
  assert.equal(c('mcp__heroku-ops-gaps__backup_capture').level, 'N1');
  assert.equal(c('mcp__heroku-ops-gaps__git_push').level, 'N3');
  assert.equal(c('mcp__heroku-ops__ps_list').server, 'official');
  assert.equal(c('mcp__heroku-ops-gapsx__releases_list').level, 'N3');
  assert.equal(c('Bash').server, null);
  assert.equal(policy.GAPS_PREFIX, 'mcp__heroku-ops-gaps__');
  assert.equal(policy.GAPS_N0.size, 8);
  assert.equal(policy.GAPS_N1.size, 1);
  assert.throws(() => policy.GAPS_N0.add('git_push'), TypeError);
});

test('checkMcpInput: heroku-ops-gaps server', () => {
  const k = policy.checkMcpInput;
  assert.equal(k('releases_list', { app: APP, limit: 5 }, cfg, 'gaps').ok, true);
  assert.equal(k('releases_list', { app: 'otra' }, cfg, 'gaps').ok, false);
  assert.equal(k('releases_list', {}, cfg, 'gaps').ok, false);
  assert.equal(k('git_log', { rev: 'HEAD', app: APP }, cfg, 'gaps').ok, false);
  assert.equal(k('git_log', { rev: 'HEAD', extra: 1 }, cfg, 'gaps').ok, false);
  assert.equal(k('git_log', { rev: 'HEAD' }, cfg, 'gaps').ok, true);
  assert.equal(k('health_check', {}, cfg, 'gaps').ok, true);
  assert.equal(k('backup_capture', { app: APP }, cfg, 'gaps').ok, true);
  assert.equal(k('backup_info', { app: APP, id: 'b001' }, cfg, 'gaps').ok, true);
});

test('isPathAllowed', () => {
  const ok = (p) => policy.isPathAllowed(p, [ROOT + '\\']);
  assert.equal(ok(ROOT + '\\procedures\\deploy.md'), true);
  assert.equal(ok('c:/users/dev/plugin-root/rogue-heroku-ops.json'), true);
  assert.equal(ok(ROOT), true);
  assert.equal(ok('C:\\Users\\dev\\.netrc'), false);
  assert.equal(ok(ROOT + '\\..\\.credentials.json'), false);
  assert.equal(ok('C:\\Users\\dev\\plugin-root-evil\\x'), false);
  assert.equal(ok(undefined), false);
  assert.equal(ok(''), false);
  assert.equal(policy.isPathAllowed(ROOT + '\\a', []), false);
  assert.equal(policy.isPathAllowed('E:\\x', [ROOT]), false);
});
