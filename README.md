# rogue-heroku-ops

A Claude Code plugin that gives you a Heroku operator agent behind a safety guard: deploy GO/NO-GO checks, incident triage and routine reviews of your apps. It never deploys, rolls back or restores.

**Version:** 0.1.0 | **Status:** In progress | **Live-tested:** not yet (see [Tested platforms](#tested-platforms))

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

Heroku CLI, `git` and `psql` are resolved from your `PATH`.

## Installation

```text
/plugin marketplace add therogueroadmap/marketplace
/plugin install rogue-heroku-ops@therogueroadmap
```

Then, in the project whose apps you want to operate, run:

```text
/rogue-heroku-ops:setup
```

The setup skill checks the tools on your `PATH`, checks your Heroku session (`heroku auth:whoami`), asks which apps to allow (health URL and deploy branch for each), writes `.claude/rogue-heroku-ops.json`, validates it and shows a recommended `permissions.deny` block (it does not apply it). Then ask Claude for a Heroku operation and it delegates to the agent, for example: "Use the heroku-ops agent to run the routine check on my-app."

### Dependencies

A `SessionStart` hook installs `@modelcontextprotocol/sdk` and `zod` into `${CLAUDE_PLUGIN_DATA}` with `npm ci`. It needs network access the first time and is skipped when the plugin root already resolves them (for example with `--plugin-dir` after running `npm ci` in a clone). If the install fails, the session still starts; the plugin's own server `heroku-ops-gaps` will not start and the agent continues with the official server, marking the affected items as PENDING.

### Configuration

The config file is exactly `${CLAUDE_PROJECT_DIR}/.claude/rogue-heroku-ops.json`; there is no search upwards. Example:

```json
{
  "apps": [
    { "name": "my-app", "healthUrl": "https://my-app.herokuapp.com/health", "deployBranch": "main" }
  ],
  "migrations": {
    "repoDir": "db/migration",
    "appliedQuery": "SELECT version, description, success FROM flyway_schema_history ORDER BY installed_rank",
    "filePattern": "^V(\\d+(?:[._]\\d+)*)__.+\\.sql$"
  },
  "n1Mode": "ask"
}
```

- `migrations` is optional; without it the agent reports migrations as "not configured".
- `n1Mode` is `ask` (default: state-changing actions ask for confirmation) or `deny` (they are denied and the command is shown to you).
- Unknown keys make the config invalid. Validate it with `/rogue-heroku-ops:setup`, or from a clone of this repository with `node bin/validate-config.js <projectDir>` (the path is relative to the clone).

The file holds no secrets. Committing `.claude/rogue-heroku-ops.json` is your choice: commit it to share the same apps, health URLs and deploy branches with your team, or add it to `.gitignore` to keep it local.

## Security model and limits

The plugin operates with the permissions of your `heroku login` session. The guard (a `PreToolUse` hook) is the barrier, not the token. Use a dedicated Heroku user for `heroku login` if you can.

What the guard enforces:

- Only the agent `rogue-heroku-ops:heroku-ops` can use the plugin tools. The main session cannot; it is told to delegate.
- Without a valid config, every plugin tool is denied and the message points to `/rogue-heroku-ops:setup`.
- Tool allowlist, and `app` must be one of the apps in the config.
- SQL must be a single read-only statement and is always rewritten to run in a `READ ONLY` transaction. `pg_psql` accepts no `file` or `credential` arguments.
- The agent reads only inside the project directory. `Grep` on a directory needs a simple glob such as `**/*.sql`. It never reads credential files (`.env*`, `*.pem`, `*.key` and similar).
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

Claude Code deletes the plugin's data directory (`${CLAUDE_PLUGIN_DATA}`) on uninstall. That directory holds the audit trail (`audit/`) and the installed dependencies, so the audit trail is lost with it. To keep the data, use the CLI instead: `claude plugin uninstall rogue-heroku-ops@therogueroadmap --keep-data`. If you want to keep the audit trail before a normal uninstall, copy `${CLAUDE_PLUGIN_DATA}/audit/` somewhere else first.

Then delete `.claude/rogue-heroku-ops.json` from your projects. Remove the `permissions.deny` entries from your user `settings.json` if you added them.

## Tested platforms

The test suite (`npm test`) runs in CI on Linux, macOS and Windows with Node 22.

Live-tested against real Heroku apps: not yet. No platform has been verified end to end with a real session, so treat the plugin as in progress.

## Development

```bash
npm ci
npm test
```

Running the tests needs Node 22 or later (`npm test` uses `node --test` glob patterns).

To try it from a clone: `claude --plugin-dir <path-to-clone>` after `npm ci`.

`HEROKU_OPS_TEST_HEROKU` and `HEROKU_OPS_TEST_GIT` (and the other `HEROKU_OPS_TEST_*` variables) are for tests only. They replace the Heroku CLI script and the `git` executable so tests can run without a real session. Never set them in a real environment: they change which programs the plugin runs.

## License

MIT. See [LICENSE](LICENSE).
