// @camada/nuxt against the golden v4 snapshot, driven through a real h3 app on a real node:http
// server: that is what proves the wire event ships on the response's `finish`, with the status
// the app really answered, exactly once. The fixtures are read through the file: symlink to
// @camada/core, so this package is pinned to the same bytes edge-analyst generates.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp, createRouter, eventHandler, sendRedirect, setResponseStatus, toNodeListener, type App, type H3Event } from 'h3';
import { CHALLENGE_COOKIE } from '@camada/core';
import iife from '@camada/browser/iife-string';
import { camada, camadaNitroPlugin, resetCamada, track, scriptTag, type CamadaNuxtOptions } from '../src/index.js';

const FIX = fileURLToPath(new URL('../node_modules/@camada/core/test/fixtures/blk3/', import.meta.url));
const container = (dir: string, name: string) => ({
  bin: readFileSync(dir + name + '.bin'),
  meta: JSON.stringify(JSON.parse(readFileSync(dir + name + '.meta.json', 'utf8'))),
});
const V4 = container(FIX, 'v4-basic');

const BLOCKED_IP = '203.0.113.66';     // block side
const HTML = { accept: 'text/html', 'sec-fetch-dest': 'document' };
const PEER = '127.0.0.1';              // what node:http vouches for on the loopback listener

const CONFIG = { tenant: 'acme', beacon: true, sample: 1, exclude: [], trusted_proxy: { mode: 'none' }, poll_seconds: 30 };
const ENV = { CAMADA_KEY: 'tok-acme.snap-acme', CAMADA_INGEST_URL: 'http://analyst.test', CAMADA_SNAPSHOT_URL: 'http://analyst.test/snapshot' };

// 200 body frame: [u32 LE meta-length][meta JSON][BLK bin]
function frame(): ArrayBuffer {
  const m = new TextEncoder().encode(V4.meta);
  const f = new Uint8Array(4 + m.length + V4.bin.length);
  new DataView(f.buffer).setUint32(0, m.length, true);
  f.set(m, 4); f.set(new Uint8Array(V4.bin), 4 + m.length);
  return f.buffer;
}

let events: Array<Record<string, unknown>>;
let sdkHeaders: string[];

const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith('/snapshot')) {
    return new Response(frame(), { status: 200, headers: { etag: `"${JSON.parse(V4.meta).version}"`, 'x-camada-config': JSON.stringify(CONFIG) } });
  }
  sdkHeaders.push(new Headers(init?.headers).get('x-camada-sdk') ?? '');
  events.push(...(JSON.parse(String(init?.body)) as Array<Record<string, unknown>>));
  return new Response(null, { status: 202 });
}) as typeof fetch;

/** The routes every app under test serves; `mount` decides what sits in front of them. */
function routes(mount: (app: App) => void): App {
  const app = createApp();
  // node:http fixes the socket at 127.0.0.1, so a test that needs another peer stamps
  // `context.clientAddress` — h3's field for a host that knows the client better than the
  // socket, and the first thing getRequestIP reads. A client header never reaches it.
  app.use(eventHandler((e) => { const p = e.headers.get('x-test-peer'); if (p) e.context.clientAddress = p; }));
  mount(app);
  const r = createRouter();
  r.get('/', eventHandler(() => 'home'));
  r.get('/cart', eventHandler(() => '<p>cart</p>'));
  r.get('/checkout', eventHandler(() => '<p>checkout</p>'));
  r.get('/admin/users', eventHandler(() => '<p>admin</p>'));
  r.get('/page', eventHandler((e) => `<html><head>${scriptTag(e)}</head><body>page</body></html>`));
  r.get('/redirect', eventHandler((e) => sendRedirect(e, '/', 302)));
  r.get('/raw-redirect', eventHandler(() => Response.redirect('http://app.test/', 302)));   // immutable headers, sent by h3 as-is
  r.post('/login', eventHandler(async (e) => { await track(e, 'login_failed', { user: 'alice@example.com' }); setResponseStatus(e, 401); return 'no'; }));
  r.post('/signup', eventHandler((e) => { void track(e, 'signup'); return 'ok'; }));   // fire-and-forget: no waitUntil here, the flush must still land
  app.use(r);
  return app;
}
const app = (opts: CamadaNuxtOptions = {}): App => routes((a) => a.use(camada({ env: ENV, fetchImpl, ...opts })));

