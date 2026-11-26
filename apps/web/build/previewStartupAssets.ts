import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import type { Plugin, Rolldown } from 'vite';

type StartupChunk = Pick<Rolldown.OutputChunk, 'type' | 'facadeModuleId' | 'moduleIds' | 'imports'> & {
  viteMetadata?: { importedCss: ReadonlySet<string> };
};
type StartupOutput = StartupChunk | Pick<Rolldown.OutputAsset, 'type'>;
type StartupBundle = Readonly<Record<string, StartupOutput>>;

// These source entries run while opening a blank document. Their output names
// and transitive dependencies are determined by this build.
const EDITOR_ENTRY = '/apps/web/src/main.tsx';
const VIEWPORT_ENTRY = '/packages/ui/src/viewport/ViewportCanvas.tsx';
const KERNEL_ENTRY = '/packages/kernel/src/worker/kernel.worker.ts';
const PLAN_FILE = '.vite/preview-startup.json';
const PREVIEW_ORIGIN = 'http://pointercad-preview.invalid';

function hasSource(id: string | null | undefined, source: string): boolean {
  return id?.replaceAll('\\', '/').endsWith(source) === true;
}

function emittedEntry(bundle: StartupBundle, source: string): string {
  const chunks = Object.entries(bundle).filter(([, item]) => item.type === 'chunk');
  const match = chunks.find(([, item]) => item.type === 'chunk' && hasSource(item.facadeModuleId, source))
    ?? chunks.find(([, item]) => item.type === 'chunk' && item.moduleIds.some(id => hasSource(id, source)));
  if (match === undefined) throw new Error('Missing first-screen module: ' + source);
  return match[0];
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of tag.matchAll(/\s+([-\w]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/gu)) {
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

function htmlReference(kind: string, attrs: ReadonlyMap<string, string>): string | undefined {
  if (kind === 'script') return attrs.get('src');
  if (kind === 'img') return attrs.get('loading') === 'lazy' ? undefined : attrs.get('src');
  const rel = attrs.get('rel')?.toLowerCase().split(/\s+/u) ?? [];
  return rel.some(value => ['modulepreload', 'stylesheet', 'preload'].includes(value)) ? attrs.get('href') : undefined;
}

function htmlAssets(html: string, base: string): string[] {
  const prefix = new URL(base, PREVIEW_ORIGIN);
  const assets: string[] = [];
  for (const tag of html.matchAll(/<(script|link|img)\b[^>]*>/giu)) {
    const reference = htmlReference(tag[1].toLowerCase(), attributes(tag[0]));
    if (reference === undefined || reference === '') continue;
    const url = new URL(reference, prefix);
    if (url.origin === prefix.origin && url.pathname.startsWith(prefix.pathname)) {
      assets.push(decodeURIComponent(url.pathname.slice(prefix.pathname.length)));
    }
  }
  return assets;
}

function staticAssets(bundle: StartupBundle, roots: readonly string[]): Set<string> {
  const paths = new Set(roots);
  for (const path of paths) {
    const output = Object.hasOwn(bundle, path) ? bundle[path] : undefined;
    if (output?.type !== 'chunk') continue;
    for (const dependency of output.imports) {
      if (!Object.hasOwn(bundle, dependency)) throw new Error('Unresolved static import: ' + dependency);
      paths.add(dependency);
    }
    for (const css of output.viteMetadata?.importedCss ?? []) paths.add(css);
  }
  return paths;
}

/**
 * Select the emitted initial graph. A CSS font-face declaration can belong to a later tool.
 * An initial font preload in the emitted HTML is included with the other static references.
 */
export function previewStartupPaths(
  html: string, base: string, bundle: StartupBundle, workerBundle: StartupBundle,
): string[] {
  const htmlRoots = htmlAssets(html, base);
  if (!htmlRoots.some(path => bundle[path]?.type === 'chunk')) throw new Error('Missing built HTML entry');
  const appRoots = [emittedEntry(bundle, EDITOR_ENTRY), emittedEntry(bundle, VIEWPORT_ENTRY)];
  const paths = staticAssets(bundle, [...htmlRoots, ...appRoots]);
  for (const path of staticAssets(workerBundle, [emittedEntry(workerBundle, KERNEL_ENTRY)])) paths.add(path);
  return ['index.html', ...paths];
}

/** Carry the asset list beside the ordinary test preview build. */
export function previewStartupAssets() {
  let base = '/';
  let kernelBundle: Rolldown.OutputBundle = {};
  const web: Plugin = {
    name: 'pointercad-preview-startup-assets',
    apply: 'build',
    configResolved(config) { base = config.base; },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        try {
          const html = bundle['index.html'];
          if (html?.type !== 'asset') throw new Error('Missing built index.html');
          const source = typeof html.source === 'string' ? html.source : Buffer.from(html.source).toString('utf8');
          const paths = previewStartupPaths(source, base, bundle, kernelBundle);
          this.emitFile({ type: 'asset', fileName: PLAN_FILE, source: JSON.stringify(paths) + '\n' });
        } catch (error) {
          // Setup can continue without warmup if its optional build metadata is unavailable.
          this.warn('[preview warmup] ' + (error instanceof Error ? error.message : String(error)));
        }
      },
    },
  };
  return {
    web,
    workerPlugin(): Plugin {
      return {
        name: 'pointercad-preview-startup-worker',
        generateBundle(_options, bundle) {
          const isInitialWorker = Object.values(bundle).some(item => item.type === 'chunk' && item.isEntry
            && hasSource(item.facadeModuleId, KERNEL_ENTRY));
          if (isInitialWorker) kernelBundle = bundle;
        },
      };
    },
  };
}
