// @camada/nuxt — the h3 binding over @camada/core/fetch. The pipeline (verdict, block,
// challenge, beacon endpoints, the wire event) lives in core; this file only says what h3 knows:
// the Web Request, the socket peer, the process env, and when the response has settled.
import { defineEventHandler, getRequestIP, setCookie, toWebRequest, type EventHandler, type H3Event } from 'h3';
import { guarded, TAP_NUXT } from '@camada/core';
import { createFetchCamada, SESSION_COOKIE, type FetchCamada, type FetchCamadaOptions, type FetchRequestContext, type FetchVars } from '@camada/core/fetch';
import iife from '@camada/browser/iife-string';
import { SDK_ID } from './version.js';

export type CamadaNuxtOptions = FetchCamadaOptions;
export type CamadaNuxtVars = FetchVars;

/** The `event.context` slot the middleware fills; `track()` and `scriptTag()` are the API, not the slot. */
export const CONTEXT_KEY = 'camada';
const SESSION_MAX_AGE = 2592000;

interface Slot { cam: FetchCamada; vars: FetchVars }

// Every instance this module built, so a test or a hot reload can stop them all at once.
const instances = new Set<FetchCamada>();

/** Reads the slot without trusting the event shape: a stub or a foreign event must not throw. */
const slotOf = (event: H3Event): Slot | undefined =>
  guarded(() => (event.context?.[CONTEXT_KEY] as Slot | undefined) ?? undefined, undefined);

/**
 * The server middleware: `export default camada()` in `server/middleware/camada.ts`. Reads
 * `CAMADA_KEY` / `CAMADA_INGEST_URL` / `CAMADA_SNAPSHOT_URL` from `process.env`; without a key
 * it is inert. Returns a web Response where camada answers (block, challenge, the beacon
 * endpoints) and falls through otherwise.
 */
export function camada(opts: CamadaNuxtOptions = {}): EventHandler {
  const cam = createFetchCamada({ tap: TAP_NUXT, sdk: SDK_ID, iife }, { mode: 'lazy', ...opts });
  instances.add(cam);
  return defineEventHandler(async (event) => {
    const req = guarded(() => toWebRequest(event), null);
    if (!req) return;   // an event h3 cannot express as a Request is not ours to break
    const ctx: FetchRequestContext = {
      // The socket address (or what the host preset stamped as clientAddress); never
      // X-Forwarded-For here, core resolves that under the trusted-proxy rules.
      peer: guarded(() => getRequestIP(event) ?? null, null),
      env: guarded(() => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env, undefined),
    };
    const r = await cam.before(req, ctx);
    if (!r) return;
    if (r.response) return r.response;
    const vars = r.vars;
    event.context[CONTEXT_KEY] = { cam, vars } satisfies Slot;
    const res = event.node?.res;
    // Set before the app runs so a handler's own redirect carries the session too; core only
    // hands a cookie for a new session, so an existing `_sfp` is never overwritten. h3 1.x
    // writes cookies through node.res, so an event without one gets no session, quietly.
    if (vars.sessionCookie && vars.sid && res) {
      const sid = vars.sid;
      guarded(() => setCookie(event, SESSION_COOKIE, sid, {
        path: '/', maxAge: SESSION_MAX_AGE, httpOnly: true, sameSite: 'lax', secure: new URL(req.url).protocol === 'https:',
      }), undefined);
    }
    // Node presets expose the response: ship with the real status once it has settled. Edge
    // presets have no node.res, so the event goes now with st null rather than never.
    if (typeof res?.once === 'function') res.once('finish', () => cam.after(req, vars, res.statusCode));
    else cam.after(req, vars, null);
  });
}

/**
 * Records an outcome the app knows and the wire cannot show: `login_failed`, `login_succeeded`,
 * `signup`, `password_reset`, `mfa_failed`, `payment_failed`, `payment_succeeded`, `coupon_failed`
 * (free-form; that vocabulary is what the analyst's rules read). Joined to this request's event
 * through its rid and session; the user identifier is HMAC-hashed in-process. Never throws, and
 * a silent no-op where the middleware did not run.
 */
export function track(event: H3Event, et: string, data?: { user?: string }): Promise<void> {
  const s = slotOf(event);
  return s ? s.cam.track(s.vars, et, data) : Promise.resolve();
}

/** The `<script>` tag for an HTML response — `''` where the middleware did not run or the tenant turned the beacon off. */
export function scriptTag(event: H3Event): string {
  const s = slotOf(event);
  return s ? s.cam.scriptTag(s.vars) : '';
}

/** Test/reset hook: stops and drops every engine behind every `camada()` this module created. */
export function resetCamada(): void {
  for (const c of instances) c.reset();
}
