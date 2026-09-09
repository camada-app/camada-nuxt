# @camada/nuxt

camada for [Nuxt](https://nuxt.com) as h3 server middleware: enforces the tenant snapshot inline
(your ordered custom rules, then block, allow, challenge), serves a first-party proof-of-work
challenge page and beacon, records the outcomes your server routes know (`track()`), and ships
one wire event per request with the status your app really answered. Fails open by design — a
camada outage or bug never 5xxes your app.

Not yet on npm — consumed via a `file:` dependency from a sibling checkout.

## Quickstart

Two files under `server/`:

```ts
// server/middleware/camada.ts
import { camada } from '@camada/nuxt';
export default camada();   // reads CAMADA_KEY / CAMADA_INGEST_URL / CAMADA_SNAPSHOT_URL from process.env
```

```ts
// server/plugins/camada.ts
import { camadaNitroPlugin } from '@camada/nuxt';
export default camadaNitroPlugin();   // puts the beacon tag in every rendered <head>
```

Env (printed by camada onboarding / `npm run seed` in dev):

```
CAMADA_KEY=<ingest_token>.<snap_token>
CAMADA_INGEST_URL=http://localhost:8787        # dev only; defaults to production ingest
```

An app that reads its own config can pass the values instead:

```ts
export default camada({ key: MY_KEY, ingestUrl: MY_INGEST });
```

The middleware is built once per `camada()` call and keeps one engine per resolved
configuration. Without `CAMADA_KEY` it is inert (one log line, no requests, no enforcement),
so an unprovisioned environment behaves exactly as if camada were not installed.

## What it does per request

1. Refreshes the snapshot off-path (lazy mode by default: no interval timers, so the same
   build runs on a Node server and on an edge preset). Every poll and event batch carries
   `x-camada-sdk: @camada/nuxt/<version>`, and polls ask for snapshot v5 — the container that
   carries your ordered custom rules.
2. Resolves the client from the peer h3 vouches for — `getRequestIP(event)`: the socket
   address, or the `clientAddress` a Nitro preset stamped on the context — combined with
   `X-Forwarded-For` only under your tenant's trusted-proxy config. A bare header
   (`x-forwarded-for`, `cf-connecting-ip`, `x-real-ip`) never becomes the client on its own.
3. Runs your ordered custom rules, then the allow, block and challenge lists.
4. **Block** → `403` with `x-block-reason` before your route; the event still ships, with
   `st: 403` and `blk: <reason>` so the analyst counts SDK blocks apart from your own 403s.
5. **Challenge** → a `403` proof-of-work page for HTML navigations, `403 {"error":
   "challenge_required"}` for anything else; the solution posts to `/__camada/challenge`,
   which sets `_cch` and 302s back.
6. Otherwise the request falls through to your routes and pages. The event ships on the
   response's `finish` with the real `statusCode` — a Node response, or the mock a web preset
   provides; `st` is null only for an event without a response object at all. Your own
   `readBody()` still sees the request body (the middleware hands h3 the stream it built), and
   Nitro's internal `$fetch` / `useFetch` during SSR is left to the outer request: one page view
   is one event.

A first visit is given the shared `_sfp` session cookie through h3's `setCookie` before your
handler runs (`HttpOnly; SameSite=Lax; Path=/; Max-Age=30d`, `Secure` when the request URL is
https), so a redirect from your own handler carries it too. An existing session is never
overwritten.

## Options

| option | default | meaning |
|---|---|---|
| `key` | `env.CAMADA_KEY` | `<ingest_token>.<snap_token>`; without it the middleware is inert |
| `ingestUrl` | `env.CAMADA_INGEST_URL` | ingest base; batches go to `<ingestUrl>/e` |
| `snapshotUrl` | `<ingestUrl>/snapshot` | snapshot endpoint |
| `trustedProxy` | server config | `none` / `vercel` / `hops:N` / `cidrs:a,b`, or the parsed object |
| `challenge` | `true` | serve the proof-of-work page for `challenge` verdicts |
| `challengePath` | `/__camada/challenge` | where that page posts its solution |
| `snapshotVersion` | `5` | `4` drops the custom rules, `3` the allow/challenge sides too |
| `scriptPath` | `/_cam/b.js` | where the first-party beacon script is served |
| `fpPath` | `/_cam/fp` | where that script posts the beacon; keep it in `scriptPath`'s directory |
| `mode` | `lazy` (or `timer`) | `timer` polls the snapshot on an unref'd interval (long-lived process); `lazy` refreshes it per request off-path. `CAMADA_SERVERLESS=1` forces `lazy` |
| `env` | `process.env` | overrides the process env (tests, and apps that read config themselves) |

`CAMADA_CHALLENGE=0` switches the challenge off without a code change.

`CAMADA_DISABLED=1` switches everything off, checked per request.

## The first-party beacon

Bots that never run JavaScript are the cheapest to catch. The Nitro plugin above pushes the tag
into the `<head>` Nuxt renders; a server route that writes its own HTML uses the helper:

```ts
import { scriptTag } from '@camada/nuxt';

export default defineEventHandler((event) => `<html><head>${scriptTag(event)}</head><body>…</body></html>`);
```

`scriptTag(event)` returns `<script src="/_cam/b.js?r=<rid>" async></script>` — the `rid` is this
request's event id, so the analyst joins the beacon to the page view. The middleware serves the
script at `GET /_cam/b.js` (cacheable, 1 h) and relays `POST /_cam/fp` (≤ 32 KB, answers 204)
onto the event batch as a `sig: 1` row stamped with the client ip camada resolved — never the
one the body claims. Both endpoints sit behind the verdict: a blocked client gets 403 there
too. The tag is `''` where the middleware did not run or the project turned the beacon off in
its settings, and the endpoints stand down with it.

## App-context events

The wire shows a `POST /api/login`; only your route knows whether it failed. Tell camada:

```ts
// server/api/login.post.ts
import { track } from '@camada/nuxt';

export default defineEventHandler(async (event) => {
  const { email, password } = await readBody(event);
  const ok = await signIn(email, password);
  if (!ok) track(event, 'login_failed', { user: email });   // await optional
  setResponseStatus(event, ok ? 200 : 401);
  return ok ? { ok } : 'Invalid credentials';
});
```

`track(event, name, { user? })` ships `{ et, uid, rid, sid, ip, ts }` joined to this request's
event. The user identifier is HMAC-hashed in-process with the ingest token — the raw value never
leaves the process. It never throws and is a no-op where the middleware did not run. The event
name is free-form; the analyst's rules read this vocabulary:

| event | when |
|---|---|
| `login_failed` / `login_succeeded` | a credential check settled |
| `signup` | an account was created |
| `password_reset` | a reset was requested |
| `mfa_failed` | a second factor was rejected |
| `payment_failed` / `payment_succeeded` | a charge settled |
| `coupon_failed` | a promo code was rejected |

## What this tap can see

This is the in-app position: the beacon, the client hints the browser sends, the status your
app answered, the session, and the outcomes your routes report. h3 vouches for the peer
address (the socket, or a preset's `clientAddress`) and for nothing about the connection
beyond it: no ASN, country or TLS fingerprint, so rules on those conditions do not enforce here
(the analyst knows that from the tap's capability mask, `sdk-nuxt`, and never scores their
absence as evidence). The protocol on the event is `null` — h3 does not see the client's own —
and the one forwarded header h3 does honour is `x-forwarded-proto`, which decides only whether
the session cookie is marked `Secure`. Node normalises header order, so the raw-wire-order
signal is not available either.

## Fail open

Every entry point runs inside camada's guard. A dead ingest, a corrupt snapshot, a bug in this
package: telemetry is lost, the request is not.
