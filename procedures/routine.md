# Procedure: routine review

One call per response. Each item ends in green, amber or red with its evidence.

There is no console: every step is a call to an MCP tool, either the official one (`heroku-ops`) or the plugin's own (`heroku-ops-gaps`).

**Setup.** Call `get_config` first (`apps[]` with `name`, `healthUrl`, `deployBranch`, `repoDir`, `repoSource` and the optional `migrations`). Pick the target app: with a single app, use it; with several, use the one the request names. With several apps and no app named in the request: call only `get_config`, then stop and return (1) the question "Which app?", (2) a table with each app's `name`, repository (`repoDir` or "no repository") and `deployBranch`, and (3) how to ask again, for example "Use the heroku-ops agent for the GO/NO-GO of `<app>`". Do not pick an app yourself and do not run the procedure for every app. Below, `<app>` is the chosen `name` and `<branch>` its `deployBranch`. Always pass `app: <app>` where a tool takes the app, including every git tool. If `heroku-ops-gaps` does not respond, continue with the official server and mark the affected items PENDING.

1. Health. `health_check` with `app: <app>`.

   Anything other than `UP` (including no answer or timeout) = red.

2. Dynos. `ps_list` (app `<app>`).

   All `up` = green; any down or restarting = red.

3. Daily backup. `pg_backups` (app `<app>`).

   The latest scheduled backup must be completed and less than 26 h old. Older than 26 h or failed = red. For the detail of one backup, `backup_info` with `app: <app>` and `id`. If the database has no daily schedule, say so and judge only by the latest completed backup.

4. Database size against the plan limit. `pg_info` (app `<app>`).

   Take the size limit from the plan shown by `pg_info`; do not assume a fixed limit. More than 80 % of the limit = amber; more than 95 % = red; otherwise green. For the exact size: `pg_psql` with `app: <app>` and `command: SELECT pg_database_size(current_database())`. If `pg_info` shows no size limit for the plan, report the size and mark the item PENDING.

5. Connections. With `pg_info` or with `pg_psql` (`app: <app>`, `command: SELECT state, count(*) FROM pg_stat_activity GROUP BY state`).

   Compare with the plan's connection limit shown by `pg_info`; close to the limit = amber, exhausted = red.

6. Slow queries: `pg_outliers` with `app` only (`<app>`), without `num` or `truncate`: with `num` it fails ("Flag --num expects a value") and with `truncate` it fails because of encoding. It returns 10 rows; report the first three, which are those with the highest total time. Green if none is anomalous, amber if one dominates the database time.

   If `pg_outliers` fails, fall back to `pg_psql` with `app: <app>` and `command: SELECT query, calls, total_exec_time FROM pg_stat_statements WHERE userid = (SELECT oid FROM pg_roles WHERE rolname = current_user) ORDER BY total_exec_time DESC LIMIT 3`. The filter keeps only the app's own queries: without it, queries from other roles of the database appear with hidden text (`<insufficient privilege>`) and can give a false amber.

   If that also fails (for example because `pg_stat_statements` is not available), mark the item PENDING and move on to the next one.

7. Recent errors (Heroku H1x and R1x codes, within the window the log buffer covers). `get_app_logs` (app `<app>`, source `heroku`). It returns only the recent lines of the buffer; if there is no evidence in the recent logs, report it as "no evidence in the recent logs".

   Count the H1x/R1x in what the buffer covers and say which time window it covers. 0 = green; 1 to 10 = amber; more than 10 = red. If the buffer does not reach 24 h, say so.

8. Latest releases. `releases_list` with `app: <app>`, `limit: 5`.

   Report version, date and author; amber if there is a release from the last 24 h with associated errors. If the release is a deploy (`Deploy <sha>`), you can cross-check the commit with `git_fetch` (`{ app: <app> }`), `git_log` (`app: <app>`, `range: <sha>..origin/<branch>`), `git_show` (`app: <app>`, `rev: <sha>`, `format: stat`), `git_ls_tree` (`app: <app>`, `rev: origin/<branch>`) and `git_diff` (`app: <app>`, `from`, `to`, `format: stat`), all read-only. If the app has no repository (`repoSource: none`), skip the cross-check and say so.

## Deliverable

A one-line summary (worst color and cause) and a table with the 8 items: color, data point and evidence. Thresholds: database > 80 % of the plan limit amber, > 95 % red; daily backup older than 26 h red; H1x/R1x errors in the buffer window 1-10 amber, > 10 red; health other than `UP` red.
