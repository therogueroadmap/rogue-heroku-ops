# rogue-heroku-ops

A Claude Code plugin that gives you a Heroku operator agent behind a safety guard: deploy GO/NO-GO checks, incident triage and routine reviews of your apps. It never deploys, rolls back or restores.

**Version:** 0.2.0 | **Status:** In progress | **Live-tested:** Windows (see [Tested platforms](#tested-platforms))

## What it does

The agent `rogue-heroku-ops:heroku-ops` works on the Heroku apps you list in a per-project config file. It covers three procedures:

- **Deploy**: a GO/NO-GO report before a deploy (release, backup, pending migrations, branch checks, health) and a verification after it.
- **Incident**: diagnosis with evidence (health, dynos, logs, Postgres) and proposed actions ordered by risk.
- **Routine**: a review of the state of an app (dynos, releases, backups, database, health).

Operations that change something (manual backup, dyno restart, maintenance mode on/off) go through a Claude Code permission prompt, so you approve each one. Everything else is read-only; SQL runs inside `BEGIN TRANSACTION READ ONLY; ...; ROLLBACK;`.

## What it does not do

- It never deploys, rolls back or restores a backup. When one is needed, it prepares the exact command and hands it to you.
- It does not change config vars, scale, or create or delete resources.
- It does not show tokens, config vars or `DATABASE_URL`.
- It does not restrict other Heroku MCP servers you may have configured (see [Security model and limits](#security-model-and-limits)).
- It does not run on a schedule.

## Requirements

- Claude Code v2.1.295 or later (the guard hook uses `onFailure: "block"`, added in that version).
- Node.js 20 or later.
- [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli), logged in (`heroku login`).
- `git`.
- `psql` (only needed for database queries and migration checks).

Heroku CLI, `git` and `psql` are resolved from your `PATH`. On Windows, if `psql` is not on the `PATH`, the plugin uses the standard installation at `%ProgramFiles%\PostgreSQL\<version>\bin` (the highest version). On other systems `psql` must be on the `PATH`.

## Installation

```text
/plugin marketplace add therogueroadmap/marketplace
/plugin install rogue-heroku-ops@therogueroadmap
```

Then, in the project whose apps you want to operate, run:

```text
/rogue-heroku-ops:setup
```

The setup skill checks the tools on your `PATH`, checks your Heroku session (`heroku auth:whoami`), asks which apps to allow (deploy branch and health path for each; the base URL comes from the app's `web_url` and the health URL is checked before it is written), writes `.claude/rogue-heroku-ops.json`, validates it and shows a recommended `permissions.deny` block (it does not apply it). Then ask Claude for a Heroku operation and it delegates to the agent, for example: "Use the heroku-ops agent to run the routine check on my-app."

### Dependencies

A `SessionStart` hook installs `@modelcontextprotocol/sdk` and `zod` into `${CLAUDE_PLUGIN_DATA}` with `npm ci`. It needs network access the first time and is skipped when the plugin root already resolves them (for example with `--plugin-dir` after running `npm ci` in a clone). If the install fails, the session still starts; the plugin's own server `heroku-ops-gaps` will not start and the agent continues with the official server, marking the affected items as PENDING.

### Configuration

The config file is exactly `${CLAUDE_PROJECT_DIR}/.claude/rogue-heroku-ops.json`; there is no search upwards. Use the real `web_url` of the app (`heroku apps:info --app <name> --json`, field `app.web_url`) or a custom domain for `healthUrl`: apps created since 2023 have a suffixed domain, and `<app>.herokuapp.com` returns 404. Example:

```json
{
  "apps": [
    {
      "name": "my-app",
      "healthUrl": "https://my-app-1a2b3c4d5e6f.herokuapp.com/health",
      "deployBranch": "main",
      "repoPath": "/home/me/code/my-app",
      "migrations": {
        "repoDir": "db/migration",
        "appliedQuery": "SELECT version, description, success FROM flyway_schema_history ORDER BY installed_rank",
        "filePattern": "^V(\\d+(?:[._]\\d+)*)__.+\\.sql$"
      }
    }
  ],
  "n1Mode": "ask"
}
```

- `repoPath` is optional: the absolute path of the root of the app's git repository (it must contain `.git`). Without it, the app uses the project directory if that is the root of a repository; otherwise it has no repository and the git tools return an error for it. Several apps can share a `repoPath`.
- `migrations` is optional and belongs to each app (`repoDir` is relative to that app's repository); without it the agent reports migrations as "not configured".
- `n1Mode` is `ask` (default: state-changing actions ask for confirmation) or `deny` (they are denied and the command is shown to you).
- Unknown keys make the config invalid. Validate it with `/rogue-heroku-ops:setup`, or from a clone of this repository with `node bin/validate-config.js <projectDir>` (the path is relative to the clone).

Breaking change in 0.2.0: `migrations` moved from the root of the config into each app, and a root-level `migrations` makes the config invalid. Run `/rogue-heroku-ops:setup` to migrate a 0.1.x config. The git tools (`git_fetch`, `git_branches`, `git_log`, `git_show`, `git_ls_tree`, `git_diff`) now require `app`; the agent and the procedures already pass it.

The file holds no secrets. Committing `.claude/rogue-heroku-ops.json` is your choice: commit it to share the same apps, health URLs and deploy branches with your team, or add it to `.gitignore` to keep it local.

## Sessions from a hub folder

You can open Claude Code in a folder that is not a repository (a hub that holds the config) and operate apps whose code lives elsewhere. Set `repoPath` on each app to the absolute path of its repository. Then:

- The agent can read the hub project and the configured `repoPath` directories (use absolute paths for the repository). Credential files and `.git` internals (such as `.git/config`) stay denied everywhere.
- The git tools work on the repository of the app you pass in `app`. `git_fetch` refreshes `origin`, and `git_branches` lists the remote branches (`origin/...`) as of the last fetch. You can read any remote branch, not only the deploy branch.
- To check a different branch in a deploy GO/NO-GO, name it in the request, for example "GO/NO-GO of `my-app` from `release/2026-12`". The agent uses it for that request only and does not change the config. To change the configured branch, run `/rogue-heroku-ops:setup` and ask to change the deploy branch of the app.
- With several apps, name the app in the request. If you do not, the agent only reads the config and answers with the list of apps (name, repository, deploy branch) and how to ask again.
- An app with no repository (no `repoPath` and a project that is not a repository) works for routine and incident checks, but the deploy GO/NO-GO marks the git and migration items PENDING.

## Auto mode

In auto mode delegating to the agent needs `Agent(rogue-heroku-ops:heroku-ops)` in `permissions.allow`; the other entries keep the classifier from blocking the read-only calls the agent makes. `/rogue-heroku-ops:setup` shows this `permissions.allow` block (it does not apply it). Put it in the project's `.claude/settings.local.json`, not in your user settings, so it is not active in other sessions. The state-changing tools (`ps_restart`, `maintenance_on`, `maintenance_off`, `backup_capture`) are left out on purpose: they keep asking for confirmation.

```json
{
  "permissions": {
    "allow": [
      "Agent(rogue-heroku-ops:heroku-ops)",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__list_apps",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__ps_list",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__list_addons",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__get_addon_info",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__get_app_logs",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__pg_info",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__pg_ps",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__pg_locks",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__pg_outliers",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__pg_backups",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__pipelines_list",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__pipelines_info",
      "mcp__plugin_rogue-heroku-ops_heroku-ops__pg_psql",
      "mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__get_config",
      "mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__get_procedure",
      "mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__releases_list",
      "mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__backup_info",
      "mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__health_check",
      "mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__git_fetch",
      "mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__git_branches",
      "mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__git_log",
      "mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__git_show",
      "mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__git_ls_tree",
      "mcp__plugin_rogue-heroku-ops_heroku-ops-gaps__git_diff"
    ]
  }
}
```

## Security model and limits

The plugin operates with the permissions of your `heroku login` session. The guard (a `PreToolUse` hook) is the barrier, not the token. Use a dedicated Heroku user for `heroku login` if you can.

What the guard enforces:

- Only the agent `rogue-heroku-ops:heroku-ops` can use the plugin tools. The main session cannot; it is told to delegate.
- Without a valid config, every plugin tool is denied and the message points to `/rogue-heroku-ops:setup`.
- Tool allowlist, and `app` must be one of the apps in the config.
- SQL must be a single read-only statement and is always rewritten to run in a `READ ONLY` transaction. `pg_psql` accepts no `file` or `credential` arguments.
- The agent reads only inside the project directory and the `repoPath` of the configured apps (absolute paths for the repository). `Grep` on a directory needs a simple glob such as `**/*.sql`. It never reads credential files (`.env*`, `*.pem`, `*.key` and similar) and never reads `.git` internals (`.git/config` can hold a token in the remote URL); use the git tools for history.
- The git tools (`git_show` with `path`, `git_diff` and `git_log` with `paths`) reject credential paths with the same rule. `git_show` without `path` (the full diff of a commit) and `git_diff` with a directory in `paths` can still show changes to those files.
- The hook fails closed: if it errors, crashes or cannot parse its input, the call is denied. It runs `node` directly, with no shell, and sets `onFailure: "block"`, so the call is also blocked if the hook cannot start, exits with an unexpected code or reaches its 30-second timeout, on every platform (including Windows without Git Bash).

Limits:

- The guard does not cover other MCP servers for Heroku that you have configured. The agent does not list them in its tools, but the plugin does not restrict them in your main session.
- As a second barrier, add the `permissions.deny` block that `/rogue-heroku-ops:setup` shows to your **user** `settings.json`. It blocks dangerous CLI commands (`heroku config*`, `heroku auth:token*`, `heroku rollback*`, `heroku pg:backups:restore*`, `heroku run*` and others) even if the guard is bypassed.
- The Heroku token is never written to disk, logs, tool output or the audit trail.

## Audit

Every decision of the guard and every result of a plugin tool call is appended to `${CLAUDE_PLUGIN_DATA}/audit/audit-YYYY-MM.jsonl` (one file per UTC month). Entries are summarized and redacted: SQL literals are replaced, tokens are hidden and denied shell commands are stored as a hash. The directory survives plugin updates, but **uninstalling the plugin deletes it** unless you keep the data (see [Uninstall](#uninstall)). Writing the audit never blocks the agent.

## Uninstall

```text
/plugin uninstall rogue-heroku-ops@therogueroadmap
```

Claude Code deletes the plugin's data directory (`${CLAUDE_PLUGIN_DATA}`) on uninstall. That directory holds the audit trail (`audit/`) and the installed dependencies, so the audit trail is lost with it. The CLI can keep it: `claude plugin uninstall rogue-heroku-ops@therogueroadmap --keep-data`. If you want to keep the audit trail before a normal uninstall, copy `${CLAUDE_PLUGIN_DATA}/audit/` somewhere else first.

Then delete `.claude/rogue-heroku-ops.json` from your projects. Remove the `permissions.deny` entries from your user `settings.json` if you added them.

## Tested platforms

The test suite (`npm test`) runs in CI on Linux, macOS and Windows with Node 22.

Live-tested against a real Heroku app on Windows 11 (Claude Code 2.1.331, `--plugin-dir`): routine check, deploy GO/NO-GO, a denied `backup_capture` confirmation, the main-session deny, the audit trail, `heroku-ops-gaps` down and a missing project config. macOS and Linux have not been tested live yet, so treat the plugin as in progress.

## Development

```bash
npm ci
npm test
```

Running the tests needs Node 22 or later (`npm test` uses `node --test` glob patterns).

To try it from a clone: `claude --plugin-dir <path-to-clone>` after `npm ci`. Run `npm ci` first also when a local marketplace points at the clone: the plugin is then loaded in place, and without `node_modules` in the clone `heroku-ops-gaps` starts before the `SessionStart` install finishes and fails in the first session (reconnect it from `/mcp` or start a new session). Installs from a remote marketplace are not affected: Claude Code installs the dependencies into its cached copy of the plugin.

`HEROKU_OPS_TEST_HEROKU` and `HEROKU_OPS_TEST_GIT` (and the other `HEROKU_OPS_TEST_*` variables) are for tests only. They replace the Heroku CLI script and the `git` executable so tests can run without a real session. Never set them in a real environment: they change which programs the plugin runs.

## License

MIT. See [LICENSE](LICENSE).
