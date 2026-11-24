# Port inventory: Windows-bound tests

Tests ported from the personal agent that assume Windows. Tasks 6 and 7 consume this table.
The suite is green on Windows today; the actions below are what each test needs before it
can run on macOS and Linux. Actions: port (works as is on every platform), rewrite (change
the code under test and the test), skip (`{ skip: process.platform !== 'win32' }`).

| Test file | Test | Windows dependency | Action |
|---|---|---|---|
| `mcp-gaps/test/exec.test.js` | `resolve: sigue la versión que nombra heroku.cmd` | Fake `LOCALAPPDATA` tree with `heroku\client\bin\heroku.cmd` and `node.exe` | skip on non-Windows (Windows resolver kept behind `resolveHerokuCli`) |
| `mcp-gaps/test/exec.test.js` | `resolve: tras una autoactualización devuelve la nueva versión` | Same `LOCALAPPDATA` + `heroku.cmd` layout | skip on non-Windows |
| `mcp-gaps/test/exec.test.js` | `resolve: sin heroku.cmd, la versión semver más alta` | `LOCALAPPDATA` client directory, `node.exe` | skip on non-Windows |
| `mcp-gaps/test/exec.test.js` | `resolve: fallback a Program Files` | `PROGRAMFILES` path, `node.exe` | skip on non-Windows |
| `mcp-gaps/test/exec.test.js` | `resolve: lanza si no hay CLI` | `localAppData`/`programFiles` inputs | rewrite: on non-Windows, resolve the CLI from PATH and throw when absent |
| `mcp-gaps/test/exec.test.js` | `resolve: override devuelve process.execPath + script` | `C:\x\fake.js` literal | port (use a neutral path) |
| `mcp-gaps/test/exec.test.js` | `constants`, `buildChildEnv`, `runFile: *`, `utf8CompleteLength ...` | none (spawn `process.execPath`) | port |
| `mcp-gaps/test/server.test.js` | server startup test with `LOCALAPPDATA: empty, PROGRAMFILES: empty` (CLI not found) | Windows CLI lookup variables | rewrite: simulate a missing CLI via PATH on non-Windows |
| `mcp-gaps/test/server.test.js` | tests using `HEROKU_OPS_TEST_CLI` | none (override) | port |
| `mcp-gaps/lib/tools.js` / `server.js` (code, no test) | `gitExe` defaults to `git.exe`; `localAppData` taken from `env.LOCALAPPDATA` | `git.exe` hard-coded | rewrite: `git` from PATH; no fixed `.exe` |
| `mcp-gaps/test/argv.test.js` | git argv tests (`-C 'C:\repo x'`, repoPath `C:\repo x`) | Windows drive path in `repoPath` | port (the path is only an opaque argument; use a platform-neutral value when convenient) |
| `mcp-gaps/test/schemas.test.js` | path rejection list (`C:\x`), `repoPath: C:\repo` | Windows drive literals | port (rejection of drive paths must stay on every platform) |
| `mcp-gaps/test/validate.test.js` | absolute and UNC path rejection (`C:/x`, `\srv\s`) | Windows path forms | port |
| `hooks/test/policy.test.js` | `isPathAllowed` (all cases) | `path.win32` semantics, `C:\` roots, backslash separators, case-insensitive compare | rewrite: choose `path.win32` vs `path.posix` per platform; keep the win32 cases under skip on non-Windows and add POSIX equivalents |
| `hooks/test/policy.test.js` | config fixture with `repoPath: 'C:\repo'`, `postgresBin: 'C:\Program Files\...'` | Windows paths | rewrite (`postgresBin` is dropped from the schema) |
| `hooks/test/evaluate.test.js` | Read/Grep/Glob path tests (`C:\Users\dev\.netrc`, `repoPath + '\pom.xml'`, Glob path `C:\Users`) | `escapesPath` uses `path.win32.isAbsolute`; backslash joins | rewrite together with `evaluate.js`/`policy.js`; add POSIX absolute-path cases |
| `hooks/test/evaluate.test.js` | `cfg()` fixture with `postgresBin` and `sqlRewrite` | Windows path; removed config keys | rewrite (drop `postgresBin`, `sqlRewrite`) |
| `hooks/test/guard.test.js` | decision line of a denied shell command; PowerShell `pg:psql` deny | `git -C "C:\Users\dev\project"`, `$env:Path = "C:\Program Files\PostgreSQL\..."` as command text | port (the text is only denied input; use platform-neutral samples when convenient) |
| `hooks/test/guard.test.js` | fixture config (`FIXTURE`) | `repoPath`, `postgresBin` Windows paths | rewrite once the plugin config location exists (Task 4) |
| `hooks/test/audit.test.js` | `summarizeDeniedCommand('"C:\tools\heroku.cmd" ...')`, `'"C:\Program\git.exe" log'` | Executable-name stripping of `.cmd`/`.exe` and Windows directories | port (still valid: the audit must strip these on any platform) |
| `hooks/test/sql.test.js` | `\! dir` psql meta-command sample | none (denial sample only) | port |

Note: `hooks/test/shell.test.js`, `hooks/test/agent.test.js` and `hooks/lib/shell.js` were not
ported. Bash and PowerShell calls get a fixed deny from `evaluate()`.
