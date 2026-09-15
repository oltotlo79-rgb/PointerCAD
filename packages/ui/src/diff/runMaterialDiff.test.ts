import { afterEach, describe, expect, it, vi } from 'vitest';
import { writePcadFile } from '@pointercad/io';
import { createEmptyPartDocument, type PartRecomputeResult, type MaterialComparisonResult } from '@pointercad/model';
import { runMaterialDiff, MATERIAL_DIFF_TIMEOUT_MS, type MaterialDiffPhase } from './runMaterialDiff.js';
import type { MaterialDiffSession } from './materialDiffSession.js';

const part = createEmptyPartDocument(), bytes = writePcadFile(part);
const computed = (): PartRecomputeResult => ({ generation: 1, sketches: [], bodies: [], errors: [], cacheHits: 0, cancelled: false });
const compared: MaterialComparisonResult = { kind: 'compared', result: { beforeVolume: 0, afterVolume: 0,
  added: { kind: 'empty', volume: 0, mesh: null }, removed: { kind: 'empty', volume: 0, mesh: null }, common: { kind: 'empty', volume: 0, mesh: null } } };
function fixture() {
  const compute = vi.fn<MaterialDiffSession['compute']>(() => Promise.resolve(computed()));
  const compare = vi.fn<MaterialDiffSession['compare']>(() => Promise.resolve(compared));
  const dispose = vi.fn<() => void>();
  const create = vi.fn((): MaterialDiffSession => ({ compute, compare, dispose }));
  return { compute, compare, dispose, create };
}
afterEach(() => vi.useRealTimers());
describe('比較用の実ファイルを独立して再計算し、最後に一度だけ終了する', () => {
  it('同じ文書IDでも前後の所有者を分け、元のバイト列を保持する', async () => {
    const f = fixture(), phase = vi.fn<(value: MaterialDiffPhase) => void>(), original = [...bytes];
    expect(await runMaterialDiff(bytes, bytes, new AbortController().signal, phase, f.create)).toEqual(compared);
    expect(f.compute.mock.calls.map(([document, options]) => [document.id, options.partId])).toEqual([
      [part.id, 'comparison:before'], [part.id, 'comparison:after'],
    ]);
    expect(f.compute.mock.calls.every(([document]) => document !== part)).toBe(true);
    expect(phase.mock.calls.map(([value]) => value)).toEqual(['before', 'after', 'compare']);
    expect(f.compare.mock.calls[0].slice(0, 2)).toEqual([[], []]);
    expect(f.dispose).toHaveBeenCalledTimes(1); expect([...bytes]).toEqual(original);
  });
  it('計算が応答しなくても中止で直ちに終了し、遅い完了を次の比較に使わない', async () => {
    const f = fixture(), controller = new AbortController();
    let complete: ((result: PartRecomputeResult) => void) | undefined;
    f.compute.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = runMaterialDiff(bytes, bytes, controller.signal, () => undefined, f.create);
    controller.abort(); expect(await pending).toEqual({ kind: 'cancelled' });
    expect(f.dispose).toHaveBeenCalledTimes(1);
    if (complete === undefined) throw new Error('計算が始まっていません');
    complete(computed()); await Promise.resolve();
    expect(f.compare).not.toHaveBeenCalled(); expect(f.compute).toHaveBeenCalledTimes(1);
    const next = fixture(); expect(await runMaterialDiff(bytes, bytes, new AbortController().signal, () => undefined, next.create)).toEqual(compared);
    expect(next.dispose).toHaveBeenCalledTimes(1);
  });
  it('上限時間には独立処理を終了し、遅い結果も採用しない', async () => {
    vi.useFakeTimers(); const f = fixture(); f.compute.mockImplementation(() => new Promise(() => undefined));
    const pending = runMaterialDiff(bytes, bytes, new AbortController().signal, () => undefined, f.create);
    await vi.advanceTimersByTimeAsync(MATERIAL_DIFF_TIMEOUT_MS);
    const result = await pending;
    if (result.kind !== 'failed') throw new Error('時間切れを失敗として通知していません');
    expect(result.message).toContain('3分');
    expect(f.dispose).toHaveBeenCalledTimes(1); expect(f.compare).not.toHaveBeenCalled();
  });
  it('後側の破損と計算の失敗を区別し、片側だけの形で成功にしない', async () => {
    const broken = fixture();
    expect((await runMaterialDiff(bytes, new Uint8Array([1, 2]), new AbortController().signal, () => undefined, broken.create)).kind).toBe('failed');
    expect(broken.compute).toHaveBeenCalledTimes(1); expect(broken.compare).not.toHaveBeenCalled(); expect(broken.dispose).toHaveBeenCalledTimes(1);
    const failed = fixture(); failed.compute.mockRejectedValue(new Error('この式を計算できません'));
    expect(await runMaterialDiff(bytes, bytes, new AbortController().signal, () => undefined, failed.create)).toEqual({ kind: 'failed', message: 'この式を計算できません' });
    expect(failed.dispose).toHaveBeenCalledTimes(1); expect(failed.compare).not.toHaveBeenCalled();
  });
  it('再計算の取消、演算の失敗、終了失敗を同じ形だという表示へ変換しない', async () => {
    const cancelled = fixture(); cancelled.compute.mockResolvedValue({ ...computed(), cancelled: true });
    expect(await runMaterialDiff(bytes, bytes, new AbortController().signal, () => undefined, cancelled.create)).toEqual({ kind: 'cancelled' });
    expect(cancelled.compare).not.toHaveBeenCalled(); expect(cancelled.dispose).toHaveBeenCalledTimes(1);
    const failed = fixture(); failed.compare.mockResolvedValue({ kind: 'failed', message: 'Boolean失敗' });
    expect(await runMaterialDiff(bytes, bytes, new AbortController().signal, () => undefined, failed.create)).toEqual({ kind: 'failed', message: 'Boolean失敗' });
    const dirty = fixture(); dirty.dispose.mockImplementation(() => { throw new Error('終了失敗'); });
    const result = await runMaterialDiff(bytes, bytes, new AbortController().signal, () => undefined, dirty.create);
    if (result.kind !== 'failed') throw new Error('終了の失敗を通知していません');
    expect(result.message).toContain('終了失敗');
    expect(dirty.dispose).toHaveBeenCalledTimes(1);
  });
  it('再計算が一部失敗した文書を、空の部品として比較へ渡さない', async () => {
    const f = fixture();
    f.compute.mockResolvedValue({ ...computed(), errors: [{ featureId: 'broken-box', code: 'invalidValue', message: '箱の寸法を計算できません' }] });
    expect(await runMaterialDiff(bytes, bytes, new AbortController().signal, () => undefined, f.create)).toEqual({ kind: 'failed', message: '箱の寸法を計算できません' });
    expect(f.compute).toHaveBeenCalledTimes(1); expect(f.compare).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it('中止済みでは読み込まず、処理作成中の中止でも所有物を一度だけ解放する', async () => {
    const early = fixture(), controller = new AbortController(); controller.abort();
    expect(await runMaterialDiff(bytes, bytes, controller.signal, () => undefined, early.create)).toEqual({ kind: 'cancelled' });
    expect(early.create).not.toHaveBeenCalled();
    const during = fixture(), interrupted = new AbortController();
    expect(await runMaterialDiff(bytes, bytes, interrupted.signal, () => undefined,
      () => { interrupted.abort(); return during.create(); })).toEqual({ kind: 'cancelled' });
    expect(during.dispose).toHaveBeenCalledTimes(1); expect(during.compute).not.toHaveBeenCalled();
  });
});
