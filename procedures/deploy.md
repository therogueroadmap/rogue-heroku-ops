# Procedure: deploy

Two phases: preparation (before the person deploys) and post-deploy verification (when the person says the deploy finished). One call per response. You never deploy and never roll back: the person deploys the way they normally do (Dashboard, `git push heroku`, CI).

There is no console: every step is a call to an MCP tool, either the official one (`heroku-ops`) or the plugin's own (`heroku-ops-gaps`).

**Setup.** Call `get_config` first. It returns `apps[]` (each with `name`, `healthUrl`, `deployBranch`, `repoDir`, `repoSource` and the optional `migrations` block) and `n1Mode`. `repoDir` is the absolute path of the app's repository, or `null` when the app has none (`repoSource` is `repoPath`, `project` or `none`). Pick the target app: with a single app, use it; with several, use the one the request names. With several apps and no app named in the request: call only `get_config`, then stop and return (1) the question "Which app?", (2) a table with each app's `name`, repository (`repoDir` or "no repository") and `deployBranch`, and (3) how to ask again, for example "Use the heroku-ops agent for the GO/NO-GO of `<app>`". Do not pick an app yourself and do not run the procedure for every app. Below, `<app>` is the chosen `name` and `<branch>` is its `deployBranch`, unless the request names a branch (next paragraph). Always pass `app: <app>` where a tool takes the app, including every git tool.

**Requested branch.** If the request names a branch (for example "GO/NO-GO of `<app>` from `release/2026-12`"), that branch is `<branch>` in phases A and B for this request only, instead of the configured `deployBranch`. After `git_fetch`, `git_branches` (`app: <app>`) must list `origin/<branch>`; if it does not, item 1 is FAIL and you report it. If `git_fetch` fails, item 1 is PENDING and the branch check is not evaluated. If `git_fetch` succeeds and `origin/<branch>` is not listed by `git_branches`, item 1 is FAIL: skip the `git_log` of item 1, mark item 4 FAIL with the same reason (or "not configured" if the app has no migrations), still run items 2 and 3, and do not run item 5 (the result is already NO-GO). You never change the config. If the request names no branch, use the configured `deployBranch`.

**No repository.** If the app's `repoSource` is `none` (no `repoDir`), the git tools cannot run: items 1 and 4 are PENDING with the reason "no repository configured for the app" (item 4 only when the app has `migrations`; otherwise it stays "not configured"). Do not call the git tools for that app.

**Decision rule:** a GO/NO-GO with any PENDING item is never GO. If `heroku-ops-gaps` does not respond, continue with the official server, mark as PENDING the items that depended on it, and do not give GO. Any item that reports `success = false` is NO-GO.

## Phase A: preparation (GO / NO-GO)

1. Sync the repo and compare `<branch>` with the latest release.
   - `git_fetch` with `{ app: <app> }`. Then `git_branches` with `app: <app>`: it lists the remote branches (`origin/...`) as of the last `git_fetch`, and `origin/<branch>` must be among them (otherwise item 1 is FAIL). If `git_fetch` fails, the `origin` refs may be stale: item 1 is PENDING (never "OK with reservations") and you report the `git_fetch` error.
   - `git_log` with `app: <app>`, `rev: origin/<branch>`, `format: oneline`, `n: 20`.
   - `releases_list` with `app: <app>`, `limit: 5`.

   Each release description shows the deployed commit (`Deploy <sha>`); if the last deploy does not appear, raise `limit` (for example `limit: 20`). List the commits of `origin/<branch>` not yet in production with `git_log` (`app: <app>`) and `range: <sha>..origin/<branch>` (the `<sha>` from the description). With `git_show` (`app: <app>`, `rev: <sha>`, `format: stat`) or `git_diff` (`app: <app>`, `from`, `to`, `format: stat`) you can see what changes. If the deployed commit does not exist in the repo, report it. Never print config var values.

