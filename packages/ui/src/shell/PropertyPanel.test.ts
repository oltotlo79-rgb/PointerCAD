/**
 * `PropertyPanel.tsx` の (g)「拘束で決まった、いまの位置」の表示だけを
 * 有効数字 9 桁へ丸める `roundSolvedCoordinateText`(P4b タスク23b-1)を検査する。
 * 保存値・入力欄には触れない機能なので、ここでは丸めの文字列だけを見る
 * (vitest の include は `src/**\/*.test.ts` のみで `.tsx` を含まないので、
 * このファイルはコンポーネントを描画せず純関数だけを呼ぶ)。
 */
import { describe, expect, it } from 'vitest';

import { appearanceSectionKey, roundSolvedCoordinateText } from './PropertyPanel.js';

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
