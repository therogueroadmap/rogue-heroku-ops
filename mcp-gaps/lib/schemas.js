'use strict';
const { z } = require('zod');
const { REV_PATTERN, RANGE_PATTERN, PATH_PATTERN, REV_MESSAGE, RANGE_MESSAGE } = require('./validate');

const PATH_MESSAGE = 'The path parameter must be a relative path with segments separated by / that start with a letter, digit or _ and use only letters, digits, _, . and -.';
const PROCEDURE_NAMES = ['deploy', 'incident', 'routine'];

// config: the validated project config, or null when it is missing or invalid. The patterns are a
// first barrier; argv.js stays authoritative and the handlers re-check against the config on every call.
function toolDefinitions(config) {
  const appNames = config ? config.apps.map((a) => a.name) : null;
  const app = (appNames ? z.enum(appNames) : z.string().min(1)).describe('Configured Heroku app name.');
  const rev = z.string().max(100).regex(REV_PATTERN, REV_MESSAGE).describe('HEAD, origin/<deploy branch> or a hexadecimal SHA of 7 to 40 characters.');
  const paths = z.array(z.string().max(4096).regex(PATH_PATTERN, PATH_MESSAGE)).max(20).optional().describe('Relative paths inside the repository (at most 20).');

  return {
    get_config: {
      description: 'Returns the validated project configuration (apps, migrations, n1Mode) from .claude/rogue-heroku-ops.json.',
      inputSchema: {},
    },
    get_procedure: {
      description: 'Returns the text of an operating procedure of the plugin: deploy, incident or routine.',
      inputSchema: { name: z.enum(PROCEDURE_NAMES).describe('Procedure name: deploy, incident or routine.') },
    },
    releases_list: {
      description: 'Lists the latest Heroku releases of the app (version, description, status, date and author email).',
      inputSchema: { app, limit: z.number().int().min(1).max(50).optional().describe('Number of releases (1 to 50, default 10).') },
    },
    backup_info: {
      description: 'Shows the status of a Postgres backup of the app, or of the latest one if no id is given.',
      inputSchema: { app, id: z.string().regex(/^[abr]\d{3,6}$/).optional().describe('Backup id, for example b012.') },
    },
    backup_capture: {
      description: 'Captures a Postgres backup of the app. This is a write action: use it only with authorization.',
      inputSchema: { app },
    },
    health_check: {
      description: 'Queries the configured health check URL of the app and returns the HTTP status, latency and the start of the response.',
      inputSchema: { app },
    },
    git_fetch: {
      description: 'Runs git fetch origin in the project repository to update the remote references.',
      inputSchema: {},
    },
    git_log: {
      description: 'Shows the git history of the project repository. Provide exactly one of rev or range (REV..REV).',
      inputSchema: {
        rev: rev.optional(),
        range: z.string().max(200).regex(RANGE_PATTERN, RANGE_MESSAGE).optional().describe('Range REV..REV, with each REV as in the rev parameter.'),
        format: z.enum(['oneline', 'stat', 'name-only']).optional(),
        n: z.number().int().min(1).max(200).optional().describe('Number of commits (1 to 200, default 20).'),
        paths,
      },
    },
    git_show: {
      description: 'Shows a commit or, if path is given, the content of a file at that revision.',
      inputSchema: { rev, path: z.string().max(4096).regex(PATH_PATTERN, PATH_MESSAGE).optional().describe('Relative path of the file.'), format: z.enum(['stat', 'name-only']).optional() },
    },
    git_ls_tree: {
      description: 'Lists the repository file tree at a revision.',
      inputSchema: { rev, recursive: z.boolean().optional(), nameOnly: z.boolean().optional(), paths },
    },
    git_diff: {
      description: 'Shows the differences between two revisions of the project repository.',
      inputSchema: { from: rev, to: rev, format: z.enum(['stat', 'name-only']).optional(), paths },
    },
  };
}

module.exports = { toolDefinitions, PROCEDURE_NAMES };
