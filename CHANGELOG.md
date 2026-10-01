# Changelog

## 0.1.2 (unreleased; follows 0.1.1)

Needs `@camada/core` 0.5.0.

### Changed

- `ts` is the request start, so `[ts, ts + dur]` is when the request ran.
- With a Node response (the Node presets), `dur` runs from the request start to the response
  finish, the whole body included. Without one (edge presets), the event ships before the app
  runs with `st` and `dur` null. It used to ship `dur` ≈ 0 there.

### Fixed

- A request whose client disconnects mid-response (an aborted SSE stream) ships its event, with
  the status set so far and `dur` up to the disconnect. It used to leave no row.
