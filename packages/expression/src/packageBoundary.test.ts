import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { isRecord } from './math/mathRecord.js';

const root=fileURLToPath(new URL('../../../',import.meta.url)),resolve=createRequire(import.meta.url).resolve;
const assetPrefix = '@pointercad/expression/math/exact-runtime/';
const assetOwner = 'packages/ui/src/math/localExactMathEngine.ts';
const mathEntries = { contracts: 'publicContracts', client: 'publicClient', worker: 'publicWorker', geometry: 'publicGeometry' };
const testingEntries = { geometry: 'geometry', 'exact-runtime': 'exactRuntime' };
/** The product's shipped Python inventory is independent of the package export table under inspection. */
function runtimeAssets(): string[] {
  const source = readFileSync(join(root, assetOwner), 'utf8');
  const shipped = [...source.matchAll(/\['(cas_\w+\.py)',\s*\w+\]/gu)].map(match => match[1]);
  const imported = [...source.matchAll(/^import \w+ from '@pointercad\/expression\/math\/exact-runtime\/(cas_\w+\.py)\?raw';$/gmu)]
    .map(match => match[1]);
  expect(shipped).toHaveLength(45); expect(new Set(shipped).size).toBe(45);
  expect(imported.sort()).toEqual([...shipped].sort());
  return shipped;
}
function consumerBase(specifier: string, owner: string, assets: readonly string[]): string {
  const source = relative(root, owner).replaceAll('\\', '/');
  const base = specifier.endsWith('?raw') ? specifier.slice(0, -4) : specifier;
  if (base.startsWith(assetPrefix)) {
    if (!assets.includes(base.slice(assetPrefix.length)) || specifier !== base + '?raw' || source !== assetOwner) {
      throw new Error('Only the actual Python asset consumer may request the exact raw asset');
    }
    return base;
  }
  if (/[?#]/u.test(specifier)) throw new Error('Unsupported expression import query');
  if (specifier.startsWith('@pointercad/expression/testing/')) {
    const name = specifier.slice('@pointercad/expression/testing/'.length);
    if (!Object.hasOwn(testingEntries, name) || !/\.(?:test|testSupport|spec)\.[cm]?tsx?$/u.test(source)) {
      throw new Error('Expression testing entry is not a product import');
    }
  }
  return specifier;
}
it('他パッケージが使うexpressionの公開入口はすべて解決できる',()=>{
  const pending:string[]=[],imports=new Map<string,string[]>();
  for(const group of ['packages','apps']) for(const entry of readdirSync(join(root,group),{withFileTypes:true})){
    const path=join(root,group,entry.name,'src');if(entry.isDirectory() && existsSync(path)) pending.push(path);
  }
  while(pending.length>0){
    const folder=pending.pop();if(folder===undefined) break;
    for(const entry of readdirSync(folder,{withFileTypes:true})){
      const path=join(folder,entry.name);if(entry.isDirectory()){pending.push(path);continue;}
      if(!/\.[cm]?tsx?$/.test(entry.name)) continue;
      const source=readFileSync(path,'utf8');
      for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](@pointercad\/expression\/[^'"]+)['"]/g)){
        const owners=imports.get(match[1])??[];owners.push(path);imports.set(match[1],owners);
      }
    }
  }
  const assets = runtimeAssets();
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'packages/expression/package.json'), 'utf8'));
  if (!isRecord(manifest) || !isRecord(manifest.exports)) throw new Error('Missing expression package exports');
  const exports = manifest.exports;
  expect(Object.keys(exports).filter(name => name.startsWith('./math/') && !name.startsWith('./math/exact-runtime/')).sort())
    .toEqual(Object.keys(mathEntries).map(name => `./math/${name}`).sort());
  expect(Object.keys(exports).filter(name => name.startsWith('./math/exact-runtime/')).sort())
    .toEqual(assets.map(name => './math/exact-runtime/' + name).sort());
  expect(Object.keys(exports).filter(name => name.startsWith('./testing/')).sort())
    .toEqual(Object.keys(testingEntries).map(name => './testing/' + name).sort());
  for (const [name, target] of Object.entries(mathEntries)) {
    expect(exports['./math/' + name]).toEqual({ types: './dist/math/' + target + '.d.ts', default: './src/math/' + target + '.ts' });
  }
  for (const [name, target] of Object.entries(testingEntries)) {
    expect(exports['./testing/' + name]).toEqual({ types: './dist/testing/' + target + '.testSupport.d.ts', default: './src/testing/' + target + '.testSupport.ts' });
  }
  for (const name of assets) expect(exports['./math/exact-runtime/' + name]).toBe('./src/math/exactRuntime/' + name);
  expect([...imports.keys()].filter(name => name.startsWith('@pointercad/expression/math/') && !name.startsWith(assetPrefix)).sort())
    .toEqual(Object.keys(mathEntries).map(name => `@pointercad/expression/math/${name}`).sort());
  for(const [specifier,owners] of imports){
    const bases = owners.map(owner => consumerBase(specifier, owner, assets));
    expect(new Set(bases).size, specifier).toBe(1);
    const base = bases[0]; if (base === undefined) throw new Error('Missing expression import consumer');
    let target:string|undefined;try{target=resolve(base);}catch{/* Show the actual consumers in the assertion. */}
    expect(target,`${specifier}\n${owners.join('\n')}`).toBeDefined();
    expect(target!==undefined && existsSync(target),specifier).toBe(true);
    expect(target!==undefined && dirname(target).startsWith(join(root,'packages','expression','src')),specifier).toBe(true);
  }
});

it('raw queryは配布資産と実consumerだけに限定し、任意queryを許さない', () => {
  const owner = join(root, assetOwner), asset = assetPrefix + 'cas_input.py';
  expect(consumerBase(asset + '?raw', owner, ['cas_input.py'])).toBe(asset);
  for (const invalid of [asset, asset + '?url', asset + '?raw&other=1', asset + '#raw', assetPrefix + 'cas_missing.py?raw',
    '@pointercad/expression/math/client?raw']) expect(() => consumerBase(invalid, owner, ['cas_input.py'])).toThrow();
  expect(() => consumerBase(asset + '?raw', join(root, 'packages/ui/src/store/other.ts'), ['cas_input.py'])).toThrow();
});

it('公開testing入口を明示した検査consumerだけに許し製品への逆流を拒否する', () => {
  for (const name of Object.keys(testingEntries)) {
    const specifier = '@pointercad/expression/testing/' + name;
    expect(consumerBase(specifier, join(root, 'packages/model/src/part/example.test.ts'), [])).toBe(specifier);
    expect(consumerBase(specifier, join(root, 'packages/fem/src/example.testSupport.ts'), [])).toBe(specifier);
    expect(() => consumerBase(specifier, join(root, 'packages/ui/src/store/runtime.ts'), [])).toThrow('not a product');
  }
  expect(() => consumerBase('@pointercad/expression/testing/unpublished', join(root, 'packages/model/src/example.test.ts'), []))
    .toThrow('not a product');
});
