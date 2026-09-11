import { readFile } from 'node:fs/promises';
import { createKernelApi } from '@pointercad/kernel';
import { expectWithinBudget } from '@pointercad/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { executeScriptVm } from './runtimeAdapter.js';
import { sha256ScriptSource } from './scriptModules.js';
import { createScriptSnapshot } from './scriptSnapshot.js';
import { prepareScriptTransaction } from './scriptTransaction.js';

const api = createKernelApi(loadOcctForNode), bridge = createDirectKernelBridge(api);
let wasm: Uint8Array<ArrayBuffer>;
const timings: { count: number; javascriptMs: number; initializationMs: number; cadMs: number }[] = [];
beforeAll(async () => {
  await loadOcctForNode();
  wasm = new Uint8Array(await readFile(new URL('../vendor/script-runtime/quickjs-pcad.wasm', import.meta.url)));
  // Cold geometry runs are measured inside bounded setup so CI reaches the actual budget assertion.
  for (const count of [1, 100, 200]) {
    const source = `for(let i=0;i<${count};i++)cad.solid.box({origin:[String(i*20),'0','${count}'],x:'10',y:'8',z:'6'});`;
    const result = await run(source, `count-${count}`);
    expect(result.bodyCount).toBe(count); expect(result.volumes.every(volume => Math.abs(volume - 480) < 1e-7)).toBe(true);
    expect(result.cacheHits).toBe(0);
    timings.push({ count, initializationMs: result.initializationMs, javascriptMs: result.javascriptMs, cadMs: result.cadMs });
  }
}, 180000);
async function run(source: string, requestId: string) {
  const document = createEmptyPartDocument(), snapshot = createScriptSnapshot(document, 'performance', 'mm'), commandNamespace = 'a'.repeat(64);
  const vm = await executeScriptVm({ executionId: requestId, commandNamespace, program: { apiVersion: 1, source, sha256: await sha256ScriptSource(source), modules: [] },
    snapshot: snapshot.json, seed: 1, timeMs: 0 }, wasm);
  expect(vm.ok).toBe(true); if (!vm.ok) throw new Error(vm.error.message);
  const start = performance.now();
  const prepared = await prepareScriptTransaction({ requestId, document, commandNamespace, commands: vm.commands,
    references: snapshot.references, lengthUnit: 'mm', sources: new Map([['user-script.js', source]]), importedShapes: new Map() }, bridge, () => false);
  const cadMs = performance.now() - start;
  expect(prepared.ok).toBe(true); if (!prepared.ok) throw new Error(prepared.error.message);
  try {
    expect(prepared.prepared.result.errors).toEqual([]);
    return { cadMs, initializationMs: vm.initializationMs, javascriptMs: vm.javascriptMs, cacheHits: prepared.prepared.result.cacheHits,
      bodyCount: prepared.prepared.result.bodies.length, volumes: prepared.prepared.result.bodies.map(body => body.volume) };
  } finally { await prepared.prepared.release(); }
}
describe.sequential('自動作図の規模と一時所有先', () => {
  it('実VM・命令変換・実OCCTの1段500ms/100段5秒と200段を記録する', () => {
    for (const timing of timings) {
      process.stdout.write(`[実測] 自動作図 ${JSON.stringify(timing)}\n`);
      expectWithinBudget(timing.javascriptMs, 5000, `自動作図${timing.count}件のJavaScript`);
      expectWithinBudget(timing.cadMs, timing.count === 1 ? 500 : timing.count === 100 ? 5000 : 30000, `自動作図${timing.count}件のCAD`);
    }
  });
  it('異なる入力を50回実行・解放して一時保護0、通常LRU容量256以内に戻る', async () => {
    for (let index = 0; index < 50; index++) {
      const result = await run(`cad.solid.box({x:'${index+1}',y:'2',z:'3'});`, `repeated-${index}`);
      expect(result.volumes[0]).toBeCloseTo((index+1)*6, 6);
      const stats = await api.getShapeCacheStats();
      expect(stats.protectedKeyCount).toBe(0); expect(stats.protectedOverBudget).toBe(0);
      expect(stats.shapeCount).toBeLessThanOrEqual(256); expect(stats.diagnostics).toEqual([]);
    }
    process.stdout.write(`[実測] 自動作図50回後 ${JSON.stringify(await api.getShapeCacheStats())}\n`);
  }, 30000);
});
