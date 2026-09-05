/**
 * `PropertyPanel.tsx` の (g)「拘束で決まった、いまの位置」の表示だけを
 * 有効数字 9 桁へ丸める `roundSolvedCoordinateText`(P4b タスク23b-1)を検査する。
 * 保存値・入力欄には触れない機能なので、ここでは丸めの文字列だけを見る
 * (vitest の include は `src/**\/*.test.ts` のみで `.tsx` を含まないので、
 * このファイルはコンポーネントを描画せず純関数だけを呼ぶ)。
 */
import { describe, expect, it } from 'vitest';

import {
  appearanceSectionKey,
  cutSectionKey,
  massSectionKey,
  measureSectionKey,
  primitiveSectionKey,
  roundSolvedCoordinateText,
  ruledSectionKey,
} from './PropertyPanel.js';

describe('roundSolvedCoordinateText', () => {
  it('残差でずれた値を有効数字 9 桁へ丸める(末尾の 0 は落ちる)', () => {
    expect(roundSolvedCoordinateText('= (0, 0.999999999989, 0)(拘束で決まった値)')).toBe(
      '= (0, 1, 0)(拘束で決まった値)',
    );
  });

  it('12 桁の表示から 9 桁へ丸め、他の 2 つの数と接頭辞・接尾辞は変えない', () => {
    expect(
      roundSolvedCoordinateText('= (10.1234567890123, -3, 0.000123456789012)(拘束で決まった値)'),
    ).toBe('= (10.1234568, -3, 0.000123456789)(拘束で決まった値)');
  });

  it('想定と違う形の文字列はそのまま返す(壊れた文字列を作らない)', () => {
    expect(roundSolvedCoordinateText('未知の形')).toBe('未知の形');
  });
});

/**
 * 外観の節の `key`(P5 仕上げ (d))。
 *
 * 同じ親(`.pcad-panel__body`)には「立体/スケッチ要素/基準ジオメトリの節」が
 * `key={feature.id}`(= 選んでいる要素の id)で並ぶ。外観の節が同じ文字列を `key` にすると
 * **兄弟の鍵が重なり**、React が選び直しのときに古い節を消し損ねて、前に選んでいた立体の
 * 節が画面に積み上がる(2026-09-05 実測: 立体を選び直すたびに「立体/かたち/断面/結果」の
 * 4 節が増え、E2E の `体積` の照合が 2 要素になって落ちた)。重ならないことをここで固定する。
 */
describe('appearanceSectionKey', () => {
  it('立体を 1 つだけ選んでいても、その立体の id と同じ文字列にならない', () => {
    expect(appearanceSectionKey(['extrude-1'])).not.toBe('extrude-1');
  });

  it('面(部分形状)を 1 つだけ選んでいても、その id と同じ文字列にならない', () => {
    expect(appearanceSectionKey(['extrude-1#face:3'])).not.toBe('extrude-1#face:3');
  });

  it('選び直すと別の文字列になる(打ちかけの下書きを捨てるため)', () => {
    expect(appearanceSectionKey(['extrude-1'])).not.toBe(appearanceSectionKey(['extrude-2']));
    expect(appearanceSectionKey([])).not.toBe(appearanceSectionKey(['extrude-1']));
  });

  it('同じ選択なら同じ文字列になる(選び直していないのに作り直さない)', () => {
    expect(appearanceSectionKey(['extrude-1', 'extrude-2'])).toBe(
      appearanceSectionKey(['extrude-1', 'extrude-2']),
    );
  });
});

/**
 * 基本形状の節の `key`(P5 タスク18、rules/06 10.9)。
 *
 * 基本形状の節は `SolidProperties`(`key={solid.id}`)・外観の節
 * (`appearanceSectionKey(selection)`)と**同じ親**(`.pcad-panel__body`)に並ぶ。
 * 3 つの鍵が絶対に重ならないことをここで固定する(重なると React が古い節を消し損ね、
 * 選び直すたびに節が積み上がる。10.9 の再発防止)。
 */
describe('primitiveSectionKey', () => {
  it('立体の id と同じ文字列にならない(兄弟の鍵が重ならない)', () => {
    expect(primitiveSectionKey('sphere-1')).not.toBe('sphere-1');
    expect(primitiveSectionKey('box-12')).not.toBe('box-12');
  });

  it('立体を 1 つだけ選んでいるときの外観の節の鍵とも重ならない', () => {
    expect(primitiveSectionKey('sphere-1')).not.toBe(appearanceSectionKey(['sphere-1']));
  });

  it('別の立体なら別の文字列になる(選び直したら打ちかけの下書きを捨てる)', () => {
    expect(primitiveSectionKey('sphere-1')).not.toBe(primitiveSectionKey('sphere-2'));
  });

  it('同じ立体なら同じ文字列になる(選び直していないのに作り直さない)', () => {
    expect(primitiveSectionKey('torus-3')).toBe(primitiveSectionKey('torus-3'));
  });
});

/**
 * 面をつなぐ・ロフトの注記の節の `key`(P5 タスク27、rules/06 10.9)。
 *
 * この節も `SolidProperties`(`key={solid.id}`)・基本形状の節・外観の節と**同じ親**
 * (`.pcad-panel__body`)に並ぶ。4 つの鍵が絶対に重ならないことをここで固定する
 * (重なると React が古い節を消し損ね、選び直すたびに節が積み上がる。10.9 の再発防止)。
 */
