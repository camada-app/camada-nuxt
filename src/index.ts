// @camada/nuxt — the two-file install for a Nuxt app (any Nitro preset with an h3 event):
//   server/middleware/camada.ts:  export default camada();   // env: CAMADA_KEY (+ CAMADA_INGEST_URL / CAMADA_SNAPSHOT_URL in dev)
//   server/plugins/camada.ts:     export default camadaNitroPlugin();   // the first-party beacon in every rendered <head>
//   track(event, 'login_failed', { user })   // an outcome the wire cannot show, from a server route
export { camada, track, scriptTag, resetCamada, type CamadaNuxtOptions, type CamadaNuxtVars } from './camada.js';
export { camadaNitroPlugin, type NitroAppLike } from './nitro.js';
