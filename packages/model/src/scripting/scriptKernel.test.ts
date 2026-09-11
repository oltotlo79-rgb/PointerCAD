import { SCRIPT_EXAMPLE_PROGRAMS } from './scriptExamples.js';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { recomputePart } from '../part/recomputePart.js';
import type { PartDocument } from '../part/types.js';
import { executeScriptVm } from './runtimeAdapter.js';
import { sha256ScriptSource } from './scriptModules.js';
import { createScriptSnapshot } from './scriptSnapshot.js';
import { prepareScriptTransaction } from './scriptTransaction.js';

let bridge: AssemblyKernelBridge, wasm: Uint8Array<ArrayBuffer>;
beforeAll(async () => {
  await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
  wasm = new Uint8Array(await readFile(new URL('../vendor/script-runtime/quickjs-pcad.wasm', import.meta.url)));
}, 180000);
async function prepare(source: string, document: PartDocument = createEmptyPartDocument(), cancel: () => boolean = () => false,
  inputs: readonly { readonly name: string; readonly source: string }[] = []) {
  const commandNamespace = 'a'.repeat(64), snapshot = createScriptSnapshot(document, 'unit-snapshot', 'mm');
  const modules = await Promise.all(inputs.map(async input => ({ ...input, sha256: await sha256ScriptSource(input.source) })));
  const vm = await executeScriptVm({ executionId: 'kernel-test', commandNamespace, program: { apiVersion: 1, source, sha256: await sha256ScriptSource(source), modules },
    snapshot: snapshot.json, seed: 123, timeMs: 1800000000000 }, wasm);
  expect(vm.ok).toBe(true); if (!vm.ok) throw new Error(vm.error.message);
  return prepareScriptTransaction({ requestId: 'kernel-test', document, commandNamespace, commands: vm.commands, references: snapshot.references,
    lengthUnit: 'mm', sources: new Map([['user-script.js', source], ...inputs.map(input => [input.name, input.source] satisfies [string, string])]), importedShapes: new Map() }, bridge, cancel);
}
function chapterExamples(name: string): string[] {
  const markdown = readFileSync(new URL(`../../../help-content/docs/ja/${name}.md`, import.meta.url), 'utf8');
  return [...markdown.matchAll(/```javascript\r?\n([\s\S]*?)\r?\n```/gu)].map(match => match[1]);
}
describe('VM→命令→一時文書→実OCCT', () => {
  it('API説明書の全コードをそのまま実行し、板と2穴の体積を独立計算で照合する', async () => {
    const examples = chapterExamples('script-api');
    expect(examples).toHaveLength(3);
    for (const [index, source] of examples.entries()) {
      const result = await prepare(source);
      if (!result.ok) throw new Error(result.error.message);
      try {
        const bodies = result.prepared.result.bodies;
        expect(bodies).toHaveLength(index === 0 ? 0 : 1);
        expect(bodies.reduce((sum, body) => sum + (body.volume ?? 0), 0)).toBeCloseTo([0, 6000, 12000 - 160 * Math.PI][index], 5);
        if (index === 0) expect(result.prepared.document.parameters[0]).toMatchObject({ name: '板厚', value: { source: '5' } });
      } finally { await result.prepared.release(); }
    }
  });
  it('道具の説明書の主処理とhelpers.jsを原文のままimportして3000mm³になる', async () => {
    const examples = chapterExamples('script-tools');
    expect(examples).toHaveLength(2);
    const result = await prepare(examples[1], createEmptyPartDocument(), () => false, [{ name: 'helpers.js', source: examples[0] }]);
    if (!result.ok) throw new Error(result.error.message);
    try { expect(result.prepared.result.bodies).toHaveLength(1); expect(result.prepared.result.bodies[0].volume).toBeCloseTo(3000, 6); }
    finally { await result.prepared.release(); }
  });
  it.each(SCRIPT_EXAMPLE_PROGRAMS)('画面に載せる例 $id を同じAPIで実行し体積と個数を照合する', async example => {
    const expected = { plate: { count: 1, volume: 12000 - 80 * Math.PI }, sketch: { count: 1, volume: 6000 },
      grid: { count: 25, volume: 12500 }, read: { count: 0, volume: 0 } }[example.id];
    const result = await prepare(example.source);
    if (!result.ok) throw new Error(result.error.message);
    try {
      expect(result.prepared.result.bodies).toHaveLength(expected.count);
      expect(result.prepared.result.bodies.reduce((total, body) => total + (body.volume ?? 0), 0)).toBeCloseTo(expected.volume, 5);
    } finally { await result.prepared.release(); }
  });

  it('4点・4線の20mm角の面を20mm押し出して8000mm³、元の文書は空のまま', async () => {
    const original = createEmptyPartDocument();
    const result = await prepare(`const s=cad.sketch.create('自動の板');
const points=[['0','0','0'],['20','0','0'],['20','20','0'],['0','20','0']].map(p=>cad.sketch.point(s,p));
const edges=points.map((p,i)=>cad.sketch.line(s,p,points[(i+1)%4]));
const face=cad.sketch.face(s,edges);cad.solid.extrude(face,'20');`, original);
    expect(result.ok).toBe(true); if (!result.ok) return;
    try { expect(result.prepared.result.errors).toEqual([]); expect(result.prepared.result.bodies[0].volume).toBeCloseTo(8000, 6);
      expect(original.solids).toEqual([]); expect(original.sketches[0].features).toEqual([]);
    } finally { await result.prepared.release(); }
  });
  it('5基本立体の独立体積が一致する', async () => {
    const result = await prepare(`cad.solid.box({x:'10',y:'20',z:'30'});
cad.solid.sphere({origin:['40','0','0'],radius:'3'});
cad.solid.cylinder({origin:['80','0','0'],radius:'3',height:'10'});
cad.solid.cone({origin:['120','0','0'],bottomRadius:'4',topRadius:'2',height:'6'});
cad.solid.torus({origin:['160','0','0'],majorRadius:'10',minorRadius:'2'});`);
    expect(result.ok).toBe(true); if (!result.ok) return;
    try { const volumes = result.prepared.result.bodies.map((body) => body.volume);
      const expected = [6000, 36*Math.PI, 90*Math.PI, 56*Math.PI, 80*Math.PI*Math.PI];
      expect(volumes).toHaveLength(expected.length);
      expected.forEach((volume,index) => { expect(volumes[index]).toBeCloseTo(volume, 5); });
    } finally { await result.prepared.release(); }
  });
  it('直径4mm深さ20mmの穴をあけ、円柱工具を消費する', async () => {
    const result = await prepare(`const b=cad.solid.box({x:'20',y:'20',z:'20'});
cad.solid.hole(b,{origin:['0','0','-10'],axis:'z',diameter:'4',depth:'20'});`);
    expect(result.ok).toBe(true); if (!result.ok) return;
    try { expect(result.prepared.result.bodies).toHaveLength(1); expect(result.prepared.result.bodies[0].volume).toBeCloseTo(8000 - 80*Math.PI, 5); }
    finally { await result.prepared.release(); }
  });
  it('立体の外の穴は失敗し、先に作れた立体も確定しない', async () => {
    const original = createEmptyPartDocument();
    const result = await prepare(`const b=cad.solid.box({x:'20',y:'20',z:'20'});
cad.solid.hole(b,{origin:['100','0','-10'],diameter:'4',depth:'20'});`, original);
    expect(result).toMatchObject({ ok: false, error: { kind: 'cad', location: { file: 'user-script.js', line: 2 } } });
    expect(original.solids).toEqual([]);
  });
  it('閉じない面はその作成行で失敗し、正常な次回処理を妨げない', async () => {
    const result = await prepare(`const s=cad.sketch.create('未閉鎖');
const p=[['0','0','0'],['10','0','0'],['10','10','0'],['0','10','0']].map(x=>cad.sketch.point(s,x));
const e=[0,1,2].map(i=>cad.sketch.line(s,p[i],p[i+1]));
cad.sketch.face(s,e);`);
    expect(result).toMatchObject({ ok: false, error: { kind: 'cad', location: { file: 'user-script.js', line: 4 } } });
    const next = await prepare("cad.solid.box({x:'2',y:'3',z:'4'});"); expect(next.ok).toBe(true);
    if (next.ok) { expect(next.prepared.result.bodies[0].volume).toBeCloseTo(24, 6); await next.prepared.release(); }
  });
  it('中止時に準備した結果を返さず、元文書を変えない', async () => {
    const original = createEmptyPartDocument(); let calls = 0;
    const result = await prepare("cad.solid.box({x:'20',y:'20',z:'20'});", original, () => ++calls > 2);
    expect(result).toMatchObject({ ok: false, error: { kind: 'cancelled' } }); expect(original.solids).toEqual([]);
  });
  it('成功後の通常所有先が保持してから一時所有先を二重解放しても出力を壊さない', async () => {
    const result = await prepare("cad.solid.box({x:'8',y:'9',z:'10'});"); expect(result.ok).toBe(true); if (!result.ok) return;
    try {
      const ordinary = await recomputePart(result.prepared.document, bridge, { partId: 'script-test-ordinary' });
      expect(ordinary.cacheHits).toBe(1); expect(ordinary.bodies[0].volume).toBeCloseTo(720, 5);
      await result.prepared.release(); await result.prepared.release();
      const again = await recomputePart(result.prepared.document, bridge, { partId: 'script-test-ordinary' });
      expect(again.cacheHits).toBe(1); expect(again.bodies[0].volume).toBeCloseTo(720, 5);
    } finally { await result.prepared.release(); await bridge.releasePart('script-test-ordinary'); }
  });
});
