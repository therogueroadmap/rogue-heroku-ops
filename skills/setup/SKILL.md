---
name: setup
description: Use when the user wants to install, configure or reconfigure the rogue-heroku-ops plugin in a project, when a rogue-heroku-ops tool was denied because the config is missing or invalid, or when they run /rogue-heroku-ops:setup.
---

# rogue-heroku-ops setup

## Overview

Guided, read-only setup of the plugin for the current project. It checks the tools on the PATH, checks the Heroku session, writes `.claude/rogue-heroku-ops.json` in the project root, validates it, and shows (never applies) a recommended `permissions.deny` block.

Core rule: **never read or print secrets.** Never run `heroku auth:token`, `heroku config*` or anything that exposes tokens or config vars. For apps, extract names only.

Run in the main session. Use Bash (or PowerShell on Windows) only for the read-only commands listed below. `projectDir` is the current project directory (the one that holds `.claude/`).

## Steps

### 1. Check the tools

Run each one separately and report present / missing with its version:

| Tool | Command | Install link if missing |
|---|---|---|
| Node (>= 20) | `node --version` | https://nodejs.org |
| Heroku CLI | `heroku --version` | https://devcenter.heroku.com/articles/heroku-cli |
| git | `git --version` | https://git-scm.com/downloads |
| psql | `psql --version` | https://www.postgresql.org/download/ |

On Windows, if `psql --version` fails, run `node -e "console.log(require(process.argv[1]).findPsqlDir() || 'none')" "${CLAUDE_PLUGIN_ROOT}/bin/launch-official.js"` (works the same in PowerShell and Git Bash). It prints the `bin` folder of the highest PostgreSQL version installed under `%ProgramFiles%\PostgreSQL`, the one the plugin uses, or `none`. If it prints a folder, report "found at <folder>, not on PATH; the plugin uses it automatically" instead of "missing".

Node older than 20 counts as missing. A missing tool does not abort the run, except the Heroku CLI and Node: without the Heroku CLI, stop after reporting (steps 2 to 4 need it); without Node (or with Node older than 20), stop after reporting too (the config validator in step 4, the hooks and the plugin servers need it). Say what each missing tool disables: `git` (release and deploy-branch checks), `psql` (database queries and migrations).

### 2. Check the Heroku session

Run `heroku auth:whoami`. Only the account email or name it prints may be shown.

If it fails or prints nothing: tell the person to run `heroku login` themselves (it opens a browser), then to re-run `/rogue-heroku-ops:setup`. **Stop. Do not write any config.**

### 3. Choose the apps

1. Run this pipeline, which prints only the name of each app (one per line) and never the raw JSON: `heroku apps --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const a of JSON.parse(s))console.log(a.name)})"`. Use only that output (the names). Do not echo or keep the rest of the JSON.
2. Ask which apps to allow (at least one). For each chosen app ask:
   - `healthUrl`: http or https URL of its health endpoint. **Never build the domain by hand**: Heroku apps created since 2023 use a suffixed domain (`<app>-<hash>.herokuapp.com`), and the short `<app>.herokuapp.com` returns 404. Get the base URL from the CLI instead (see "Base URL of an app" below), ask the person only for the path of the health endpoint (for example `/health`, or `/actuator/health` on Spring Boot), and join both.
   - `deployBranch`: git branch deployed to it (for example `main` for production, `develop` for staging).
3. Ask whether to configure migrations. If yes, offer the Flyway preset below and let the person adjust any field. If no, omit `migrations` (the agent reports migrations as "not configured").
4. Ask `n1Mode`: `ask` (default; state-changing actions ask for confirmation) or `deny` (they are denied and the exact command is shown to the person).

Base URL of an app (read-only; run it once per chosen app):

1. Run `heroku apps:info --app <name> --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).app.web_url))"`. It prints only `app.web_url` (the real default domain, with a trailing slash). Do not echo the rest of the JSON.
2. If the app may have a custom domain, run `heroku domains --app <name> --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const d of JSON.parse(s))console.log(d.hostname,d.kind)})"` and offer the `custom` hostnames as an alternative base (`https://<hostname>`). The default is `web_url`.
3. Remove any trailing slash from the base and append the path, which starts with `/` (for example `https://my-app-1a2b3c4d5e6f.herokuapp.com` + `/actuator/health`).
4. Before writing it, check the URL with a GET that expects a 2xx: `node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status),e=>console.log('error',e.name))" "<healthUrl>"`. If it prints a status other than 2xx (404, 401, 503) or `error`, show it and ask the person to correct the path or base. Skip the check only if the person declines it.

Flyway preset (the `migrations` block):

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
- `repoDir`: safe relative path inside the project (no absolute path, no `..`).
- `appliedQuery`: read-only SQL only.
- `filePattern`: a valid regex.
- Allowed keys only: root `apps`, `migrations`, `n1Mode`; app `name`, `healthUrl`, `deployBranch`; migrations `repoDir`, `appliedQuery`, `filePattern`. Any other key (for example `sqlRewrite`) makes the config invalid.

### 4. Write and validate the config

1. Target file: `<projectDir>/.claude/rogue-heroku-ops.json` (exactly there; no search upwards). If it exists, show it and ask before overwriting.
2. Write it with the Write tool, not with Bash, a heredoc or `echo` (the shell can drop backslashes: `\\d` becomes `\d` and the JSON breaks). Use pretty-printed JSON. In JSON the backslashes of `filePattern` must be doubled (`\\d`, `\\.`), as in the example:

```json
{
  "apps": [
    { "name": "my-app", "healthUrl": "https://my-app-1a2b3c4d5e6f.herokuapp.com/health", "deployBranch": "main" }
  ],
  "migrations": {
    "repoDir": "db/migration",
    "appliedQuery": "SELECT version, description, success FROM flyway_schema_history ORDER BY installed_rank",
    "filePattern": "^V(\\d+(?:[._]\\d+)*)__.+\\.sql$"
  },
  "n1Mode": "ask"
}
```

3. Validate: `node "${CLAUDE_PLUGIN_ROOT}/bin/validate-config.js" "<projectDir>"`.
   - `OK <file>` (exit 0): continue.
   - `INVALID <file>` plus one problem per line (exit 1): show the problems, fix the file with the person, and validate again. Do not continue while it is invalid.
4. Tell the person the file holds no secrets and that committing it or not is their choice.

### 5. Recommend a second barrier (show, do not apply)

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

### 6. How to use the agent

Tell the person:
- Ask for any Heroku operation on the configured apps and delegate it to the agent `rogue-heroku-ops:heroku-ops`, for example: "Use the heroku-ops agent to run the routine check on my-app."
- The agent reads the config and procedures itself (deploy go/no-go, incident, routine). It never deploys, rolls back or restores.
- With several apps, name the app in the request; otherwise the agent asks.
- If a plugin tool is denied for a missing or invalid config, re-run `/rogue-heroku-ops:setup`.
- A restart may be needed so the session picks up the new config.

## Common mistakes

- Running `heroku auth:token`, `heroku config` or `heroku apps` without `--json` and echoing all of it. Only names and the account identity may be shown.
- Writing a `healthUrl` with the short `<app>.herokuapp.com` domain instead of the `web_url` from `heroku apps:info`: it returns 404.
- Writing the config when there is no session or validation failed.
- Adding `sqlRewrite` or any unknown key: the config becomes invalid.
- Applying the `permissions.deny` block instead of showing it.
- Writing the file outside `<projectDir>/.claude/`.
