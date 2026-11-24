# Procedure: deploy

Two phases: preparation (before the person deploys) and post-deploy verification (when the person says the deploy finished). One call per response. You never deploy and never roll back: the person deploys the way they normally do (Dashboard, `git push heroku`, CI).

There is no console: every step is a call to an MCP tool, either the official one (`heroku-ops`) or the plugin's own (`heroku-ops-gaps`).

**Setup.** Call `get_config` first. It returns `apps[]` (each with `name`, `healthUrl`, `deployBranch`), the optional `migrations` block and `n1Mode`. Pick the target app: with a single app, use it; with several, use the one the request names, and if the request does not name one, ask which app before doing anything else. Below, `<app>` is the chosen `name` and `<branch>` is its `deployBranch`. Always pass `app: <app>` where a tool takes the app.

**Decision rule:** a GO/NO-GO with any PENDING item is never GO. If `heroku-ops-gaps` does not respond, continue with the official server, mark as PENDING the items that depended on it, and do not give GO. Any item that reports `success = false` is NO-GO.

## Phase A: preparation (GO / NO-GO)

1. Sync the repo and compare `<branch>` with the latest release.
   - `git_fetch` (no parameters). If `git_fetch` fails, the `origin` refs may be stale: item 1 is PENDING (never "OK with reservations") and you report the `git_fetch` error.
   - `git_log` with `rev: origin/<branch>`, `format: oneline`, `n: 20`.
   - `releases_list` with `app: <app>`, `limit: 5`.

   Each release description shows the deployed commit (`Deploy <sha>`); if the last deploy does not appear, raise `limit` (for example `limit: 20`). List the commits of `origin/<branch>` not yet in production with `git_log` and `range: <sha>..origin/<branch>` (the `<sha>` from the description). With `git_show` (`rev: <sha>`, `format: stat`) or `git_diff` (`from`, `to`, `format: stat`) you can see what changes. If the deployed commit does not exist in the repo, report it. Never print config var values.

2. Dynos and recent errors. `ps_list` (app `<app>`) and `get_app_logs` (app `<app>`, source `heroku`, then source `app`). `get_app_logs` returns only the recent lines of the log buffer: state which time window it covers. No H1x/R1x codes and no repeated exceptions in what it covers = OK; the item is PENDING only if the tool fails or returns no lines.

   Dynos `up`, no H1x/R1x codes and no repeated exceptions in the recent logs.

3. Latest scheduled backup completed correctly. `pg_backups` (app `<app>`).

   For the detail of one backup: `backup_info` with `app: <app>` and `id: b001` (replace the id with the real one: a letter a, b or r followed by digits).

4. Pending database migrations. Use the `migrations` block of the config.
   - If the config has no `migrations` block, report "not configured". That is not PENDING and does not block GO.
   - Otherwise list the migration files in `origin/<branch>`: `git_ls_tree` with `rev: origin/<branch>`, `recursive: true`, `nameOnly: true`, `paths: [<migrations.repoDir>]`, and keep only the names that match `migrations.filePattern`.
   - Run `migrations.appliedQuery` with `pg_psql` (`app: <app>`, `command: <appliedQuery>`).

   Pending = a repo file whose version does not appear in the query result as applied successfully. Any row with `success = false` (if the query returns that column) is NO-GO. To see the content of a pending migration: `git_show` with `rev: origin/<branch>` and `path: <repoDir>/<file>` (paths are relative to the repo).

   If `git_fetch` failed in item 1, `origin/<branch>` may be stale and the pending list is not reliable: item 4 is PENDING and you report that the comparison uses un-refreshed refs. A row with `success = false` is still NO-GO even if the fetch failed, because that row comes from the database, not from the repo.

   Example of a `migrations` block (Flyway preset):

   ```json
   {
     "repoDir": "db/migration",
     "appliedQuery": "SELECT version, description, success FROM flyway_schema_history ORDER BY installed_rank",
     "filePattern": "^V(\\d+(?:[._]\\d+)*)__.+\\.sql$"
   }
   ```

5. Backup before the deploy (N1). Issue the `backup_capture` call yourself with `app: <app>`; do not ask for confirmation in text and do not stop before it. The harness permission prompt is the person's confirmation. If `backup_capture` times out, do not repeat it: check with `pg_backups` whether a recent manual backup is in progress or completed.

   If the person denies the prompt or the guard blocks it (for example when `n1Mode` is `deny`), hand over the exact operation and mark the item PENDING.

### Deliverable

**GO / NO-GO** with one line per item (1 to 5): OK / FAIL / PENDING (item 4 may also be "not configured") and the evidence (commit, release, dyno state, backup time and state, pending migrations). Remember: a GO/NO-GO with any PENDING item is never GO. If it is GO, add the steps for the person to deploy the way they normally do (Dashboard, `git push heroku`, CI) from `<branch>`, and remind them to tell you when it finishes.

## Phase B: post-deploy verification

No `Monitor`: the person triggers it when the deploy has finished. Check once; if the release has not changed yet, report it and do not loop.

1. New release. `releases_list` with `app: <app>`, `limit: 1`.

   It must be a `vNNN` greater than the one from phase A. If it did not change, report it and stop.

2. Migrations. Do not search the logs for migration-tool messages. If the config has no `migrations` block, report "not configured". Otherwise run `migrations.appliedQuery` with `pg_psql` (`app: <app>`) and check that the migrations that were pending in phase A now appear as applied successfully (and, if the query returns an installation timestamp, that it is later than the start of the deploy). If a pending migration is still not confirmed, the item is PENDING; a row with `success = false` is FAIL.

3. Health. `health_check` with `app: <app>`.

   It must answer `UP`. If it does not answer, report it as a data point.

4. Errors in the first minutes. `ps_list` and `get_app_logs` (app `<app>`, source `heroku`). `get_app_logs` returns only the recent lines of the buffer: state the window it covers.

### Deliverable

**OK / FAIL** with the evidence of each item. If there is a failure, suggest to the person going back to the last good release. You execute nothing.

- Warn about rollback semantics: a Heroku rollback to release vNNN (with the real vNNN; the person runs it, for example `heroku rollback vNNN -a <app>`) copies the code **and the config vars** of the target release, so it undoes any config var change made after that release.
- Before suggesting it, list the intermediate releases of the kind "Set ... config vars" or "Remove ... config vars" shown by `releases_list` with `limit: 10` (raise `limit` if needed). Give only the variable names, never their values.
- As an alternative, recommend redeploying the last good commit the way the person normally deploys.