// One listener for the whole file; each call points it at the app under test.
let server: Server;
let base: string;
let current: App;
let finishWaiters: Array<() => void> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    res.once('finish', () => { for (const w of finishWaiters.splice(0)) w(); });   // registered first, so it fires before the middleware's own
    toNodeListener(current)(req, res);
  });
  await new Promise<void>((r) => server.listen(0, PEER, r));
  const addr = server.address();
  base = `http://${PEER}:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The ship on `finish` runs synchronously into the fake ingest; a few ticks cover the queue's own settling. */
async function drain(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
}

/** Drives one request through the listener and waits for the server side to finish and ship. */
async function call(a: App, path: string, init: RequestInit = {}): Promise<Response> {
  current = a;
  const finished = new Promise<void>((r) => finishWaiters.push(r));
  const res = await fetch(base + path, { redirect: 'manual', ...init });
  await finished;
  await drain();
  return res;
}

/** The first request is cold (fail open) and loads the snapshot. */
async function primed(opts: CamadaNuxtOptions = {}): Promise<App> {
  const a = app(opts);
  await call(a, '/');
  await call(a, '/');   // second request sees the loaded snapshot
  events.length = 0;
  return a;
}

const nonceOf = (page: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(page)![1];
const solve = (nonce: string): string => {
  for (let n = 0; ; n++) if (createHash('sha256').update(`${nonce}.${n}`).digest('hex').startsWith('0000')) return String(n);
};
const ridOf = (html: string): string => /\?r=([0-9a-f-]{36})"/.exec(html)![1];
const postBeacon = (a: App, body: string, headers: Record<string, string> = {}): Promise<Response> =>
  call(a, '/_cam/fp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
const postSolution = (a: App, body: string): Promise<Response> =>
  call(a, '/__camada/challenge', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });

/** An event the way an edge preset hands it over: a web Request, a socket, no node response. */
const stubEvent = (url: string, headers: Record<string, string> = {}): H3Event =>
  ({ context: {}, web: { request: new Request(url, { headers }) }, node: { req: { socket: { remoteAddress: '8.8.8.8' }, headers: {} } } }) as unknown as H3Event;

beforeEach(() => { events = []; sdkHeaders = []; });
afterEach(() => resetCamada());

describe('capture', () => {
  it('ships the event with the real status once the response has finished, exactly once', async () => {
    const a = await primed();
    expect((await call(a, '/')).status).toBe(200);
    expect(events.filter((e) => e.p === '/')).toHaveLength(1);
    expect(events[0]).toMatchObject({ tap: 'sdk-nuxt', p: '/', st: 200, ip: PEER });
    expect((await call(a, '/nope')).status).toBe(404);
    expect(events.filter((e) => e.p === '/nope')).toEqual([expect.objectContaining({ st: 404 })]);
  });

  it('reports its identity on every batch', async () => {
    const a = await primed();
    await call(a, '/');
    expect(sdkHeaders.length).toBeGreaterThan(0);
    expect(sdkHeaders.every((h) => h === '@camada/nuxt/0.1.0')).toBe(true);
  });

  it('ships st null at once on an event without a node response', async () => {
    const handler = camada({ env: ENV, fetchImpl });
    await handler(stubEvent('http://app.test/warm'));   // cold: loads the snapshot
    await drain();
    events.length = 0;
    expect(await handler(stubEvent('http://app.test/blind', { cookie: '_sfp=known-sid' }))).toBeUndefined();
    await drain();
    expect(events).toEqual([expect.objectContaining({ p: '/blind', st: null, ip: '8.8.8.8', sid: 'known-sid', tap: 'sdk-nuxt' })]);
    expect(await handler(stubEvent('http://app.test/', { 'x-test-peer': BLOCKED_IP }))).toBeUndefined();   // no shim here: a header is just a header
  });

  it('reads its config from process.env when the app passes none', async () => {
    Object.assign(process.env, ENV);
    try {
      const a = app({ env: undefined });
      await call(a, '/');
      await call(a, '/');
      expect((await call(a, '/', { headers: { 'x-test-peer': BLOCKED_IP } })).status).toBe(403);
    } finally { for (const k of Object.keys(ENV)) delete process.env[k]; }
  });
});

describe('enforcement', () => {
  it('blocks a listed peer with 403, x-block-reason and x-block-version', async () => {
    const a = await primed();
    const res = await call(a, '/', { headers: { 'x-test-peer': BLOCKED_IP } });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-block-reason')).toBe('ip4');
    expect(res.headers.get('x-block-version')).toBeTruthy();
    expect(events).toEqual([expect.objectContaining({ st: 403, blk: 'ip4', ip: BLOCKED_IP })]);
  });

  it('serves the challenge page, verifies the solution, and lets the cookie holder through', async () => {
    const a = await primed();
    const page = await call(a, '/admin/users', { headers: HTML });
    expect(page.status).toBe(403);
    expect(page.headers.get('x-camada-challenge')).toBe('1');
    expect(page.headers.get('content-type')).toContain('text/html');
    const nonce = nonceOf(await page.text());
    expect(events.some((e) => e.st === 403 && e.blk === 'challenge')).toBe(true);

    const ok = await postSolution(a, `nonce=${nonce}&solution=${solve(nonce)}&to=%2Fadmin%2Fusers`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/admin/users');
    expect(ok.headers.get('set-cookie')).toContain(`${CHALLENGE_COOKIE}=`);
    expect(events.some((e) => e.st === 200 && e.ch === 1)).toBe(true);

    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect((await call(a, '/admin/users', { headers: { cookie, ...HTML } })).status).toBe(200);
  });

  it('answers 403 JSON for a non-HTML challenge', async () => {
    const a = await primed();
    const res = await call(a, '/checkout', { headers: { accept: 'application/json' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'challenge_required' });
  });
});

describe('resolving the client address', () => {
  it('takes the peer from getRequestIP: the socket, or what the host stamped as clientAddress', async () => {
    const a = await primed();
    await call(a, '/');
    expect(events.at(-1)).toMatchObject({ ip: PEER });
    await call(a, '/', { headers: { 'x-test-peer': '8.8.8.8' } });
    expect(events.at(-1)).toMatchObject({ ip: '8.8.8.8' });
  });

  it('never lets a client header alone become the ip', async () => {
    const a = await primed();
    for (const h of ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip']) {
      const res = await call(a, '/', { headers: { [h]: BLOCKED_IP } });
      expect(res.status, h).toBe(200);
      expect(events.at(-1)).toMatchObject({ ip: PEER });
    }
  });

  it('honours a trusted-proxy X-Forwarded-For behind the peer', async () => {
    const a = await primed({ env: { ...ENV, CAMADA_TRUSTED_PROXY: 'hops:1' } });
    expect((await call(a, '/', { headers: { 'x-forwarded-for': BLOCKED_IP } })).status).toBe(403);
  });
});

describe('session', () => {
  it('sets the shared _sfp cookie on a first visit and never overwrites one', async () => {
    const a = await primed();
    const res = await call(a, '/');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^_sfp=[0-9a-f-]{36}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(events.at(-1)).toMatchObject({ ns: 1, sid: /_sfp=([^;]+)/.exec(cookie)![1] });
    const again = await call(a, '/', { headers: { cookie: '_sfp=known-sid' } });
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(events.at(-1)).toMatchObject({ sid: 'known-sid', ns: 0 });
  });

  it('marks the cookie Secure when h3 sees https', async () => {
    const a = await primed();
    const res = await call(a, '/', { headers: { 'x-forwarded-proto': 'https' } });   // h3's getRequestURL honours the proxy's scheme
    expect(res.headers.get('set-cookie')).toContain('; Secure');
  });

  it('survives a redirect, whether h3 sends it or the handler returns an immutable Response', async () => {
    const a = await primed();
    for (const path of ['/redirect', '/raw-redirect']) {
      const res = await call(a, path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location'), path).toBeTruthy();
      expect(res.headers.get('set-cookie'), path).toContain('_sfp=');
      expect(events.at(-1)).toMatchObject({ p: path, st: 302 });
    }
  });
});

describe('first-party beacon', () => {
  it('serves the IIFE at /_cam/b.js and ships nothing for it', async () => {
    const a = await primed();
    const res = await call(a, '/_cam/b.js?r=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await res.text()).toBe(iife);
    expect(events).toEqual([]);
  });

  it('relays /_cam/fp as a sig:1 row with the server-resolved ip and tap', async () => {
    const a = await primed();
    const res = await postBeacon(a, JSON.stringify({ rid: 'abc', tz: 'UTC', ip: '1.1.1.1', tap: 'proxy' }));
    expect(res.status).toBe(204);
    expect(events).toEqual([expect.objectContaining({ sig: 1, rid: 'abc', tz: 'UTC', ip: PEER, tap: 'sdk-nuxt' })]);
    expect(events[0].st).toBeUndefined();
  });

  it('joins the beacon to the page event on rid', async () => {
    const a = await primed();
    const rid = ridOf(await (await call(a, '/page')).text());
    expect(events.find((e) => e.p === '/page')).toMatchObject({ rid, st: 200 });
    await postBeacon(a, JSON.stringify({ rid, tz: 'UTC' }));
    expect(events.find((e) => e.sig === 1)).toMatchObject({ rid, ip: PEER });
  });

  it('still blocks a blocked client at both endpoints', async () => {
    const a = await primed();
    const script = await call(a, '/_cam/b.js', { headers: { 'x-test-peer': BLOCKED_IP } });
    expect(script.status).toBe(403);
    expect(script.headers.get('x-block-reason')).toBe('ip4');
    expect((await postBeacon(a, JSON.stringify({ rid: 'abc' }), { 'x-test-peer': BLOCKED_IP })).status).toBe(403);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.blk === 'ip4' && e.sig === undefined)).toBe(true);
  });

  it('emits no tag where the middleware did not run', async () => {
    const bare = routes(() => {});
    expect(await (await call(bare, '/page')).text()).toBe('<html><head></head><body>page</body></html>');
    const off = app({ env: { ...ENV, CAMADA_DISABLED: '1' } });
    expect(await (await call(off, '/page')).text()).toBe('<html><head></head><body>page</body></html>');
    expect(events).toEqual([]);
  });

  it('pushes the tag into the rendered head through the nitro plugin, and nothing without the middleware', async () => {
    const hooks: Record<string, (...a: unknown[]) => void> = {};
    camadaNitroPlugin()({ hooks: { hook: (name, fn) => { hooks[name] = fn; } } });
    const render = (event: H3Event) => { const html = { head: ['<meta charset="utf-8">'] }; hooks['render:html'](html, { event }); return html.head; };

    const handler = camada({ env: ENV, fetchImpl });
    const event = stubEvent('http://app.test/');
    await handler(event);
    const head = render(event);
    expect(head).toHaveLength(2);
    expect(head[1]).toMatch(/^<script src="\/_cam\/b\.js\?r=[0-9a-f-]{36}" async><\/script>$/);
    expect(render(stubEvent('http://app.test/'))).toEqual(['<meta charset="utf-8">']);
  });
});

describe('track', () => {
  it('ships an app-context event joined to the request, with the user hashed', async () => {
    const a = await primed();
    const res = await call(a, '/login', { method: 'POST', headers: { cookie: '_sfp=known-sid' } });
    expect(res.status).toBe(401);
    const row = events.find((e) => e.et === 'login_failed')!;
    expect(row).toMatchObject({ tap: 'sdk-nuxt', sid: 'known-sid', ip: PEER });
    expect(row.uid).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof row.ts).toBe('number');
    expect(row.p).toBeUndefined();
    expect(row.st).toBeUndefined();
    expect(row.rid).toBe(events.find((e) => e.p === '/login')!.rid);
    expect(events.find((e) => e.p === '/login')).toMatchObject({ st: 401 });
    expect(JSON.stringify(events)).not.toContain('alice');
  });

  it('lands a fire-and-forget call on a first visit, joined to the session just minted', async () => {
    const a = await primed();
    const res = await call(a, '/signup', { method: 'POST' });
    expect(res.status).toBe(200);
    const sid = /_sfp=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1];
    expect(events.find((e) => e.et === 'signup')).toMatchObject({ uid: null, sid, tap: 'sdk-nuxt' });
    expect(events.find((e) => e.p === '/signup')).toMatchObject({ sid, ns: 1 });
  });

  it('is a silent no-op where the middleware did not run', async () => {
    for (const a of [routes(() => {}), app({ env: { ...ENV, CAMADA_DISABLED: '1' } }), app({ env: {} })]) {
      expect((await call(a, '/login', { method: 'POST' })).status).toBe(401);
    }
    await expect(track(stubEvent('http://app.test/'), 'login_failed', { user: 'x' })).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });
});

describe('fail open', () => {
  it('is inert without a key and never touches the app', async () => {
    const a = app({ env: {} });
    const res = await call(a, '/', { headers: { 'x-test-peer': BLOCKED_IP } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(events).toEqual([]);
  });

  it('respects CAMADA_DISABLED=1', async () => {
    const a = app({ env: { ...ENV, CAMADA_DISABLED: '1' } });
    expect((await call(a, '/', { headers: { 'x-test-peer': BLOCKED_IP } })).status).toBe(200);
    expect(events).toEqual([]);
  });

  it('lets traffic through while the snapshot server is down', async () => {
    const dead: typeof fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const a = app({ fetchImpl: dead });
    expect((await call(a, '/', { headers: { 'x-test-peer': BLOCKED_IP } })).status).toBe(200);
    expect((await call(a, '/login', { method: 'POST' })).status).toBe(401);
  });
});
