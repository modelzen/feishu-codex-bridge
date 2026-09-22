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
Temporary services and files are cleaned up after each test, including failures.

The Node 24 CI jobs also run these tests:

| Platform | Native evidence |
| --- | --- |
| macOS | Parse the generated plist with `plutil`; start and restart an isolated worker through launchd. |
| Linux | Validate the generated unit with `systemd-analyze`; start and restart an isolated worker through the user systemd manager. |
| Windows | Execute the generated `.cmd` through `cmd.exe` from fresh environments twice; verify worker arguments, saved PATH, the service flag, and appended logs. |

The Linux job starts the runner's user systemd manager and supplies
`XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`. Native tests fail if the
required service manager is unavailable, rather than silently reporting a pass.

Windows smoke tests cover the login launcher's execution, **not** an actual
logout/login or the WMI/Task Scheduler restart path. The latter still has
dependency-injected unit tests. This infrastructure does not implement the
`CODEX_BIN` persistence proposed in PR #7; that change should add native readback
and restart assertions for the override when it is implemented.

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
