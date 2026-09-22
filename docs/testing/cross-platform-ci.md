# Cross-platform validation

Develop on any supported OS; the `Cross-platform CI` workflow runs every pull
request on Ubuntu 24.04, Windows Server 2025, and macOS 15 with Node 20, 22, and
24. Node 20 remains in the matrix to check the package's declared minimum major
version. Each job installs the lockfile with `npm ci`, typechecks, builds, and
runs the full unit/subprocess suite. A failing platform does not cancel the
other jobs. Pushes to `main` and manual workflow dispatch run the same checks.

## Local commands

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The fake Codex fixtures are Node programs with a POSIX launcher or Windows
`.cmd` launcher. They exercise the bridge's real child-process and RPC code,
without a Codex login, Feishu credentials, or model requests. Windows uses
named pipes for IPC tests. Tests of POSIX executable bits and Unix socket
permissions are explicitly skipped on Windows; they do not describe Windows
ACL behavior. The credential-dependent Claude live suite remains opt-in.

## Native service smoke tests

```sh
npm run test:native-service
```

This explicit command enables native service tests. Ordinary `npm test` skips
them. Run it in a disposable VM or CI runner: on macOS/Linux it temporarily
registers a uniquely named service that runs a small local Node worker. It does
not install, stop, restart, or read credentials from the real Bridge service.
The tests attempt service teardown even after a failure, preserving both the
original error and any cleanup errors. Temporary files are removed only after
teardown succeeds. If teardown cannot be confirmed, the unique fixture directory
is retained and the error includes manual service-cleanup commands and its path.

The Node 24 CI jobs also run these tests:

| Platform | Native evidence |
| --- | --- |
| macOS | Parse the generated plist with `plutil`; start and restart an isolated worker through launchd, checking the selected Codex executable and version. |
| Linux | Validate the generated unit with `systemd-analyze`; start and restart an isolated worker through the user systemd manager, checking the selected Codex executable and version. |
| Windows | Execute the generated `.cmd` through `cmd.exe` from fresh environments twice; verify the selected Codex executable/version, worker arguments, saved PATH, the service flag, and appended logs. |

The Linux job starts the runner's user systemd manager and supplies
`XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`. Native tests fail if the
required service manager is unavailable, rather than silently reporting a pass.

Windows smoke tests cover the login launcher's execution, **not** an actual
logout/login or the WMI/Task Scheduler restart path. The latter still has
dependency-injected unit tests.

### Reproduce executable selection before and after a change

```sh
npm run test:native-service -- -t 'preserves selected Codex'
```

Each case creates two harmless fake executables: an old version on `PATH` and
a new version selected by `CODEX_BIN`. A temporary worker bundles the production
`resolveCodexBin` and `codexVersion` implementation with `tsup`; it does not copy
or simulate the selection logic. First, fresh foreground processes prove that
PATH alone selects `fake-codex old-on-path` and the override selects
`fake-codex selected-by-override`. The actual service generator then sees the
override only while writing its definition. Native background startup and
restart must select the same new executable after the caller's override has
been removed. Logs print the selected path, version, environment value, and PID
so a failed baseline shows the actual old/new boundary.

Run the identical test and helper files against both source revisions. The
unfixed baseline is expected to fail the background assertion after both
foreground controls pass. Cases cover spaces and a second path containing
Chinese characters, literal `%` and `!`; Linux uses `%n` to expose systemd
specifier expansion, while Windows uses a defined `%FEISHU_SMOKE_LITERAL%`
and enables delayed expansion in the caller. Windows fixtures are tiny native
executables compiled with the runner's .NET Framework compiler, so their own
batch parsing cannot obscure the service bug. These executables only print a
sentinel version; an unexpectedly selected real Codex executable is never run.

Before implementation, the identical native macOS scenario was run against
`main` at `33e9db8` and the original PR #7 behavior merged with that baseline
(`1e15120`). The baseline failed both path cases: foreground selected the new
executable, but launchd selected the old executable and reported no `CODEX_BIN`.
Original PR #7 passed both cases through actual launchd startup and restart.
Separately, three Windows restart regression tests failed against the original
PR implementation with injected OS/process dependencies; those failures are
unit-test evidence, not a live Windows WMI or Task Scheduler run. Cloud native
results must be reported separately from this local reproduction evidence.

Definition tests additionally distinguish an unset builder override (no
assignment) from an explicit empty override (an empty assignment that clears an
inherited value). They check absolute-path normalization and platform
escaping separately from the native executable-selection scenario. That native
scenario and its assertions remain the same before and after the fix; only its
TypeScript fixture-options type was narrowed to accommodate the added optional
`codexBin` builder input. The Windows fixture also expands its executable paths
with native realpath so they match the long names returned by `where.exe`;
the macOS before/after scenario is unaffected by that fixture correction.

## Checks that still need a disposable interactive VM

When changing service installation, autostart, or restart behavior, also check:

1. Install and start with an ordinary, non-administrator account.
2. Restart through the CLI and the management console; verify the process is
   replaced and the selected executable/environment survives.
3. Log out and log in again; verify autostart. Stop/uninstall and verify it no
   longer starts after login.
4. Exercise paths containing spaces, non-ASCII characters, `%`, and `!` in the
   actual platform launcher, and test unavailable or moved executables.
5. On Windows, exercise both WMI and the Task Scheduler fallback where possible.

GitHub's Windows runners are administrators with UAC disabled, so passing CI
does not prove the non-administrator behavior. ARM virtual machines on Apple
Silicon complement the x64 Windows/Linux runners; one architecture does not
substitute for the other. No workflow deploys or publishes the package.

References: [GitHub runner environments](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and [matrix jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations).
