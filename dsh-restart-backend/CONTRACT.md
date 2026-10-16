# Frozen interface: `@local/dsh-restart-backend`

Package directory: `plugins/dsh-restart-backend/` (installed into the active DSH profile as a bundle).

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
| Channel | `/restart-backend` (matches Connection's `^/[A-Za-z0-9._~-]+$`, never `/api`) |
| Host registration | `ctx.connection.rpc.handle('/restart-backend', handler)` inside `ctx.effect` |
| Client call | `ctx.get('connection').rpc.call('/restart-backend', endpoint, payload, signal)` |

The channel is authenticated: `HostConnectionService.admit()` applies the Host/Origin fence plus the
browser credential, so only an admitted browser peer reaches the handler. Both halves must treat a thrown
or rejected call as "the backend is unreachable".

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

Failure response `error`: `{ "code": "restart-backend/<reason>", "message": <diagnostic English>, "details": {} }`.

| `code` | Meaning |
| --- | --- |
| `restart-backend/busy` | A restart request already owns this process. |
| `restart-backend/unsupported` | This process cannot relaunch itself (Electron main process, missing launch command, or no launcher exit). |
| `restart-backend/spawn-failed` | The successor supervisor could not be started. |
| `restart-backend/unknown-endpoint` | Endpoint name outside `status`/`restart`. |

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

The channel is registered on the shared carrier through `ctx.connection.rpc.handle`, which owns the route
with the plugin's fiber. A Host whose connection provider cannot resolve `webServer` through the accessor
scope refuses that call with Cordis's property-guard error; the Host half then registers the identical route
on the root scope and still removes it on unload. Either path yields the single channel documented here.

## Build rules

- Plain ESM JavaScript, no build step, no dependencies beyond `node:` builtins and the React the browser
  module table provides.
- `locale/en.json` and `locale/zh.json` carry plugin **display metadata** only
  (`meta.title`, `meta.description`) for the Plugin Manager and Settings inventory.
  Client UI copy is registered from the Client half through `ctx.locale.register(ns, locale, dict)`.
- Style only with host theme tokens (`--dsw-alias-*`); do not import Harness Client packages.
