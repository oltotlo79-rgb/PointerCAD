import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { executeScriptVm } from './runtimeAdapter.js';
import { createScriptFile } from './scriptFileModel.js';
import { readScriptExecutionInput } from './scriptInput.js';
import { sha256ScriptSource } from './scriptModules.js';
import type { ScriptExecutionInput } from './scriptTypes.js';

// Independent integer bound: WASI's uint64 nanoseconds must represent every input millisecond.
const lastMillisecond = Number(((1n << 64n) - 1n) / 1000000n);
let wasm: Uint8Array<ArrayBuffer>;
beforeAll(async () => { wasm = new Uint8Array(await readFile(new URL('../vendor/script-runtime/quickjs-pcad.wasm', import.meta.url))); });
async function input(timeMs: number): Promise<ScriptExecutionInput> {
  const source = 'console.log(Date.now(),new Date().toISOString());';
  return { executionId: 'clock-test', commandNamespace: 'b'.repeat(64),
    program: { apiVersion: 1, source, sha256: await sha256ScriptSource(source), modules: [] },
    snapshot: '{}', seed: 1, timeMs };
}
describe('保存した時刻を実VMへ桁あふれなく渡す', () => {
  it.each([0, 1800000000000, lastMillisecond])('%sミリ秒をDateとDate.nowの両方へそのまま渡す', async timeMs => {
    const result = await executeScriptVm(await input(timeMs), wasm);
    expect(result).toMatchObject({ ok: true, console: [{ level: 'info', text: `${timeMs} ${new Date(timeMs).toISOString()}` }] });
  });
  it.each([lastMillisecond + 1, 8640000000000000])('表現できない%sをファイルとWorkerの両入口で拒否する', async timeMs => {
    expect(readScriptExecutionInput(await input(timeMs))).toBeNull();
    expect(await createScriptFile({ scriptId: 'clock', name: '時刻', icon: 'code', source: '', modules: [], seed: 1, timeMs }))
      .toMatchObject({ ok: false });
  });
});
