/** Small leaf documents stay deferred while sharing one physical publication file. */
export const SMALL_HELP_TOPICS = [
  'explode', 'bom', 'standard-parts', 'appearance-glass', 'assembly-place',
  'surface-finish', 'named-view', 'drawing-note', 'text-sketch', 'dimension-arrange',
  'appearance-pattern', 'dimension-auto', 'joint', 'text-outline', 'drawing-layer', 'interference',
] as const;
const CHUNK = 'help-small-topics';

function selectedTopic(id: string): string | undefined {
  const path = id.replaceAll('\\', '/');
  const marker = '/packages/help-content/docs/ja/';
  const position = path.lastIndexOf(marker);
  if (position < 0) return undefined;
  const suffix = path.slice(position + marker.length);
  return SMALL_HELP_TOPICS.find(topic => suffix === `${topic}.md?raw`);
}

export function smallHelpChunk(id: string): string | undefined {
  return selectedTopic(id) === undefined ? undefined : CHUNK;
}

interface ChunkEntry {
  readonly type: 'asset' | 'chunk';
  readonly name?: string;
  readonly isEntry?: boolean;
  readonly facadeModuleId?: string | null;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly modules?: Readonly<Record<string, unknown>>;
}

/** Check the emitted graph: no dependency absorption or eager entry edge is allowed. */
export function assertDeferredSmallHelp(bundle: Readonly<Record<string, ChunkEntry>>): void {
  const selected = Object.entries(bundle).filter(([, chunk]) => chunk.type === 'chunk'
    && Object.keys(chunk.modules ?? {}).some(id => selectedTopic(id) !== undefined));
  if (selected.length !== 1) throw new Error('Small help documents must share one deferred chunk');
  const selectedChunk = selected[0];
  if (selectedChunk === undefined) throw new Error('Missing small help chunk');
  const [name, chunk] = selectedChunk;
  const ids = Object.keys(chunk.modules ?? {});
  // Rolldown may inline this namespace runtime or share it with the application.
  // Resolve any imported chunk by its exact module ownership, never its filename.
  const rawIds = ids.filter(id => id !== '\0rolldown/runtime.js');
  const compilerOnlyImports = chunk.imports !== undefined && chunk.imports.every(file => {
    const dependency = bundle[file];
    const modules = Object.keys(dependency?.modules ?? {});
    return dependency?.type === 'chunk' && dependency.isEntry === false
      && dependency.facadeModuleId === null
      && modules.length === 1 && modules[0] === '\0rolldown/runtime.js'
      && dependency.imports?.length === 0 && dependency.dynamicImports?.length === 0;
  });
  if (chunk.name !== CHUNK || rawIds.length !== SMALL_HELP_TOPICS.length
    || new Set(rawIds.map(selectedTopic)).size !== SMALL_HELP_TOPICS.length
    || rawIds.some(id => selectedTopic(id) === undefined) || !compilerOnlyImports
    || (chunk.dynamicImports?.length ?? 0) !== 0) {
    throw new Error('Small help chunk must contain exactly the selected raw documents and no dependencies other than the isolated compiler runtime');
  }
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (file === name) throw new Error('Small help documents became an initial static dependency');
    if (visited.has(file)) return;
    visited.add(file);
    const entry = bundle[file];
    if (entry?.type !== 'chunk' || entry.imports === undefined) throw new Error('Unresolved initial dependency');
    for (const imported of entry.imports) visit(imported);
  };
  const entries = Object.entries(bundle).filter(([, entry]) => entry.type === 'chunk'
    && (entry.isEntry === true || /\/apps\/web\/src\/main\.tsx?$/u.test(entry.facadeModuleId?.replaceAll('\\', '/') ?? '')));
  if (entries.length === 0) throw new Error('Missing initial entry');
  for (const [file] of entries) visit(file);
}
