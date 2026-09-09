// The Nitro side of the beacon: Nuxt renders `<head>` through the `render:html` hook, so the
// tag goes in there rather than in every page. Typed structurally so this package never
// depends on nitropack — the plugin file is `export default camadaNitroPlugin()`.
import type { H3Event } from 'h3';
import { scriptTag } from './camada.js';

export interface NitroAppLike { hooks: { hook(name: string, fn: (...a: any[]) => void): void } }
interface RenderHtml { head: string[] }

/** `server/plugins/camada.ts`: pushes this request's beacon tag into the rendered `<head>`; nothing where the middleware did not run. */
export function camadaNitroPlugin(): (nitroApp: NitroAppLike) => void {
  return (nitroApp) => {
    nitroApp.hooks.hook('render:html', (html: RenderHtml, { event }: { event: H3Event }) => {
      const tag = scriptTag(event);
      if (tag) html.head.push(tag);
    });
  };
}
