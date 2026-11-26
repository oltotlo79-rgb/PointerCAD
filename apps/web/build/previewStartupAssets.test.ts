import { describe, expect, it } from 'vitest';
import { previewStartupPaths } from './previewStartupAssets.js';

const EDITOR = '/copy/apps/web/src/main.tsx';
const VIEWPORT = 'C:\\copy\\packages\\ui\\src\\viewport\\ViewportCanvas.tsx';
const KERNEL = '/copy/packages/kernel/src/worker/kernel.worker.ts';
const asset = { type: 'asset' as const };

function chunk(facadeModuleId: string | null, imports: string[] = [], css: string[] = []) {
  return { type: 'chunk' as const, facadeModuleId, moduleIds: [],
    imports, viteMetadata: { importedCss: new Set(css) } };
}

const html = [
  '<script type="module" src="/cad/files/guard-A.js"></script>',
  '<script crossorigin src="./files/shell-B.js" type="module"></script>',
  '<link href="/cad/files/common.css" rel="stylesheet">',
  '<link as="font" rel="preload" href="/cad/fonts/visible%20font.woff2">',
  '<link rel="modulepreload" href="./files/shared-C.js">',
  '<link rel="prefetch" href="./files/later-D.js">',
  '<img loading="lazy" src="./files/later.png">',
  '<img src="https://somewhere.invalid/logo.png">',
].join('\n');

function fixture() {
  return {
    'files/guard-A.js': chunk('/copy/guard.ts'),
    'files/shell-B.js': chunk('/copy/index.html', ['files/shared-C.js']),
    'files/shared-C.js': chunk(null, ['files/shell-B.js']),
    'files/second-entry.js': {
      ...chunk(EDITOR, ['files/shared-C.js'], ['files/editor.css']),
      dynamicImports: ['files/later-D.js'],
      viteMetadata: { importedCss: new Set(['files/editor.css']), importedAssets: new Set(['files/later.woff2']) },
    },
    'files/third-entry.js': { ...chunk(null, ['files/controls.js']), moduleIds: [VIEWPORT] },
    'files/controls.js': chunk(null, [], ['files/controls.css']),
    'files/controls.css': asset,
    'files/later.woff2': asset,
    'files/later-D.js': chunk('/copy/advanced-tool.ts', [], ['files/later.css']),
  };
}

const worker = {
  'files/worker-X.js': { ...chunk(KERNEL, ['files/worker-dep.js']), dynamicImports: ['files/solver.js'] },
  'files/worker-dep.js': chunk(null),
  'files/solver.js': chunk('/copy/solver.js'),
};

describe('Ordinary preview first-screen assets', () => {
  it('takes deployed HTML, CSS, eager font and transitive startup imports without following later features', () => {
    expect(previewStartupPaths(html, '/cad/', fixture(), worker)).toEqual([
      'index.html', 'files/guard-A.js', 'files/shell-B.js', 'files/common.css',
      'fonts/visible font.woff2', 'files/shared-C.js', 'files/second-entry.js',
      'files/third-entry.js', 'files/editor.css', 'files/controls.js', 'files/controls.css',
      'files/worker-X.js', 'files/worker-dep.js',
    ]);
  });

  it('rejects an incomplete plan before setup can use it', () => {
    expect(() => previewStartupPaths('<html></html>', '/cad/', fixture(), worker)).toThrow('Missing built HTML entry');
    expect(() => previewStartupPaths(html, '/cad/', fixture(), {})).toThrow('Missing first-screen module');
    const missing = { ...fixture(), 'files/controls.js': chunk(null, ['files/missing.js']) };
    expect(() => previewStartupPaths(html, '/cad/', missing, worker)).toThrow('Unresolved static import');
  });
});
