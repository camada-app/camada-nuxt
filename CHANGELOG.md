# Changelog

## Unreleased

### Fixed

- The challenge page carries core's own `Content-Security-Policy` (only its inline solver and
  style, by hash), and a `Content-Security-Policy(-Report-Only)` an earlier middleware set on
  `node.res` is removed from that response, so it neither replaces nor reports on the page's
  policy. (camada-all-mwpo)

### Changed

- The `exports` map now gives `require` its own `.d.cts` declarations (`import` and `require` each carry a `types` condition), so a CommonJS TypeScript app on `moduleResolution: node16` compiles; CI runs `@arethetypeswrong/cli`. (camada-all-vuzm)

## 0.1.3 (2026-10-09; follows 0.1.2)

Needs `@camada/core` 0.5.1.

### Fixed

- The snapshot client no longer re-polls back to back when `/snapshot` fails. It keeps its blocks and
  waits max(`retry-after`, 5 s), capped at the refresh interval (through `@camada/core` 0.5.1,
  camada-all-pbv9).

## 0.1.2 (2026-10-04; follows 0.1.1)

Needs `@camada/core` 0.5.0.

### Added

- `x-rid` response header: the rid of the request's event row, on every response the app answers
  (with a Node response). Not on camada's own answers.

### Changed

- `ts` is the request start, so `[ts, ts + dur]` is when the request ran.
- With a Node response (the Node presets), `dur` runs from the request start to the response
  finish, the whole body included. Without one (edge presets), the event ships before the app
  runs with `st` and `dur` null. It used to ship `dur` ≈ 0 there.

### Fixed

- Path rules match the canonical path (through `@camada/core` 0.5.0). A percent-encoded,
  upper-cased or trailing-slash spelling of a blocked path used to slip past the block.
- A request whose client disconnects mid-response (an aborted SSE stream) ships its event, with
  the status set so far and `dur` up to the disconnect. It used to leave no row.
