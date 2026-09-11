import { describe, expect, it } from 'vitest';
import { createScriptFile, SCRIPT_FILE_LIMITS, SCRIPT_LIMITS } from '@pointercad/model/scripting';
import { decodeScriptFile, encodeScriptFile } from './scriptFile.js';

async function fixture(source = "cad.solid.box({x:'板厚*2',y:'20',z:'3'});") {
  const result = await createScriptFile({ scriptId: 'fixture', name: '日本語の処理', icon: 'box', source,
    modules: [{ name: 'tools/helpers.js', source: "export const dimension='30';" }], seed: 0, timeMs: 0 });
  if (!result.ok) throw new Error(result.reason); return result.file;
}
describe('処理ファイルの境界と無実行の往復', () => {
  it('名前・式・module・SHA・図柄・seed0・epoch0を無損失で往復する', async () => {
    const file = await fixture(); expect(await decodeScriptFile(await encodeScriptFile(file))).toEqual({ ok: true, file });
  });
  it('コードを開いても評価しない', async () => {
    const file = await fixture("throw new Error('開くだけでは実行しない');");
    expect((await decodeScriptFile(await encodeScriptFile(file))).ok).toBe(true);
  });
  it.each([
    { name: '' }, { name: ' blank ' }, { name: '\u0000' }, { name: 'a'.repeat(81) },
    { scriptId: '../other' }, { icon: '<svg onload=run()>' }, { version: 2 }, { kind: 'pcad' },
    { seed: -1 }, { seed: 4294967296 }, { seed: 0.5 }, { timeMs: 8640000000000001 }, { timeMs: null }, { unknown: true },
  ])('不正な設定を拒む %j', async patch => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...await fixture(), ...patch }));
    expect((await decodeScriptFile(bytes)).ok).toBe(false);
  });
  it('rootとmoduleの改ざん、重複名、外部moduleを拒む', async () => {
    const file = await fixture();
    for (const program of [
      { ...file.program, source: 'changed' },
      { ...file.program, modules: [{ ...file.program.modules[0], source: 'changed' }] },
      { ...file.program, modules: [...file.program.modules, ...file.program.modules] },
      { ...file.program, modules: [{ ...file.program.modules[0], name: 'https://example.com/remote.js' }] },
    ]) expect((await decodeScriptFile(new TextEncoder().encode(JSON.stringify({ ...file, program })))).ok).toBe(false);
  });
  it('読込前のbyte上限とUTF8エラーを拒む', async () => {
    expect(await decodeScriptFile(new Uint8Array(SCRIPT_FILE_LIMITS.bytes + 1))).toEqual({ ok: false, reason: 'bytes' });
    expect(await decodeScriptFile(new Uint8Array([0xc0, 0xaf]))).toEqual({ ok: false, reason: 'format' });
  });
  it('1MiBはmoduleを含む合計で数え、日本語の文字数へ置き換えない', async () => {
    const result = await createScriptFile({ scriptId: 'large', name: '上限', icon: 'code', source: 'あ'.repeat(Math.ceil(SCRIPT_LIMITS.sourceBytes / 3)), modules: [], seed: 1, timeMs: 0 });
    expect(result).toEqual({ ok: false, reason: 'bytes' });
  });
});
