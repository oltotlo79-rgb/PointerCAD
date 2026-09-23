import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { NativeScriptVm } from './nativeScriptVm.js';
let wasm: Uint8Array<ArrayBuffer>;
beforeAll(async () => { wasm = new Uint8Array(await readFile(new URL('../vendor/script-runtime/quickjs-pcad.wasm', import.meta.url))); });
const create = () => NativeScriptVm.create({ wasm, timeMs: 1800000000000, memoryLimit: 64 * 1024 * 1024, maxStackSize: 128 * 1024,
  interruptHandler: () => false, onUnhandledRejection: () => { throw new Error('Unexpected rejection'); },
  moduleLoader: { normalize: () => { throw new Error('No modules'); }, load: () => { throw new Error('No modules'); } } });
describe('独自の実行境界は値の寿命と外部の入口を限定する', () => {
  it('実バイナリがホストに要求する全入口を固定し、通信・ファイル・外部部品を含めない', () => {
    const entries = WebAssembly.Module.imports(new WebAssembly.Module(wasm)).map(item => `${item.module}/${item.name}`).sort();
    expect(entries).toEqual(['pointercad/call', 'pointercad/interrupt', 'pointercad/load', 'pointercad/normalize', 'pointercad/rejection',
      'wasi_snapshot_preview1/clock_time_get', 'wasi_snapshot_preview1/fd_close', 'wasi_snapshot_preview1/fd_fdstat_get',
      'wasi_snapshot_preview1/fd_seek', 'wasi_snapshot_preview1/fd_write'].sort());
  });
  it('数値・文字列・所有権と破棄を実際の接続で照合する', async () => {
    const vm = await create(), other = await create();
    try {
      const result = vm.evalCode('"図😀"+String(2+3)', 'value.js');
      expect(result.toString()).toBe('図😀5');
      const copy = result.dup(); result.dispose();
      expect(() => result.toString()).toThrow('Expired');
      expect(copy.toString()).toBe('図😀5');
      expect(() => other.global.setProp('foreign', copy)).toThrow('foreign');
      copy.dispose();
      const value = vm.newString('alive'); vm.dispose();
      expect(() => value.toString()).toThrow('not available');
    } finally { vm.dispose(); other.dispose(); }
  });
  it('コールバックへ貸した値を後から使えず、明示した複製だけが残る', async () => {
    const vm = await create();
    const borrowed: { read?: () => string; copied?: ReturnType<typeof vm.newString> } = {};
    try {
      const callback = vm.newFunction('capture', value => { borrowed.read = () => value.toString(); borrowed.copied = value.dup(); return vm.undefined; });
      vm.global.setProp('capture', callback); callback.dispose();
      vm.evalCode('capture("value")', 'capture.js').dispose();
      expect(() => borrowed.read?.()).toThrow('Expired');
      expect(borrowed.copied?.toString()).toBe('value'); borrowed.copied?.dispose();
    } finally { vm.dispose(); }
  });
});
