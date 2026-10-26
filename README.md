# deepseek-harness-plugins

Four standalone DeepSeek Harness (DSH) plugin bundles.
Each one installs into a DSH host as a profile bundle, carries its own English and Simplified Chinese
README, and ships a hermetic verification suite that runs without a live Host.

| Bundle | What it does | Where it appears | Documentation |
| --- | --- | --- | --- |
| `dsh-backend-restart` | Adds a **Restart backend** action: asks the Host to replace itself over the `/backend-restart` RPC channel, then reloads the page once the successor answers. | Settings → **General**, in a row above the version line | [English](dsh-backend-restart/README.md) · [中文](dsh-backend-restart/README.zh.md) |
| `dsh-compaction-tuner` | One page that owns the full eleven-key `compaction-basic` policy and pushes the tune into every agent preset in the active profile. | Settings → **Compaction tuner** (last nav row) | [English](dsh-compaction-tuner/README.md) · [中文](dsh-compaction-tuner/README.zh.md) |
| `dsh-lead-agent-only-leads` | Adds the **Lead agent only leads** preset — a Team Lead that delegates every job and never waits on a teammate — plus the host plugin that enforces the tool restrictions. | Session preset picker; Settings → **Lead agent only leads** for the tool toggles | [English](dsh-lead-agent-only-leads/README.md) · [中文](dsh-lead-agent-only-leads/README.zh.md) |
| `dsh-use-repo-tmp` | Prompt-only guidance that sends scratch files to `<workspace>/tmp` instead of `/tmp`, as one static system-prompt section plus a runtime-context line. | No UI | [English](dsh-use-repo-tmp/README.md) · [中文](dsh-use-repo-tmp/README.zh.md) |

## Requirements

- **DSH `^0.2.1-rc.3`** — declared as `engines.dsh` in every manifest, so a DSH host outside that range
  refuses the install.
- These packages declare no separate Node.js version. Their verification scripts are plain ESM and run
  with the `node` binary you already use for DSH.

## Installation

A bundle is an npm package whose `package.json` declares `dsh.bundle.patch`; installing it adds that patch
layer to the active DSH profile. Three routes work today, and none of them needs a registry.

### From a local checkout (absolute path)

From this repository's root, with the DSH CLI:

```sh
pnpm dsh plugin --profile web add link:"$PWD/dsh-backend-restart"
```

Or from a running GUI session, with the `plugin_manager` tool:

```js
plugin_manager({ action: "install_bundle", target: "/abs/path/to/deepseek-harness-plugins/dsh-backend-restart" })
```

The installer links the package into the profile and records the bundle row; the plugin loads on the next
full page load.

### From a tarball

`npm pack` inside a bundle directory produces a local tarball that installs by absolute path (or by an
`https:` URL):

```sh
cd dsh-backend-restart
npm pack    # -> dsh-backend-restart-0.2.1-rc.3.tgz
```

```js
plugin_manager({ action: "install_bundle", target: "/abs/path/dsh-backend-restart-0.2.1-rc.3.tgz" })
```

### From Git (subdirectory selector)

There is no root `package.json`, so a bare `github:jinluchang/deepseek-harness-plugins` install cannot
resolve a package. Address one bundle with a `path:` selector instead:

```js
plugin_manager({ action: "install_bundle", target: "git+https://github.com/jinluchang/deepseek-harness-plugins.git#<commit>&path:/dsh-backend-restart" })
```

Pin a commit for `<commit>`; the same spec form works for the other three bundles with their own
`path:/dsh-<name>`.

## Nothing is published to npm

These bundles are **not published**: `npm install dsh-backend-restart` does not resolve. Their manifests
set `"private": false` and carry publish metadata, so a release is possible later, but nothing has been
published to any registry.

## Notes

- `dsh-compaction-tuner` writes its tune into the profile's preset rows on the first boot; uninstalling it
  does not revert that. See *Install behaviour change* in its [README](dsh-compaction-tuner/README.md).
- The preset added by `dsh-lead-agent-only-leads` applies to **new sessions**: restart the Host, then pick
  **Lead agent only leads** when starting a session.

## Verification

Each bundle ships a self-contained `verify.mjs`; no network, no server, and no live Host. Set
`DSH_HARNESS_CHECKOUT` to a DSH source checkout — it is required for a green run: the compaction tuner
fails loudly without it, and the other suites resolve the checkout's libraries through it.

```sh
export DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness

node dsh-backend-restart/verify.mjs          # 13 checks passed
node dsh-compaction-tuner/verify.mjs         # 99 passed, 0 failed, 0 skipped (99 checks)
node dsh-lead-agent-only-leads/verify.mjs    # 45/45 checks passed
node dsh-use-repo-tmp/verify.mjs             # 14 checks passed
```

## Repository layout

```text
.
├── LICENSE                     GPL-3.0-or-later
├── THIRD-PARTY-NOTICES.md      upstream MIT text + provenance
├── dsh-backend-restart/        README.md README.zh.md CONTRACT.md LICENSE verify.mjs package.json …
├── dsh-compaction-tuner/       README.md README.zh.md CONTRACT.md LICENSE verify.mjs package.json …
├── dsh-lead-agent-only-leads/  README.md README.zh.md CONTRACT.md LICENSE verify.mjs package.json …
└── dsh-use-repo-tmp/           README.md README.zh.md CONTRACT.md LICENSE verify.mjs package.json …
```

## License

This repository is licensed under **GPL-3.0-or-later**; the canonical GNU GPL v3 text is in
[LICENSE](LICENSE).

Copyright (c) 2026 Luchang Jin.

[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) records the MIT-licensed DeepSeek Harness plan-mode
prompt text embedded unchanged in `dsh-lead-agent-only-leads/cordis.patch.yml`; that text stays under the
MIT License, and the notice carries its provenance and hashes.
