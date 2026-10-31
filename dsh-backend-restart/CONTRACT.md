# Frozen interface: `dsh-backend-restart`

Package directory: `dsh-backend-restart/` (installed into the active DSH profile as a bundle).

## Why this exists

The Plugin Manager already reports `application: 'restart-required'` for changes that need a new process
generation (replaced JavaScript, moved packages), and its tool text tells the user to restart DSH by hand.
This plugin turns that manual step into a **Restart backend** row on the General settings page, rendered as
the last preference above the version line.

## Host ↔ Client wire (do not change without updating both halves)

The Client half is a bundle client module; it reaches its Host half through the shared Connection service
that the browser already uses for every other Host call. Both sides must agree on these exact values.

| Item | Value |
| --- | --- |
| Channel | `/backend-restart` (matches Connection's `^/[A-Za-z0-9._~-]+$`, never `/api`) |
| Host registration | `ctx.webServer.register({ kind: 'prefix', path: '/backend-restart', handler })` inside `ctx.effect`; every request first passes `ctx.connection.requestRejection(req)` |
| Client call | `ctx.get('connection').rpc.call('/backend-restart', endpoint, payload, signal)` |

The channel is authenticated: `HostConnectionService.requestRejection()` applies the Host/Origin fence
plus the browser credential, so only an admitted browser peer reaches the envelope parser and handler.
Both halves must treat a thrown or rejected call as "the backend is unreachable".

Transport behavior mirrors Connection's own channel adapter, so the Client cannot tell this channel from
one registered through Connection: only `POST` inside `/backend-restart/` is dispatched (any other method
or path answers `404`), a non-JSON media type answers `415`, unreadable JSON answers `400`, and a
malformed or misframed envelope answers `200` with a `server-response` whose `result.error.code` is
`gateway/bad-request`. A handler exception answers `500` with `handler failure: <error>` text. The
browser caller sees every non-2xx answer as a transport rejection, never as a refusal result.

### Endpoint `status`

Request payload: `{}` (ignored). Response `value`:

```json
{ "status": "running", "pid": 1234, "restartable": true, "reason": "optional human-readable detail" }
```

- `status`: `"running"` or `"restarting"` (a restart request already owns the process).
- `pid`: the Host process id answering.
- `restartable`: whether a restart request would be accepted here, `false` while a restart owns the
  process (`reason: "a restart is already in progress"`) and `false` carries `reason` in every other
  refused case too.
- `reason`: present only when `restartable` is `false`; diagnostic English text, never product copy.

### Endpoint `restart`

Request payload: `{}` (ignored). Success response `value`:

```json
{ "status": "restarting", "pid": 1234 }
```

The Host replies **before** it disposes the application tree, so a successful reply means the successor
supervisor has been started, not that the new process is already serving. A lost reply is therefore
ambiguous with success: the Client must treat a transport rejection of this call as "possibly restarting"
and continue with the recovery sequence below.

Failure response `error`: `{ "code": "backend-restart/<reason>", "message": <diagnostic English>, "details": {} }`.

| `code` | Meaning |
| --- | --- |
| `backend-restart/busy` | A restart request already owns this process. |
| `backend-restart/unsupported` | This process cannot relaunch itself (Electron main process, missing launch command, or no launcher exit). |
| `backend-restart/spawn-failed` | The successor supervisor could not be started. |
| `backend-restart/unknown-endpoint` | Endpoint name outside `status`/`restart`. |

Client copy must localize every failure; `message` is diagnostic only.

## Client recovery sequence (owned by the Client half)

1. On mount, call `status`. Render the action; when `restartable` is `false`, disable it with `reason`-free
   localized copy (the Host `reason` is not product text). A failed first call is retried a few times before
   the action is declared unreachable, so one transient miss does not hide it.
2. On confirm, call `restart`. A resolved `{ ok: false }` refusal shows the localized per-code failure copy
   inline (`role="alert"`) and re-enables the action. A **transport rejection** is not a refusal — the process
   may have exited before answering — so it enters the same recovery state as a success.
3. In the recovery state, poll `GET` on the current document root until the fetch **rejects** (the old
   listener is gone), then until it **resolves** (the successor listens again), then `location.reload()`.
4. If the down/up transition does not complete inside the poll budget, show the localized timeout copy and
   offer a manual reload instead of leaving the user on a dead page.

## Host requirements

The Host exposes the Connection service and the Web carrier. The plugin mounts its channel as a
`webServer` prefix route owned by its own fiber, so unloading the plugin removes it; each request asks
`ctx.connection.requestRejection(req)` for the trust fence before anything is parsed.

The route is deliberately **not** registered through `ctx.connection.rpc.handle()`. The defect is in
the Host's `packages/client/connection/src/rpc-host.ts` (`get rpc()` at `:105-112`, `register()` at
`:253-277`, throw at `:274`) together with the Cordis 4.0.0-rc.11 core rework: `this.ctx` inside that
service method resolves as the Connection provider's def-site context, whose inject list is
`['credentials']`, not the caller's `['connection', 'webServer']`. The accessor therefore throws
`cannot get property "webServer" without inject` even though this plugin declares and can read
`webServer`, and no caller-side scope (`ctx.root`, `ctx.get`, `ctx.inject(...)`) repairs it. Mounting the
route here keeps the wire contract above on current Hosts without a composition patch; do not revert to
`ctx.connection.rpc.handle()` while that Host code is unchanged.

## Build rules

- Plain ESM JavaScript, no build step, no dependencies beyond `node:` builtins and the React the browser
  module table provides.
- `locale/en.json` and `locale/zh.json` carry plugin **display metadata** only
  (`meta.title`, `meta.description`) for the Plugin Manager and Settings inventory.
  Client UI copy is registered from the Client half through `ctx.locale.register(ns, locale, dict)`.
- Style only with host theme tokens (`--dsw-alias-*`); do not import Harness Client packages.
