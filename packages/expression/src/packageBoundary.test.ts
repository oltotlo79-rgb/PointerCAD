import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root=fileURLToPath(new URL('../../../',import.meta.url)),resolve=createRequire(import.meta.url).resolve;
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
  const mathEntries = ['contracts', 'client', 'worker', 'geometry'];
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'packages/expression/package.json'), 'utf8'));
  if (manifest === null || typeof manifest !== 'object' || !('exports' in manifest)
    || manifest.exports === null || typeof manifest.exports !== 'object') throw new Error('Missing expression package exports');
  const publicMathEntries = Object.keys(manifest.exports)
    .filter(name => name.startsWith('./math/')).sort();
  expect(publicMathEntries).toEqual(mathEntries.map(name => `./math/${name}`).sort());
  expect([...imports.keys()].filter(name => name.startsWith('@pointercad/expression/math/')).sort())
    .toEqual(mathEntries.map(name => `@pointercad/expression/math/${name}`).sort());
  for(const [specifier,owners] of imports){
    let target:string|undefined;try{target=resolve(specifier);}catch{/* Show the actual consumers in the assertion. */}
    expect(target,`${specifier}\n${owners.join('\n')}`).toBeDefined();
    expect(target!==undefined && existsSync(target),specifier).toBe(true);
    expect(target!==undefined && dirname(target).startsWith(join(root,'packages','expression','src')),specifier).toBe(true);
  }
});
