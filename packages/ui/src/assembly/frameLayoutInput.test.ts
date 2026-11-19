/**
 * フレームの一括配置(J-01 包み 3)の窓の欄の中身の検査: 貼り付けた点の文字(タブ・カンマ・空白区切り)が線の列になり、
 * 予告に 1 本ごとの長さ・端の伸び縮みと角の扱い(通す線)が出て、角の入れ替えで通す線が替わり、読めない・作れない時は理由が出る事。
 */
import { PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { beforeAll, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import {
  frameDimensionBasisAvailable, frameLayoutView, INITIAL_FRAME_LAYOUT, toggleFrameCornerSwap, type FrameLayoutState,
} from './frameLayoutInput.js';

const SERIES = { kind: 'catalogItem', familyId: 't-slot-frame-series', itemKey: 's6-20x20', values: {} } as const;
/** 表計算の表から貼り付けた 500×300 の長方形の 4 点(タブ区切り、行の終わりは CR LF)。 */
const PASTED = ['0\t0\t0', '500\t0\t0', '500\t300\t0', '0\t300\t0'].join('\r\n');

/** 予告の店へ渡す中身の線の列(始点と終点)。角の扱いは「そのまま」。 */
function linesOf(pointsText: string, closed: boolean): readonly (readonly unknown[])[] {
  const view = frameLayoutView({ ...INITIAL_FRAME_LAYOUT, pointsText, closed, corners: 'none' }, SERIES);
  if (view.kind !== 'ready') throw new Error(`not ready: ${view.kind === 'error' ? view.message : view.kind}`);
  return view.request.lines.map((line) => [line.start, line.end]);
}

beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-frame-series', 't-slot-nut-bar']); });

describe('フレームの一括配置の窓の欄', () => {
  it('タブ・カンマ・空白のどれで区切っても同じ線の列になり、空の行は飛ばし、閉じると最後から最初へも 1 本', () => {
    const tab = linesOf(PASTED, false);
    const mixed = linesOf('0, 0, 0\n\n500 0 0\n500,300,0\n0\t300\t0\n', false);
    expect(tab).toEqual(mixed);
    expect(tab).toEqual([[[0, 0, 0], [500, 0, 0]], [[500, 0, 0], [500, 300, 0]], [[500, 300, 0], [0, 300, 0]]]);
    expect(linesOf(PASTED, true).at(-1)).toEqual([[0, 300, 0], [0, 0, 0]]);
    // 2 点は閉じても 1 本(同じ線を逆に重ねない)。
    expect(linesOf('0 0 0\n100 0 0', true)).toHaveLength(1);
  });

  it('一筆書き(E-08)で打った点も同じ欄の文字として読み、予告と置く中身は「点を入れる」と同じ', () => {
    const points = frameLayoutView({ ...INITIAL_FRAME_LAYOUT, pointsText: PASTED, closed: true }, SERIES);
    const stroke = frameLayoutView({ ...INITIAL_FRAME_LAYOUT, source: 'stroke', pointsText: PASTED, closed: true }, SERIES);
    expect(stroke).toEqual(points);
    expect(frameLayoutView({ ...INITIAL_FRAME_LAYOUT, source: 'stroke', pointsText: ' ' }, SERIES)).toEqual({ kind: 'empty' });
  });

  it('3 つの数でない行は行の番号つきで断り、点が 1 つ以下なら 2 つ以上を求める', () => {
    const view = (pointsText: string): ReturnType<typeof frameLayoutView> =>
      frameLayoutView({ ...INITIAL_FRAME_LAYOUT, pointsText }, SERIES);
    expect(view('0 0 0\n500 0\n')).toEqual({ kind: 'error', message: t('catalog.frameLayout.error.badPoint').replace('{line}', '2') });
    expect(view('0 0 0\n500 0 abc')).toEqual({ kind: 'error', message: t('catalog.frameLayout.error.badPoint').replace('{line}', '2') });
    expect(view('0 0 0')).toEqual({ kind: 'error', message: t('catalog.frameLayout.error.tooFew') });
  });

  it('予告: 閉じた長方形の突き当ては 4 本(520・300・500・280)で、先の線を通し、店へ渡す中身は欄の値のまま', () => {
    const state: FrameLayoutState = { ...INITIAL_FRAME_LAYOUT, pointsText: PASTED, closed: true };
    const view = frameLayoutView(state, SERIES);
    if (view.kind !== 'ready') throw new Error(`not ready: ${view.kind === 'error' ? view.message : view.kind}`);
    expect(view.rows.map((row) => row.cells)).toEqual([
      [t('catalog.frameLayout.lineName').replace('{n}', '1'), '520', '+10', '+10'],
      [t('catalog.frameLayout.lineName').replace('{n}', '2'), '300', '-10', '+10'],
      [t('catalog.frameLayout.lineName').replace('{n}', '3'), '500', '-10', '+10'],
      [t('catalog.frameLayout.lineName').replace('{n}', '4'), '280', '-10', '-10']]);
    expect(view.corners.map((corner) => corner.swappable)).toEqual([true, true, true, true]);
    expect(view.corners[1]?.text).toBe(t('catalog.frameLayout.corner.butt').replace('{n}', '2').replace('{a}', '1').replace('{b}', '2')
      .replace('{through}', '1'));
    expect([view.request.up, view.request.corners, view.request.startExtension, view.request.swapThrough]).toEqual([[0, 0, 1], 'butt', 0, []]);
  });

  it('角 2 の通す線を入れ替えると線 2 が通って 320 になり、もう一度押すと元に戻る', () => {
    const state: FrameLayoutState = { ...INITIAL_FRAME_LAYOUT, pointsText: PASTED, closed: true };
    const swapped = toggleFrameCornerSwap(state, 1);
    const view = frameLayoutView(swapped, SERIES);
    expect(view.kind === 'ready' ? view.rows.map((row) => row.cells[1]) : null).toEqual(['500', '320', '500', '280']);
    expect(toggleFrameCornerSwap(swapped, 1).swapThrough).toEqual([]);
  });

  it('角の扱いが「そのまま」なら長さは線の長さで角は入れ替えられず、伸ばす量は式で読み、作れない長さは線の番号つきで断る', () => {
    const none = frameLayoutView({ ...INITIAL_FRAME_LAYOUT, pointsText: PASTED, corners: 'none', startExtension: '5*2' }, SERIES);
    expect(none.kind === 'ready' ? none.rows.map((row) => row.cells[1]) : null).toEqual(['510', '310', '510']);
    expect(none.kind === 'ready' ? none.corners.map((corner) => corner.swappable) : null).toEqual([false, false]);
    expect(frameLayoutView({ ...INITIAL_FRAME_LAYOUT, pointsText: PASTED, startExtension: '-400' }, SERIES))
      .toEqual({ kind: 'error', message: t('catalog.frameLayout.error.nonPositiveLength').replace('{line}', '2') });
    expect(frameLayoutView({ ...INITIAL_FRAME_LAYOUT, pointsText: PASTED, startExtension: 'abc' }, SERIES))
      .toEqual({ kind: 'error', message: t('catalog.frameLayout.error.badExtension') });
    expect(frameLayoutView(INITIAL_FRAME_LAYOUT, SERIES)).toEqual({ kind: 'empty' });
  });

  it('留め(J-01 包み 5): 閉じた長方形は 4 本とも長い側 520・320 で、端の欄に留めの印、角は 4 つとも留めで入れ替えられない', () => {
    const view = frameLayoutView({ ...INITIAL_FRAME_LAYOUT, pointsText: PASTED, closed: true, corners: 'miter' }, SERIES);
    if (view.kind !== 'ready') throw new Error(`not ready: ${view.kind === 'error' ? view.message : view.kind}`);
    const mark = t('catalog.frameLayout.miterMark');
    expect(view.rows.map((row) => row.cells.slice(1))).toEqual([['520', `+10${mark}`, `+10${mark}`], ['320', `+10${mark}`, `+10${mark}`],
      ['520', `+10${mark}`, `+10${mark}`], ['320', `+10${mark}`, `+10${mark}`]]);
    expect(view.request.corners).toBe('miter');
    expect(view.corners.map((corner) => corner.swappable)).toEqual([false, false, false, false]);
    expect(view.corners[0]?.text).toBe(t('catalog.frameLayout.corner.miter').replace('{n}', '1').replace('{lines}', '1・4'));
    // 留めの欄を持たない族(T 溝用ナットの素材)は理由を出す。
    expect(frameLayoutView({ ...INITIAL_FRAME_LAYOUT, pointsText: PASTED, closed: true, corners: 'miter' },
      { kind: 'catalogItem', familyId: 't-slot-nut-bar', itemKey: 's6-post-stainless', values: {} }))
      .toEqual({ kind: 'error', message: t('catalog.frameLayout.error.miterUnsupported') });
  });

  /** 予告の芯の点の 1 行の文字。 */
  const center = (n: number, x: number, y: number): string => t('catalog.frameLayout.centerPoint').replace('{n}', String(n))
    .replace('{x}', String(x)).replace('{y}', String(y)).replace('{z}', '0');

  it('寸法の基準(P-B): 外側の 500×300 は断面 20×20 の芯 480×280 で並べて芯の点を出し、内側は 520×320、芯は今までどおり', () => {
    const layout = { ...INITIAL_FRAME_LAYOUT, pointsText: PASTED, closed: true, corners: 'none' } as const;
    const outer = frameLayoutView({ ...layout, dimensionBasis: 'outer' }, SERIES);
    if (outer.kind !== 'ready') throw new Error(`not ready: ${outer.kind === 'error' ? outer.message : outer.kind}`);
    expect(outer.rows.map((row) => row.cells[1])).toEqual(['480', '280', '480', '280']);
    expect(outer.centers).toEqual([center(1, 10, 10), center(2, 490, 10), center(3, 490, 290), center(4, 10, 290)]);
    const inner = frameLayoutView({ ...layout, dimensionBasis: 'inner' }, SERIES);
    expect(inner.kind === 'ready' ? inner.rows.map((row) => row.cells[1]) : null).toEqual(['520', '320', '520', '320']);
    const centerBasis = frameLayoutView(layout, SERIES);
    expect(centerBasis.kind === 'ready' ? [centerBasis.rows.map((row) => row.cells[1]), centerBasis.centers] : null)
      .toEqual([['500', '300', '500', '300'], []]);
  });

  it('寸法の基準: 内側・外側は閉じた点の形だけで選べ、閉じていない形・同じ高さに無い点は理由を出す', () => {
    expect(frameDimensionBasisAvailable({ ...INITIAL_FRAME_LAYOUT, closed: true })).toBe(true);
    expect(frameDimensionBasisAvailable({ ...INITIAL_FRAME_LAYOUT, source: 'stroke', closed: true })).toBe(true);
    expect(frameDimensionBasisAvailable({ ...INITIAL_FRAME_LAYOUT, closed: false })).toBe(false);
    expect(frameDimensionBasisAvailable({ ...INITIAL_FRAME_LAYOUT, source: 'edges', closed: true })).toBe(false);
    expect(frameLayoutView({ ...INITIAL_FRAME_LAYOUT, pointsText: PASTED, closed: false, dimensionBasis: 'outer' }, SERIES))
      .toEqual({ kind: 'error', message: t('catalog.frameLayout.error.basis.notClosed') });
    expect(frameLayoutView({ ...INITIAL_FRAME_LAYOUT, pointsText: '0 0 0\n500 0 5\n500 300 0\n0 300 0', closed: true,
      dimensionBasis: 'inner' }, SERIES)).toEqual({ kind: 'error', message: t('catalog.frameLayout.error.basis.notLevel') });
  });
});
