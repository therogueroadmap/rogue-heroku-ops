# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-24

### Changed

- BREAKING: migrations moved into each app. A `migrations` block at the root of the config is now invalid; run `/rogue-heroku-ops:setup` to migrate a 0.1.x config.
- BREAKING: git tools require app. `git_fetch`, `git_branches`, `git_log`, `git_show`, `git_ls_tree` and `git_diff` take `app` and work on that app's repository.
- When several apps are configured and the request names none, the agent and the procedures only read the config and return the list of apps and how to ask again.

### Added

- `repoPath` per app: the absolute path of the app's repository, so a session opened from a hub folder can operate apps whose code lives elsewhere. The guard allows reading the project and the configured `repoPath` directories.
- `git_branches`: lists the remote branches of an app's repository as of the last `git_fetch`.
- Any remote branch: git revs accept `origin/<any valid branch>`, not only the deploy branch.
- Requested deploy branch: a deploy GO/NO-GO can name a branch in the request and uses it for that request only.
- Setup branch quick mode: change the deploy branch of an app without going through the full setup.
- Auto-mode allow block: the setup shows a `permissions.allow` block for the read-only tools and the agent.
- `get_config` returns `repoDir` and `repoSource` for each app.

## [0.1.1] - 2026-11-24

### Fixed

- `git_show` with `path`, `git_diff` and `git_log` reject credential paths (for example `config/prod.env`, `certs/server.key`), with the same rule the guard applies to Read and Grep.
- `pipelines_list` and `pipelines_info` are no longer in the agent's tools: the guard always denied them because they take no app.
- The plugin icon has its own badge (an h inside a hexagon) instead of a copy of the rogue-toolkit icon.

## [0.1.0] - 2026-11-24

### Added

- Agent `rogue-heroku-ops:heroku-ops` for deploy GO/NO-GO, incident triage and routine checks on the Heroku apps listed in the project config. It never deploys, rolls back or restores.
- Official Heroku MCP server (`heroku-ops`, pinned `@heroku/mcp-server` 1.2.15) and the plugin's own server `heroku-ops-gaps` (config, procedures, releases, backups, health, read-only git).
- `PreToolUse` guard that fails closed: agent-only access to plugin tools, app allowlist, read-only SQL rewritten into a `READ ONLY` transaction, project-scoped reads, `n1Mode` for state-changing operations.
- `PostToolUse` and `PostToolUseFailure` audit trail in `${CLAUDE_PLUGIN_DATA}/audit/`.
- Skill `/rogue-heroku-ops:setup` for guided, read-only setup and config validation.
- `SessionStart` hook that installs dependencies into `${CLAUDE_PLUGIN_DATA}`.
- Procedures `deploy`, `incident` and `routine`.
- On Windows, when `psql` is not on `PATH`, the official server uses the highest version under `%ProgramFiles%\PostgreSQL\<version>\bin`.
- The guard denies `pg_outliers` with `num` or `truncate` (both make the Heroku CLI fail) and points to the working call.
- README and CI that runs the test suite on Linux, macOS and Windows.

### Notes

- Status: in progress. Live-tested on Windows 11 against a real Heroku app; macOS and Linux not yet live-tested.
