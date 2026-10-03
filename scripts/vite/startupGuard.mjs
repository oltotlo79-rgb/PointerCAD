/**
 * Build the import-free startup guard (packages/ui/src/shell/startupGuard.ts) as its own chunk and
 * place it just before the startup entry of the Web and desktop pages. The guard must be a separate
 * same-origin file: the content security policy (`script-src 'self'`) forbids inline scripts.
 */
import { fileURLToPath, URL } from 'node:url';
import { TextEncoder } from 'node:util';

const GUARD_ENTRY = fileURLToPath(new URL('../../packages/ui/src/shell/startupGuardEntry.ts', import.meta.url));
const GUARD_NAME = 'startup-guard';
const GUARD_LIMIT_BYTES = 8_192;
const normalize = (path) => path.replaceAll('\\', '/');

/** The guard chunk is an entry of its own, statically requires nothing, and stays small. */
export function findStartupGuardChunk(bundle) {
  const guards = Object.values(bundle).filter(item => item.type === 'chunk' && item.isEntry === true
    && typeof item.facadeModuleId === 'string' && normalize(item.facadeModuleId).endsWith('/packages/ui/src/shell/startupGuardEntry.ts'));
  if (guards.length !== 1) throw new Error('Missing startup guard chunk');
  const guard = guards[0];
  if (guard.imports.length > 0 || (guard.dynamicImports ?? []).length > 0) throw new Error('Startup guard must not load other files');
  if (new TextEncoder().encode(guard.code).byteLength > GUARD_LIMIT_BYTES) throw new Error('Startup guard must remain small');
  return guard;
}

/** Insert the guard right before the first module script (the startup entry), after any policy meta. */
export function insertStartupGuard(html, source) {
  const entry = html.indexOf('<script type="module"');
  if (entry < 0) throw new Error('Missing startup entry script');
  if (html.indexOf('<script type="module"', entry + 1) >= 0) throw new Error('Unexpected second module script');
  const escaped = source.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `${html.slice(0, entry)}<script type="module" crossorigin src="${escaped}" data-startup-guard></script>\n    ${html.slice(entry)}`;
}

export function startupGuard() {
  let base = '/';
  return {
    name: 'pointercad-startup-guard',
    apply: 'build',
    configResolved(config) { base = config.base; },
    buildStart() {
      this.emitFile({ type: 'chunk', id: GUARD_ENTRY, name: GUARD_NAME });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (context.bundle === undefined) throw new Error('Missing startup guard bundle');
        return insertStartupGuard(html, `${base}${findStartupGuardChunk(context.bundle).fileName}`);
      },
    },
  };
}
