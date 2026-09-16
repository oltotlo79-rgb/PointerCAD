import { describe, expect, it } from 'vitest';
import { assembleDesktopDistribution, verifyDesktopDistribution } from '../../../../scripts/release/desktopDistribution.mjs';
import type { DesktopPackageMetadata } from '../../../../scripts/release/desktopDistribution.mjs';
import { inspectDesktopEntry } from '../../../../scripts/release/desktopEntryReferences.mjs';
import { bytes, files, fixture, hash, inputs, json } from './distributionTestFixture.js';

function desktopFixture() {
  const manual = fixture();
  const desktop = new Map<string, Uint8Array>([
    ['main/main.cjs', bytes("require('electron');require('node:path');")],
    ['preload/preload.cjs', bytes("require('electron');")],
    ...['renderer/index.html', 'renderer/fonts/LICENSES.txt', 'renderer/licenses/math-notices.json',
      'renderer/licenses/runtime/runtime-notices.json', 'renderer/LICENSE', 'renderer/NOTICE',
      'renderer/licenses/exact-math/manifest.json', 'renderer/exact-math/runtime/pyodide.asm.wasm',
      'renderer/assets/opencascade.full-example.wasm', 'renderer/assets/quickjs-pcad-example.wasm']
      .map(name => [name, bytes(name)] as const),
  ]);
  const build = { format: 'pointercad-desktop-build/1', inputs: { ...inputs },
    outputs: Object.fromEntries([...desktop].map(([name, value]) => [name, hash(value)])) };
  const seal = () => desktop.set('desktop-build.json', json(build)); seal();
  const metadata: DesktopPackageMetadata = { version: '0.0.0', sourceCommit: 'a'.repeat(40), platform: 'win32',
    arch: 'x64', electronVersion: '44.1.0', builderVersion: '26.15.3' };
  const notices = new Map([['LICENSE', bytes('Apache original')], ['NOTICE', bytes('Attribution')]]);
  const assemble = () => assembleDesktopDistribution(files(desktop), files(manual.manual), files(manual.pdf), notices, metadata);
  return { manual, desktop, build, seal, metadata, notices, assemble };
}

describe('配布用の本体・全説明書を、開発用の置き場から独立して揃える', () => {
  it.each(['win32', 'linux'] as const)('%sの一式に全巻と計算部・許諾を含み、梱包後の全内容を照合できる', platform => {
    const f = desktopFixture(), result = assembleDesktopDistribution(files(f.desktop), files(f.manual.manual), files(f.manual.pdf),
      f.notices, { ...f.metadata, platform });
    expect(result.files.get('dist/renderer/manual/pdf/second.pdf')).toEqual(f.manual.pdf.get('second.pdf'));
    expect(result.manifest.pdfVolumes).toBe(2);
    expect(result.manifest.signed).toBe(false);
    expect(result.manifest.releaseCertified).toBe(false);
    expect(result.files.has('dist/desktop-build.json')).toBe(false);
    const manifest = result.files.get('desktop-package.json');
    if (manifest === undefined) throw new Error('Missing test inventory');
    expect(verifyDesktopDistribution(files(result.files), manifest).files).toBe(result.files.size);
  });
  it.each(['preload/preload.cjs', 'renderer/exact-math/runtime/pyodide.asm.wasm', 'renderer/assets/opencascade.full-example.wasm'])('%sの欠落を見逃さない', name => {
    const f = desktopFixture(); f.desktop.delete(name); delete f.build.outputs[name]; f.seal();
    expect(f.assemble).toThrow();
  });
  it('同じ名前への差し替え、余分な開発ファイル、古い説明書を拒否する', () => {
    const f = desktopFixture(); f.desktop.set('renderer/index.html', bytes('changed')); expect(f.assemble).toThrow('Desktop build changed');
    const g = desktopFixture(); g.desktop.set('debug.log', bytes('debug')); expect(g.assemble).toThrow();
    const h = desktopFixture(); h.build.inputs['packages/ui/src/example.ts'] = hash('new source'); h.seal();
    expect(h.assemble).toThrow('Manual and desktop source editions differ');
  });
  it('1巻の欠落と許諾本文の不足を拒否する', () => {
    const f = desktopFixture(); f.manual.pdf.delete('second.pdf'); expect(f.assemble).toThrow();
    const g = desktopFixture(); g.notices.delete('NOTICE'); expect(g.assemble).toThrow('Missing application notice');
  });
  it('梱包時に欠落・置換・追加されたファイルを拒否する', () => {
    const result = desktopFixture().assemble(), manifest = result.files.get('desktop-package.json');
    if (manifest === undefined) throw new Error('Missing test inventory');
    for (const operation of ['missing', 'changed', 'extra'] as const) {
      const packaged = new Map(result.files);
      if (operation === 'missing') packaged.delete('dist/preload/preload.cjs');
      else if (operation === 'changed') packaged.set('dist/preload/preload.cjs', bytes('changed'));
      else packaged.set('debug.log', bytes('extra'));
      expect(() => verifyDesktopDistribution(files(packaged), manifest)).toThrow();
    }
  });
  it('梱包側の整形だけは認め、起動先や版・依存の追加は拒否する', () => {
    const result = desktopFixture().assemble(), manifest = result.files.get('desktop-package.json');
    if (manifest === undefined) throw new Error('Missing test inventory');
    const reformatted = new Map(result.files); reformatted.set('package.json', json(result.manifest.application));
    expect(() => verifyDesktopDistribution(files(reformatted), manifest)).not.toThrow();
    for (const change of [{ main: './outside.cjs' }, { version: '9.9.9' }, { dependencies: { external: '1.0.0' } }]) {
      const changed = new Map(result.files); changed.set('package.json', json({ ...result.manifest.application, ...change }));
      expect(() => verifyDesktopDistribution(files(changed), manifest)).toThrow('metadata changed');
    }
  });
});

describe('配布する本体から開発PCの依存を読み込まない', () => {
  it('Electronと使っているNode標準機能だけを許す', () => {
    expect(inspectDesktopEntry('main/main.cjs', bytes("require('electron');require('node:fs');"))).toEqual(['electron', 'node:fs']);
  });
  it.each(["require('unbundled');", 'require(name);', "import('unbundled');", "import(name);", "import x from 'unbundled';",
    "export {x} from 'unbundled';", "require('electron', 'extra');", 'function ('])('未同梱・動的・壊れた参照 %s を拒否する', source => {
    expect(() => inspectDesktopEntry('main/main.cjs', bytes("require('electron');" + source))).toThrow();
  });
  it('隔離した読み込み口へ不要なNode機能を足せない', () => {
    expect(() => inspectDesktopEntry('preload/preload.cjs', bytes("require('electron');require('node:fs');"))).toThrow();
  });
});
