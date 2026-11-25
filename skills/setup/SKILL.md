---
name: setup
description: Use when the user wants to install, configure or reconfigure the rogue-heroku-ops plugin in a project, when a rogue-heroku-ops tool was denied because the config is missing or invalid, or when they run /rogue-heroku-ops:setup.
---

# rogue-heroku-ops setup

## Overview

Guided, read-only setup of the plugin for the current project. It checks the tools on the PATH, checks the Heroku session, writes `.claude/rogue-heroku-ops.json` in the project root, validates it, and shows (never applies) a recommended `permissions.deny` block and the `permissions.allow` block that auto mode needs.

Core rule: **never read or print secrets.** Never run `heroku auth:token`, `heroku config*` or anything that exposes tokens or config vars. For apps, extract names only.

Run in the main session. Use Bash (or PowerShell on Windows) only for the read-only commands listed below. `projectDir` is the current project directory (the one that holds `.claude/`).

## Steps

### Quick mode: change the deploy branch

Use this mode only when the request is just to change the deploy branch of an app (for example "change the deploy branch of `<app>` to `release/2026-12`") or the argument is `branch`. Otherwise skip to step 1.

1. Read `<projectDir>/.claude/rogue-heroku-ops.json`. It must exist and be valid (`node "${CLAUDE_PLUGIN_ROOT}/bin/validate-config.js" "<projectDir>"` prints `OK`). If it is missing or invalid, drop quick mode and run the full setup from step 1.
2. Pick the app (ask if there are several and the request does not name one) and the new branch.
3. Check that the branch exists on the remote, read-only.
   - First validate `<branch>` against the `deployBranch` grammar: segments separated by `/`, each segment `[A-Za-z0-9_][A-Za-z0-9_-]*` with internal dots allowed; no spaces, `;`, `$`, quotes or `..`. If it does not match, stop without running git and tell the person.
   - The repo of the app is its `repoPath`. If the app has none, use `<projectDir>` only if `<projectDir>/.git` exists; otherwise stop and say the app has no repository (suggest the full setup to add `repoPath`).
   - Run `git -C "<repo>" ls-remote --heads origin "refs/heads/<branch>"` (always quoted).
   - If the exit code is not 0, report "could not verify the branch" with the error and stop; write nothing.
   - The branch exists only if some output line ends exactly with `<TAB>refs/heads/<branch>`. Otherwise stop and tell the person; change nothing.
4. Show the change as before -> after (`deployBranch`: `<old>` -> `<new>`) and ask for confirmation before writing.
5. Write only `deployBranch` of that app (Write tool, the rest of the file untouched), then validate again with `node "${CLAUDE_PLUGIN_ROOT}/bin/validate-config.js" "<projectDir>"`. Stop there: no other step runs in quick mode.

### 1. Check the tools

Run each one separately and report present / missing with its version:

| Tool | Command | Install link if missing |
|---|---|---|
| Node (>= 20) | `node --version` | https://nodejs.org |
| Heroku CLI | `heroku --version` | https://devcenter.heroku.com/articles/heroku-cli |
| git | `git --version` | https://git-scm.com/downloads |
| psql | `psql --version` | https://www.postgresql.org/download/ |

On Windows, if `psql --version` fails, run `node -e "console.log(require(process.argv[1]).findPsqlDir() || 'none')" "${CLAUDE_PLUGIN_ROOT}/bin/launch-official.js"` (works the same in PowerShell and Git Bash). It prints the `bin` folder of the highest PostgreSQL version installed under `%ProgramFiles%\PostgreSQL`, the one the plugin uses, or `none`. If it prints a folder, report "found at <folder>, not on PATH; the plugin uses it automatically" instead of "missing".

Node older than 20 counts as missing. A missing tool does not abort the run, except the Heroku CLI and Node: without the Heroku CLI, stop after reporting (steps 2 and 3 need it); without Node (or with Node older than 20), stop after reporting too (the config validator in step 5, the hooks and the plugin servers need it). Say what each missing tool disables: `git` (release and deploy-branch checks), `psql` (database queries and migrations).

### 2. Check the Heroku session

Run `heroku auth:whoami`. Only the account email or name it prints may be shown.

If it fails or prints nothing: tell the person to run `heroku login` themselves (it opens a browser), then to re-run `/rogue-heroku-ops:setup`. **Stop. Do not write any config.**

### 3. Choose the apps

