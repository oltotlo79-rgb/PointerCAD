import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertDeferredSmallHelp, smallHelpChunk } from './helpChunkPolicy.js';

// Independent current publication shape: sixteen separate raw documents cost fifteen extra files.
const topics = ['explode', 'bom', 'standard-parts', 'appearance-glass', 'assembly-place',
  'surface-finish', 'named-view', 'drawing-note', 'text-sketch', 'dimension-arrange',
  'appearance-pattern', 'dimension-auto', 'joint', 'text-outline', 'drawing-layer', 'interference'];
const moduleId = (topic: string) => `C:/repo/packages/help-content/docs/ja/${topic}.md?raw`;
function fixture() {
  return {
    'index.js': { type: 'chunk' as const, isEntry: true, imports: [] as string[], modules: { '/apps/web/src/bootstrap.ts': {} } },
    'main.js': { type: 'chunk' as const, isEntry: true, imports: [] as string[], modules: { '/apps/web/src/main.ts': {} } },
    'help.js': { type: 'chunk' as const, name: 'help-small-topics', imports: [] as string[],
      modules: Object.fromEntries(topics.map(topic => [moduleId(topic), {}])) },
  };
}

describe('Deferred help packaging preserves the complete edition within the existing file limit', () => {
  it('groups sixteen existing raw documents without selecting UI, Workers, eager or other raw imports', () => {
    expect(topics).toHaveLength(16);
    for (const topic of topics) {
      expect(readFileSync(new URL(`../../../packages/help-content/docs/ja/${topic}.md`, import.meta.url), 'utf8').length).toBeGreaterThan(0);
      expect(smallHelpChunk(moduleId(topic))).toBe('help-small-topics');
      expect(smallHelpChunk(moduleId(topic).replaceAll('/', '\\'))).toBe('help-small-topics');
    }
    for (const id of ['/packages/ui/src/help/HelpHost.tsx', '/packages/kernel/src/kernel.worker.ts',
      '/packages/help-content/docs/ja/bom.md', '/packages/help-content/docs/ja/bom.md?url',
      '/packages/help-content/docs/ja/bom.md?raw&import', '/packages/help-content/docs/ja/bom.md?rawx',
      '/packages/help-content/docs/ja/images/bom.png?url', '/packages/help-content/docs/ja/assembly.md?raw',
      '/packages/help-content/docs/ja/nested/bom.md?raw']) expect(smallHelpChunk(id)).toBeUndefined();
    expect(() => assertDeferredSmallHelp(fixture())).not.toThrow();
  });
  it('rejects the actual old separate-document shape and preserves all source documents', () => {
    const old = Object.fromEntries(topics.map(topic => [`${topic}.js`, {
      type: 'chunk' as const, name: topic, imports: [], modules: { [moduleId(topic)]: {} },
    }]));
    expect(() => assertDeferredSmallHelp({ ...old, 'index.js': fixture()['index.js'] })).toThrow('one deferred chunk');
    const currentPhysicalFiles = 644 + 357 + 9 + 1;
    expect(currentPhysicalFiles).toBe(1011);
    expect(currentPhysicalFiles - (Object.keys(old).length - 1)).toBe(996);
    expect(Object.keys(fixture()['help.js'].modules)).toHaveLength(16);
  });
  it('rejects missing, extra, UI/Worker or transitive dependencies in the combined data chunk', () => {
    const missing = fixture(); delete missing['help.js'].modules[moduleId('bom')];
    expect(() => assertDeferredSmallHelp(missing)).toThrow('exactly');
    for (const id of ['/packages/ui/src/help/HelpHost.tsx', '/packages/kernel/src/kernel.worker.ts',
      '/packages/help-content/docs/ja/assembly.md?raw']) {
      const added = fixture(); added['help.js'].modules[id] = {};
      expect(() => assertDeferredSmallHelp(added)).toThrow('exactly');
    }
    const dependency = fixture(); dependency['help.js'].imports.push('main.js');
    expect(() => assertDeferredSmallHelp(dependency)).toThrow('no dependencies');
  });
  it('allows only the exact observed compiler namespace runtime while retaining data purity and zero imports', () => {
    const compiler = fixture(); compiler['help.js'].modules['\0rolldown/runtime.js'] = {};
    expect(() => assertDeferredSmallHelp(compiler)).not.toThrow();
    for (const id of ['\0rolldown/runtime.js?extra', '\0rolldown/fake-runtime.js',
      '\0vite/preload-helper.js', '/packages/ui/src/help/HelpHost.tsx',
      '/packages/kernel/src/kernel.worker.ts']) {
      const invalid = fixture(); invalid['help.js'].modules['\0rolldown/runtime.js'] = {};
      invalid['help.js'].modules[id] = {};
      expect(() => assertDeferredSmallHelp(invalid)).toThrow('exactly');
    }
    const missing = fixture(); missing['help.js'].modules['\0rolldown/runtime.js'] = {};
    delete missing['help.js'].modules[moduleId('bom')];
    expect(() => assertDeferredSmallHelp(missing)).toThrow('exactly');
    const imported = fixture(); imported['help.js'].modules['\0rolldown/runtime.js'] = {};
    imported['help.js'].imports.push('main.js');
    expect(() => assertDeferredSmallHelp(imported)).toThrow('no dependencies');
    const eager = fixture(); eager['help.js'].modules['\0rolldown/runtime.js'] = {};
    eager['main.js'].imports.push('help.js');
    expect(() => assertDeferredSmallHelp(eager)).toThrow('initial static dependency');
  });
  it('rejects a direct or indirect initial static import while allowing deferred chunks', () => {
    const direct = fixture(); direct['main.js'].imports.push('help.js');
    expect(() => assertDeferredSmallHelp(direct)).toThrow('initial static dependency');
    const indirect = fixture(); indirect['index.js'].imports.push('main.js'); indirect['main.js'].imports.push('help.js');
    expect(() => assertDeferredSmallHelp(indirect)).toThrow('initial static dependency');
    const application = { ...fixture(), 'main.js': { ...fixture()['main.js'], isEntry: false,
      facadeModuleId: 'C:/repo/apps/web/src/main.ts', imports: ['help.js'] } };
    expect(() => assertDeferredSmallHelp(application)).toThrow('initial static dependency');
  });
});