2. Dynos and recent errors. `ps_list` (app `<app>`) and `get_app_logs` (app `<app>`, source `heroku`, then source `app`). `get_app_logs` returns only the recent lines of the log buffer: state which time window it covers. No H1x/R1x codes and no repeated exceptions in what it covers = OK; the item is PENDING only if the tool fails or returns no lines.

   Dynos `up`, no H1x/R1x codes and no repeated exceptions in the recent logs.

3. Latest scheduled backup completed correctly. `pg_backups` (app `<app>`).

   For the detail of one backup: `backup_info` with `app: <app>` and `id: b001` (replace the id with the real one: a letter a, b or r followed by digits).

4. Pending database migrations. Use the app's `migrations` block (`<app>.migrations`).
   - If the app has no `migrations` block, report "not configured". That is not PENDING and does not block GO.
   - Otherwise list the migration files in `origin/<branch>`: `git_ls_tree` with `app: <app>`, `rev: origin/<branch>`, `recursive: true`, `nameOnly: true`, `paths: [<migrations.repoDir>]`, and keep only the names that match `migrations.filePattern`.
   - Run `migrations.appliedQuery` with `pg_psql` (`app: <app>`, `command: <appliedQuery>`).

   Pending = a repo file whose version does not appear in the query result as applied successfully. Any row with `success = false` (if the query returns that column) is NO-GO. To see the content of a pending migration: `git_show` with `app: <app>`, `rev: origin/<branch>` and `path: <migrations.repoDir>/<file>` (paths are relative to the app's repository).

   If `git_fetch` failed in item 1, `origin/<branch>` may be stale and the pending list is not reliable: item 4 is PENDING and you report that the comparison uses un-refreshed refs. A row with `success = false` is still NO-GO even if the fetch failed, because that row comes from the database, not from the repo.

   Example of an app's `migrations` block (Flyway preset):

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

Header: `Branch: <branch> (requested; configured: <deployBranch>)` when the request named a branch; otherwise `Branch: <branch>`.

**GO / NO-GO** with one line per item (1 to 5): OK / FAIL / PENDING (item 4 may also be "not configured") and the evidence (commit, release, dyno state, backup time and state, pending migrations). Remember: a GO/NO-GO with any PENDING item is never GO. If it is GO, add the steps for the person to deploy the way they normally do (Dashboard, `git push heroku`, CI) from `<branch>`, and remind them to tell you when it finishes.

## Phase B: post-deploy verification

No `Monitor`: the person triggers it when the deploy has finished. Check once; if the release has not changed yet, report it and do not loop.

1. New release. `releases_list` with `app: <app>`, `limit: 1`.

   It must be a `vNNN` greater than the one from phase A. If it did not change, report it and stop.

2. Migrations. Do not search the logs for migration-tool messages. If the app has no `migrations` block, report "not configured". Otherwise run `migrations.appliedQuery` with `pg_psql` (`app: <app>`) and check that the migrations that were pending in phase A now appear as applied successfully (and, if the query returns an installation timestamp, that it is later than the start of the deploy). If a pending migration is still not confirmed, the item is PENDING; a row with `success = false` is FAIL.

3. Health. `health_check` with `app: <app>`.

   It must answer `UP`. If it does not answer, report it as a data point.

4. Errors in the first minutes. `ps_list` and `get_app_logs` (app `<app>`, source `heroku`). `get_app_logs` returns only the recent lines of the buffer: state the window it covers.

### Deliverable

**OK / FAIL** with the evidence of each item. If there is a failure, suggest to the person going back to the last good release. You execute nothing.

- Warn about rollback semantics: a Heroku rollback to release vNNN (with the real vNNN; the person runs it, for example `heroku rollback vNNN -a <app>`) copies the code **and the config vars** of the target release, so it undoes any config var change made after that release.
- Before suggesting it, list the intermediate releases of the kind "Set ... config vars" or "Remove ... config vars" shown by `releases_list` with `limit: 10` (raise `limit` if needed). Give only the variable names, never their values.
- As an alternative, recommend redeploying the last good commit the way the person normally deploys.