0. Look at `<projectDir>/.claude/rogue-heroku-ops.json`. If it exists and has a root-level `migrations` key, it is a 0.1.x config: 0.2.0 moved `migrations` into each app, so the validator rejects it. Offer to migrate it: with one app, move the block into that app directly; with several apps, ask which apps it applies to and copy it into each of those. Keep the other values (apps, `n1Mode`) as they are, show the resulting file and ask for confirmation before overwriting (step 5 does the writing and validating). Then continue from step 4 (repository of each app); items 1 to 4 below are needed only to add or change apps.
1. Run this pipeline, which prints only the name of each app (one per line) and never the raw JSON: `heroku apps --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const a of JSON.parse(s))console.log(a.name)})"`. Use only that output (the names). Do not echo or keep the rest of the JSON.
2. Ask which apps to allow (at least one). For each chosen app ask:
   - `healthUrl`: http or https URL of its health endpoint. **Never build the domain by hand**: Heroku apps created since 2023 use a suffixed domain (`<app>-<hash>.herokuapp.com`), and the short `<app>.herokuapp.com` returns 404. Get the base URL from the CLI instead (see "Base URL of an app" below), ask the person only for the path of the health endpoint (for example `/health`, or `/actuator/health` on Spring Boot), and join both.
   - `deployBranch`: git branch deployed to it (for example `main` for production, `develop` for staging).
3. For each chosen app, ask whether to configure migrations. If yes, offer the Flyway preset below and let the person adjust any field; the block goes **inside that app**, and `repoDir` is relative to the repository of that app. If no, omit `migrations` from that app (the agent reports migrations as "not configured").
4. Ask `n1Mode`: `ask` (default; state-changing actions ask for confirmation) or `deny` (they are denied and the exact command is shown to the person).

Base URL of an app (read-only; run it once per chosen app):

1. Run `heroku apps:info --app <name> --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).app.web_url))"`. It prints only `app.web_url` (the real default domain, with a trailing slash). Do not echo the rest of the JSON.
2. If the app may have a custom domain, run `heroku domains --app <name> --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const d of JSON.parse(s))console.log(d.hostname,d.kind)})"` and offer the `custom` hostnames as an alternative base (`https://<hostname>`). The default is `web_url`.
3. Remove any trailing slash from the base and append the path, which starts with `/` (for example `https://my-app-1a2b3c4d5e6f.herokuapp.com` + `/actuator/health`).
4. Before writing it, check the URL with a GET that expects a 2xx: `node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status),e=>console.log('error',e.name))" "<healthUrl>"`. If it prints a status other than 2xx (404, 401, 503) or `error`, show it and ask the person to correct the path or base. Skip the check only if the person declines it.

Flyway preset (the `migrations` block of an app):

```json
{
  "repoDir": "db/migration",
  "appliedQuery": "SELECT version, description, success FROM flyway_schema_history ORDER BY installed_rank",
  "filePattern": "^V(\\d+(?:[._]\\d+)*)__.+\\.sql$"
}
```