// Reduced from the actual whole-application graph: both initial application
// chunks and deferred raw documents import one compiler-only leaf. Sharing a
// dependency does not make the document chunk an initial dependency.
function sharedRuntimeFixture(runtimeFile = 'assets/rolldown-runtime-hePW80VL.js') {
  const bundle = fixture();
  bundle['index.js'].imports.push('main.js');
  bundle['main.js'].imports.push(runtimeFile);
  bundle['help.js'].imports.push(runtimeFile);
  const runtime = {
    type: 'chunk' as const, isEntry: false, facadeModuleId: null,
    imports: [] as string[], dynamicImports: [] as string[],
    modules: { ['\0rolldown/runtime.js']: {} } as Record<string, unknown>,
  };
  return { bundle, runtime, emitted: { ...bundle, [runtimeFile]: runtime } };
}

describe('Whole-application shared compiler runtime preserves deferred help', () => {
  it('accepts the observed shared-runtime graph independently of its hashed filename', () => {
    for (const file of ['assets/rolldown-runtime-hePW80VL.js', 'assets/renamed-compiler.js']) {
      const { emitted } = sharedRuntimeFixture(file);
      expect(() => assertDeferredSmallHelp(emitted)).not.toThrow();
    }
  });
  it('rejects unresolved imports, filename impostors, extra modules and non-leaf runtimes', () => {
    const missing = sharedRuntimeFixture();
    expect(() => assertDeferredSmallHelp(missing.bundle)).toThrow('no dependencies');
    for (const id of ['\0rolldown/runtime.js?extra', '/packages/ui/src/help/HelpHost.tsx']) {
      const replaced = sharedRuntimeFixture();
      delete replaced.runtime.modules['\0rolldown/runtime.js'];
      replaced.runtime.modules[id] = {};
      expect(() => assertDeferredSmallHelp(replaced.emitted)).toThrow('no dependencies');
      const absorbed = sharedRuntimeFixture();
      absorbed.runtime.modules[id] = {};
      expect(() => assertDeferredSmallHelp(absorbed.emitted)).toThrow('no dependencies');
    }
    for (const edge of ['imports', 'dynamicImports'] as const) {
      const nonLeaf = sharedRuntimeFixture();
      nonLeaf.runtime[edge].push('main.js');
      expect(() => assertDeferredSmallHelp(nonLeaf.emitted)).toThrow('no dependencies');
    }
    const entry = sharedRuntimeFixture(); entry.runtime.isEntry = true;
    expect(() => assertDeferredSmallHelp(entry.emitted)).toThrow('no dependencies');
    const incomplete = sharedRuntimeFixture();
    const { dynamicImports: omitted, ...unknownEdges } = incomplete.runtime;
    expect(omitted).toEqual([]);
    expect(() => assertDeferredSmallHelp({ ...incomplete.emitted,
      'assets/rolldown-runtime-hePW80VL.js': unknownEdges })).toThrow('no dependencies');
  });
  it('still rejects missing or extra documents and dynamic application dependencies', () => {
    const missing = sharedRuntimeFixture(); delete missing.bundle['help.js'].modules[moduleId('bom')];
    expect(() => assertDeferredSmallHelp(missing.emitted)).toThrow('exactly');
    const extra = sharedRuntimeFixture(); extra.bundle['help.js'].modules[moduleId('assembly')] = {};
    expect(() => assertDeferredSmallHelp(extra.emitted)).toThrow('exactly');
    const dynamic = sharedRuntimeFixture();
    expect(() => assertDeferredSmallHelp({ ...dynamic.emitted,
      'help.js': { ...dynamic.bundle['help.js'], dynamicImports: ['main.js'] } })).toThrow('no dependencies');
  });
  it('still rejects direct, transitive and application-facade eager help paths', () => {
    const direct = sharedRuntimeFixture(); direct.bundle['index.js'].imports.push('help.js');
    expect(() => assertDeferredSmallHelp(direct.emitted)).toThrow('initial static dependency');
    const indirect = sharedRuntimeFixture(); indirect.bundle['main.js'].imports.push('help.js');
    expect(() => assertDeferredSmallHelp(indirect.emitted)).toThrow('initial static dependency');
    const facade = sharedRuntimeFixture();
    expect(() => assertDeferredSmallHelp({ ...facade.emitted,
      'late-main.js': { type: 'chunk', isEntry: false, facadeModuleId: 'C:/repo/apps/web/src/main.ts',
        imports: ['help.js'], modules: {} } })).toThrow('initial static dependency');
  });
});
