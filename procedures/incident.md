# Procedure: incident

Diagnosis order. One call per response. Note the time the problem started as given by the person; if they do not give it, ask.

There is no console: every step is a call to an MCP tool, either the official one (`heroku-ops`) or the plugin's own (`heroku-ops-gaps`).

**Setup.** Call `get_config` first (`apps[]` with `name`, `healthUrl`, `deployBranch`). Pick the target app: with a single app, use it; with several, use the one the request names, and if the request does not name one, ask which app. Below, `<app>` is the chosen `name` and `<branch>` its `deployBranch`. Always pass `app: <app>` where a tool takes the app. If `heroku-ops-gaps` does not respond, continue with the official server and mark the affected items PENDING.

1. Health. `health_check` with `app: <app>`.

   If it does not answer or times out, that is a diagnostic data point.

2. Dynos down or restarting. `ps_list` (app `<app>`).

3. Logs: Heroku error codes (H10, H12, H13, R14, R15) and application exceptions. `get_app_logs` (app `<app>`, source `heroku`, then source `app`). It returns only the recent lines of the buffer; look for the pattern in the output yourself and, if there is no evidence in the recent logs, report it as "no evidence in the recent logs". State the time window the buffer covers.

4. Postgres. `pg_info`, `pg_ps`, `pg_locks` and `pg_outliers` (app `<app>`). Call `pg_outliers` with `app` only, without `num` or `truncate`: with either of them it fails.

   For connections by state, `pg_psql` with `app: <app>` and `command: SELECT state, count(*) FROM pg_stat_activity GROUP BY state` (a single read statement).

5. Recent releases against the time the problem started. `releases_list` with `app: <app>`, `limit: 10`.

   If a release coincides with the start, take the detail from its description in that same output: `Deploy <sha>` for a deploy, or "Set ... config vars" / "Remove ... config vars" with the variable names (never ask for or show their values). For a deploy, look at the commits with `git_log` (`rev: origin/<branch>`, `format: oneline`, `n: 20`, or `range: <sha>..origin/<branch>`) and the changes with `git_show` (`rev: <sha>`, `format: stat`). If you need to bring in new commits, run `git_fetch` first.

## Deliverable

Diagnosis with the evidence of each item (which tool, which data point), probable cause and proposed actions ordered by risk. `ps_restart` or maintenance mode (`maintenance_on` / `maintenance_off`) only if the person asked for them: issue the call and let the permission prompt decide; do not ask for confirmation in text. If the person denies it (or `n1Mode` is `deny`), hand over the exact operation and mark the item PENDING. Rollback, deploy and restore: proposal only, with the exact command for the person to run (for example `heroku rollback vNNN -a <app>` or `heroku pg:backups:restore <backup> DATABASE_URL -a <app>`); you never execute them.