describe('ruledSectionKey', () => {
  it('立体の id と同じ文字列にならない(兄弟の鍵が重ならない)', () => {
    expect(ruledSectionKey('ruled-1')).not.toBe('ruled-1');
    expect(ruledSectionKey('loft-12')).not.toBe('loft-12');
  });

  it('外観の節・基本形状の節の鍵とも重ならない', () => {
    expect(ruledSectionKey('ruled-1')).not.toBe(appearanceSectionKey(['ruled-1']));
    expect(ruledSectionKey('ruled-1')).not.toBe(primitiveSectionKey('ruled-1'));
  });

  it('別の立体なら別の文字列になる(選び直したら打ちかけの下書きを捨てる)', () => {
    expect(ruledSectionKey('ruled-1')).not.toBe(ruledSectionKey('ruled-2'));
    expect(ruledSectionKey('ruled-1')).not.toBe(ruledSectionKey('loft-1'));
  });

  it('同じ立体なら同じ文字列になる(選び直していないのに作り直さない)', () => {
    expect(ruledSectionKey('loft-3')).toBe(ruledSectionKey('loft-3'));
  });
});

/**
 * 測定・質量特性の節の `key`(P5 タスク32、rules/06 10.9)。
 *
 * この 2 つも `SolidProperties`(`key={solid.id}`)・基本形状の節・つなぎ方の節・外観の節と
 * **同じ親**(`.pcad-panel__body`)に並ぶ。6 つの鍵が絶対に重ならないことをここで固定する
 * (重なると React が古い節を消し損ね、選び直すたびに節が積み上がる。10.9 の再発防止)。
 */
describe('measureSectionKey / massSectionKey', () => {
  it('立体の id・部分形状の id と同じ文字列にならない', () => {
    expect(measureSectionKey(['extrude-1'])).not.toBe('extrude-1');
    expect(measureSectionKey(['extrude-1#face:3'])).not.toBe('extrude-1#face:3');
    expect(massSectionKey('extrude-1')).not.toBe('extrude-1');
  });

  it('他の 4 つの節の鍵とも重ならない', () => {
    expect(measureSectionKey(['extrude-1'])).not.toBe(appearanceSectionKey(['extrude-1']));
    expect(measureSectionKey(['extrude-1'])).not.toBe(primitiveSectionKey('extrude-1'));
    expect(measureSectionKey(['extrude-1'])).not.toBe(ruledSectionKey('extrude-1'));
    expect(massSectionKey('extrude-1')).not.toBe(measureSectionKey(['extrude-1']));
    expect(massSectionKey('extrude-1')).not.toBe(appearanceSectionKey(['extrude-1']));
  });

  it('選び直すと別の文字列になる(材料と密度をその立体の外観から選び直すため)', () => {
    expect(measureSectionKey(['extrude-1'])).not.toBe(measureSectionKey(['extrude-2']));
    expect(massSectionKey('extrude-1')).not.toBe(massSectionKey('extrude-2'));
  });

  it('同じ選択なら同じ文字列になる(選び直していないのに作り直さない)', () => {
    expect(measureSectionKey(['extrude-1', 'extrude-2'])).toBe(
      measureSectionKey(['extrude-1', 'extrude-2']),
    );
    expect(massSectionKey('box-3')).toBe(massSectionKey('box-3'));
  });
});

/**
 * 切断の「切る面」の節の `key`(P5 タスク27f、rules/06 10.9)。
 *
 * この節も `SolidProperties`(`key={solid.id}`)・基本形状の節・つなぎ方の節・外観の節・
 * 測定と質量特性の節と**同じ親**(`.pcad-panel__body`)に並ぶ。7 つの鍵が絶対に
 * 重ならないことをここで固定する(重なると React が古い節を消し損ね、選び直すたびに
 * 節が積み上がる。10.9 の再発防止)。
 */
describe('cutSectionKey', () => {
  it('立体の id と同じ文字列にならない(兄弟の鍵が重ならない)', () => {
    expect(cutSectionKey('cut-1')).not.toBe('cut-1');
    expect(cutSectionKey('cut-12')).not.toBe('cut-12');
  });

  it('他の 5 つの節の鍵とも重ならない', () => {
    expect(cutSectionKey('cut-1')).not.toBe(appearanceSectionKey(['cut-1']));
    expect(cutSectionKey('cut-1')).not.toBe(primitiveSectionKey('cut-1'));
    expect(cutSectionKey('cut-1')).not.toBe(ruledSectionKey('cut-1'));
    expect(cutSectionKey('cut-1')).not.toBe(measureSectionKey(['cut-1']));
    expect(cutSectionKey('cut-1')).not.toBe(massSectionKey('cut-1'));
  });

  it('別の切断なら別の文字列になる(選び直したら作り直す)', () => {
    expect(cutSectionKey('cut-1')).not.toBe(cutSectionKey('cut-2'));
  });

  it('同じ切断なら同じ文字列になる(選び直していないのに作り直さない)', () => {
    expect(cutSectionKey('cut-3')).toBe(cutSectionKey('cut-3'));
  });
});
