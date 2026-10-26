# `dsh-backend-restart`

English | [中文](README.zh.md)

A DSH plugin that adds a **Restart backend** row at the end of the **General** settings page, just
above the version information. The action asks the running Host for permission to replace itself and then
relaunches the same command with the same working directory and environment, so the backend comes back on the
same port with the same Harness home. Running turns, terminals, and browser connections are interrupted; the
browser reloads itself once the successor listens again.

The wire format shared by the two halves is frozen in [CONTRACT.md](CONTRACT.md).

## Install

The plugin is a profile bundle, not a workspace package. Install it from this repository's root with the
DSH Plugin Manager, which links the directory into the active profile and records the bundle row:

```sh
dsh plugin --profile web add link:"$PWD/dsh-backend-restart"
```

In a running GUI session the same step is the `plugin_manager` tool with `action: install_bundle` and
`target: <absolute path to dsh-backend-restart>`; `application: "applied"` means the profile changed
and no restart was needed. The plugin then loads on the next full page load.

Beyond a local checkout, the bundle is distributable without a registry: `npm pack` in this directory
produces a tarball that installs by absolute path (or an `https:` URL), and a clone installs by Git with a
subdirectory selector, because this repository has no root `package.json`:

```sh
npm pack    # -> dsh-<name>-<version>.tgz (local only; nothing is published)
```

```js
plugin_manager({ action: "install_bundle", target: "/abs/path/dsh-<name>-<version>.tgz" })
plugin_manager({ action: "install_bundle", target: "git+https://github.com/jinluchang/deepseek-harness-plugins.git#<commit>&path:/dsh-<name>" })
```

Nothing here is published to an npm registry.

## Use

Open Settings (the account menu at the bottom of the sidebar, then **Settings**), stay on **General**, and
choose **Restart** on the **Restart backend** row that closes the page, immediately above the version line.
Confirm with **Restart**. On Linux web builds there is no keyboard shortcut for Settings; the account menu is
the entry point.

The action stays disabled with a localized note while a restart already owns the process, and it explains
itself when the running process cannot relaunch (an Electron main process, a launcher without swappable
argv, or a launcher that never exits).

## Verify

- Self-check: `node dsh-backend-restart/verify.mjs` parses the manifest and both halves, then asserts
  the channel contract, the refusal rules, the carrier-scope fallback, the supervisor's flags and probes, and
  the spawn-failure classification. Thirteen checks, hermetic: it never restarts anything.
- Syntax and manifest: `node --check dsh-backend-restart/index.js dsh-backend-restart/restart-helper.js`
  and `node -e "JSON.parse(require('node:fs').readFileSync('dsh-backend-restart/package.json'))"`.
- Supervisor behavior without a Host: the supervisor is a plain ESM module; its exported
  `parseArguments`, `probePort`, `waitForSlot`, `startSuccessor`, and `supervise` are exercised directly by
  passing flags on the command line and reading the exit codes documented in the module header.
- Host half without a browser: the plugin's `apply()` only needs a Cordis context exposing `connection.rpc`
  (and optionally `webServer`, `webServer.getOrigin`, `appExit`), so a fake context asserts the `status` and
  `restart` responses, the refusal cases, and the launch command it records.
- Full cycle: run an isolated instance with its own `DSH_HOME` on a spare port, mint a browser-session
  cookie from that profile, call `POST /backend-restart/restart`, and watch the pid change across the
  down/up transition.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: the channel, the refusal rules, the launch command, the exit request. |
| `restart-helper.js` | Detached successor supervisor; waits for the slot, starts and settles the new backend. |
| `client.js` | Browser half: the General-settings restart row, the confirmation, and the reload recovery. |
| `locale/en.json`, `locale/zh.json` | Plugin display metadata for the Plugin Manager and Settings inventory. |
| `icon.svg` | Plugin artwork, declared as the manifest `icon` for the Plugin Manager. |
| `cordis.patch.yml` | Bundle patch that inserts the plugin row into the profile. |
| `verify.mjs` | Hermetic self-check for the manifest, both halves, and the supervisor. |

## Limitations

- The Host cannot rebind its own port, so a restart is always a process replacement: the recorded launch
  command must be re-runnable, and the successor inherits only the predecessor's terminal, not its
  supervision. A backend started by hand in a shell that exits will not come back.
- The successor inherits the predecessor's environment, including `DSH_HOME`, so an isolated instance stays
  isolated across a restart.
- Two generations must not share one Harness home. The supervisor waits for the predecessor's process death
  observed through the inherited death pipe, and while that pipe is readable the death alone opens the gate,
  so a free port cannot start the successor early. The Host half always passes that pipe. The port-free grace
  is a fallback for a launcher that does not pass it and for one whose pipe fails while it runs: it waits
  6 seconds, longer than the launcher's own 5 second forced-exit bound, and then starts the successor even if
  the predecessor is alive, preferring a short overlap to no successor at all. A predecessor that outlives its
  own forced-exit bound is already abnormal, so the fallback bounds the overlap rather than removing it.

## License

The bundles in this repository are licensed under **GPL-3.0-or-later**. The canonical GNU GPL v3 text
ships with the package as [LICENSE](LICENSE); the "or later" grant lives in the `license` field of
`package.json` and in this notice, not in the unchanged license text.

Copyright (c) 2026 Luchang Jin.

Nothing here is published to an npm registry: installing a bundle means a local checkout, a local
`npm pack` tarball, or a Git URL pointing at this repository.
