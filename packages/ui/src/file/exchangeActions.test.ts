/**
 * 単位を訊く小窓の待ち合わせ(`exchangeActions.ts`、計画書 docs/plans/P6-入出力.md
 * §0.a-0.6、タスク32b)の検査。
 *
 * 対応要件: FR-802、FR-811、NFR-UX-5(2 択を「OK / キャンセル」で訊かない)。
 *
 * 画面(`ImportUnitPanel.tsx`)は押されたボタンを `answerImportUnit` へ渡すだけなので、
 * ここでは**待ち合わせ**——訊いている間は印が立ち、答えると読み込みへ値が返る——を固定する。
 */

import { writeThreeMf, type ThreeMfColor, type ThreeMfMeshInput } from '@pointercad/io';
import { describe, expect, it } from 'vitest';

import { useAppStore } from '../store/useAppStore.js';
import { answerImportUnit, createExchangeDeps } from './exchangeActions.js';

describe('単位を訊く(§0.a-0.6)', () => {
  it('訊いている間は印が立ち、答えると読み込みへ単位が返る', async () => {
    const pending = createExchangeDeps('model').askImportUnit();
    expect(useAppStore.getState().importUnitAsked).toBe(true);

    answerImportUnit('inch');
    await expect(pending).resolves.toBe('inch');
    expect(useAppStore.getState().importUnitAsked).toBe(false);
  });

  it('「やめる」は null を返す(読み込みそのものが取り消しになる)', async () => {
    const pending = createExchangeDeps('model').askImportUnit();
    answerImportUnit(null);
    await expect(pending).resolves.toBeNull();
    expect(useAppStore.getState().importUnitAsked).toBe(false);
  });

  it('誰も待っていないときに答えても何も起きない(小窓が二重に閉じても壊れない)', () => {
    answerImportUnit('mm');
    expect(useAppStore.getState().importUnitAsked).toBe(false);
  });

  it('前の問いが残ったまま次を訊いたら、前の問いは取り消しになる(答えを 2 つ待たない)', async () => {
    const first = createExchangeDeps('model').askImportUnit();
    const second = createExchangeDeps('model').askImportUnit();
    await expect(first).resolves.toBeNull();

    answerImportUnit('mm');
    await expect(second).resolves.toBe('mm');
  });
});

/*
 * `createExchangeDeps(...).buildThreeMf` の面ごとの色(R04・§6.1 の3の是正)。
 *
 * `docs/review-2026-09-28-codex.md` の R04・付録Cは、UI 側の実際の書き出しの入口
 * (`createExchangeDeps(...).buildThreeMf`)を通すと、面ごとの色(青)が消えて立体の色
 * (赤)しか出力に残らないことを、`writeThreeMf` への直接呼び出しとの比較で示した。
 * この検査は同じ比較を行い、**UI の入口を通した結果が、同じ面色を渡した
 * `writeThreeMf` の直接呼び出しと 1 バイトも違わない**ことを固定する
 * (`writeThreeMf.test.ts` は下位のライター単体だけを見ており、UI からの到達は見ない)。
 */
describe('createExchangeDeps(...).buildThreeMf の面ごとの色(R04)', () => {
  const BODY_COLOR: ThreeMfColor = [1, 0, 0];
  const FACE_COLOR: ThreeMfColor = [0, 0, 1];
  const FACE_RANGES = [
    { triangleOffset: 0, triangleCount: 1 },
    { triangleOffset: 1, triangleCount: 1 },
  ];

  const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3]);

  function meshInput(withFaceColor: boolean): ThreeMfMeshInput {
    return {
      name: 'two-triangles',
      color: BODY_COLOR,
      positions: POSITIONS,
      indices: INDICES,
      ...(withFaceColor
        ? { faceColors: new Map([[1, FACE_COLOR]]), faceRanges: FACE_RANGES }
        : {}),
    };
  }

  function buildThreeMfOrThrow(baseName: string) {
    const buildThreeMf = createExchangeDeps(baseName).buildThreeMf;
    if (buildThreeMf === undefined) throw new Error('buildThreeMf が組まれていません');
    return buildThreeMf;
  }

  it('面の色を渡すと、UI の入口を通した結果が writeThreeMf の直接呼び出しと1バイトも違わない', () => {
    const mesh = meshInput(true);
    const direct = writeThreeMf([mesh]);
    const throughUi = buildThreeMfOrThrow('review')({
      files: [],
      droppedTriangleCount: 0,
      meshes: [
        {
          name: mesh.name,
          color: mesh.color,
          positions: POSITIONS,
          indices: INDICES,
          faceColors: mesh.faceColors,
          faceRanges: mesh.faceRanges,
        },
      ],
    });
    expect(throughUi.bytes).toEqual(direct);
  });

  it('面の色を持たない依頼は今までどおり立体の色だけになる(退行が無い)', () => {
    const mesh = meshInput(false);
    const direct = writeThreeMf([mesh]);
    const throughUi = buildThreeMfOrThrow('review')({
      files: [],
      droppedTriangleCount: 0,
      meshes: [
        {
          name: mesh.name,
          color: mesh.color,
          positions: POSITIONS,
          indices: INDICES,
        },
      ],
    });
    expect(throughUi.bytes).toEqual(direct);
  });
});