Rules for the values (the validator enforces them):
- `name`: `^[a-z][a-z0-9-]{1,29}$`.
- `healthUrl`: http or https, taken from `web_url` or a custom domain, never guessed.
- `repoPath` (optional, per app): absolute path, the root of a git repository (it holds `.git`), not a drive root (`C:\`, `/`) and not a UNC path (`\\server\share`). It is checked on disk every time the config loads.
- `repoDir`: safe relative path inside the repository of the app (no absolute path, no `..`).
- `appliedQuery`: read-only SQL only.
- `filePattern`: a valid regex.
- Allowed keys only: root `apps`, `n1Mode`; app `name`, `healthUrl`, `deployBranch`, `repoPath`, `migrations`; migrations `repoDir`, `appliedQuery`, `filePattern`. Any other key (for example `sqlRewrite`, or `migrations` at the root) makes the config invalid.

### 4. The repository of each app

The git tools and the migration checks of the deploy go/no-go work on the repository of the app.

- If `<projectDir>/.git` does not exist (the project is a hub, not a repo): ask for each app the absolute `repoPath` of its repository, then check it read-only with `git -C "<path>" rev-parse --show-toplevel`. The printed top-level must be the same path as the one given (it must be the repo root, not a subfolder); compare ignoring `/` vs `\` and a trailing separator, and on Windows ignoring case. If it is not, show both and ask again. Several apps may share the same `repoPath`.
- If `<projectDir>/.git` exists: offer to leave `repoPath` out (the app uses the project repository). Add it only if the person wants a different repository.
- **Warning to give:** an app with no `repoPath` in a project that is not a git repo is valid (routine and incident work), but its deploy go/no-go will report git and migrations as PENDING.
- An app that has `repoPath` also lets the agent read files of that repository by absolute path (credential files stay blocked).

### 5. Write and validate the config

1. Target file: `<projectDir>/.claude/rogue-heroku-ops.json` (exactly there; no search upwards). If it exists, show it and ask before overwriting.
2. Write it with the Write tool, not with Bash, a heredoc or `echo` (the shell can drop backslashes: `\\d` becomes `\d` and the JSON breaks). Use pretty-printed JSON. In JSON the backslashes of `filePattern` must be doubled (`\\d`, `\\.`), as in the example (the backslashes of a Windows `repoPath` are doubled too). `repoPath` and `migrations` are optional per app:

```json
{
  "apps": [
    {
      "name": "my-app",
      "healthUrl": "https://my-app-1a2b3c4d5e6f.herokuapp.com/health",
      "deployBranch": "main",
      "repoPath": "D:\\work\\my-app",
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

3. Validate: `node "${CLAUDE_PLUGIN_ROOT}/bin/validate-config.js" "<projectDir>"`.
   - `OK <file>` (exit 0): continue.
   - `INVALID <file>` plus one problem per line (exit 1): show the problems, fix the file with the person, and validate again. Do not continue while it is invalid.
4. Tell the person the file holds no secrets and that committing it or not is their choice.

### 6. Recommend a second barrier (show, do not apply)

Show this block for the person to add to their **user** `settings.json` under `permissions.deny`. Do not edit any settings file. Rules in user settings also apply inside subagents and in every project.

```json
{
  "permissions": {
    "deny": [
      "Bash(heroku config*)",
      "Bash(heroku auth:token*)",
      "Bash(heroku rollback*)",
      "Bash(heroku pg:backups:restore*)",
      "Bash(heroku run*)",
      "Bash(heroku pg:backups:url*)",
      "Bash(heroku apps:destroy*)",
      "Bash(heroku addons:destroy*)",
      "PowerShell(heroku config*)",
      "PowerShell(heroku auth:token*)",
      "PowerShell(heroku rollback*)",
      "PowerShell(heroku pg:backups:restore*)",
      "PowerShell(heroku run*)",
      "PowerShell(heroku pg:backups:url*)",
      "PowerShell(heroku apps:destroy*)",
      "PowerShell(heroku addons:destroy*)"
    ]
  }
}
```

Explain that these block the dangerous CLI commands even if the plugin guard is bypassed. Recommend also using a dedicated Heroku user for `heroku login`.

### 7. Allow the agent in auto mode (show, do not apply)

Without an explicit allow, a session in auto mode (`defaultMode: auto`) blocks the delegation to the agent. Show this block for the person to add under `permissions.allow` in the **project** file `<projectDir>/.claude/settings.local.json` (recommended there, not in the user `settings.json`, so the allow is not active in other projects or other clients' sessions). Do not edit any settings file.

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

The state-changing actions (`ps_restart`, `maintenance_on`, `maintenance_off`, `backup_capture`) are left out on purpose: they must keep asking for confirmation. The plugin guard still applies to everything the agent does.

### 8. How to use the agent

Tell the person:
- Ask for any Heroku operation on the configured apps and delegate it to the agent `rogue-heroku-ops:heroku-ops`, for example: "Use the heroku-ops agent to run the routine check on my-app."
- The agent reads the config and procedures itself (deploy go/no-go, incident, routine). It never deploys, rolls back or restores.
- With several apps, name the app in the request. If the request does not name one, the agent only calls `get_config` and returns the question, a table of the apps and an example request, for example: "Use the heroku-ops agent for the go/no-go of `<app>`".
- To run the go/no-go against another branch than the configured `deployBranch`, say so in the request ("go/no-go of `<app>` from `<branch>`"). It applies to that request only; the config is not changed. To change the configured branch, run `/rogue-heroku-ops:setup branch`.
- If a plugin tool is denied for a missing or invalid config, re-run `/rogue-heroku-ops:setup`.
- A restart may be needed so the session picks up the new config.

## Common mistakes

- Running `heroku auth:token`, `heroku config` or `heroku apps` without `--json` and echoing all of it. Only names and the account identity may be shown.
- Writing a `healthUrl` with the short `<app>.herokuapp.com` domain instead of the `web_url` from `heroku apps:info`: it returns 404.
- Writing the config when there is no session or validation failed.
- Adding `sqlRewrite` or any unknown key: the config becomes invalid.
- Leaving `migrations` at the root (0.1.x layout): it must be inside each app.
- Writing a relative `repoPath` (or a subfolder, a drive root or a UNC path): it must be the absolute root of a git repo.
- Applying the `permissions.deny` or `permissions.allow` block instead of showing it.
- Writing the file outside `<projectDir>/.claude/`.
