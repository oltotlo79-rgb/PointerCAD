interface BundleEntry {
  readonly type: 'chunk' | 'asset';
  readonly imports?: readonly string[];
  readonly modules?: Readonly<Record<string, unknown>>;
  readonly facadeModuleId?: string | null;
  readonly isEntry?: boolean;
  readonly code?: string;
}

/** Reject a build which pulls application code back into the recovery entry. */
export function assertStartupIsolation(bundle: Readonly<Record<string, BundleEntry>>): void {
  const entry = Object.entries(bundle).find(([, value]) => value.type === 'chunk' && value.isEntry === true
    && value.facadeModuleId?.replaceAll('\\', '/').endsWith('/apps/web/index.html'));
  if (entry === undefined) throw new Error('Missing Web startup entry');
  const visited = new Set<string>();
  let bytes = 0;
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const chunk = bundle[name];
    if (chunk?.type !== 'chunk' || chunk.modules === undefined || chunk.imports === undefined || chunk.code === undefined) {
      throw new Error(`Unresolved startup dependency: ${name}`);
    }
    bytes += new TextEncoder().encode(chunk.code).byteLength;
    for (const id of Object.keys(chunk.modules)) {
      const path = id.replaceAll('\\', '/');
      if (!/\/apps\/web\/(?:index\.html|src\/(?:bootstrap|startupRecovery)\.ts)$/u.test(path)
        && !['\0vite/preload-helper.js', '\0vite/modulepreload-polyfill.js', '\0rolldown/runtime.js', 'rolldown:runtime'].includes(id)) {
        throw new Error(`Application dependency in startup recovery: ${id}`);
      }
    }
    for (const dependency of chunk.imports) visit(dependency);
  };
  visit(entry[0]);
  if (bytes > 65_536) throw new Error('Startup recovery must remain small and independent');
}
