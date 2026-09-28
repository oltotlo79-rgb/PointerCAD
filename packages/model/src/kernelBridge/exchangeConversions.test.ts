/**
 * `toShapeExportOutcome` の 'mesh' の枝の検査(R04・§6.1 の3の是正)。
 *
 * 対応要件: FR-803、FR-804、FR-1106、NFR-MA-1(model は kernel の型を外へ出さない)。
 *
 * `docs/review-2026-09-28-codex.md` の R04 は、model→UI の詰め替えで `faceColors`・
 * `faceRanges` を落としており、3MF の面ごとの色が通常の出力経路(UI 側の
 * `createExchangeDeps(...).buildThreeMf`)から欠落することを、実際の出力バイトで
 * 示した(付録C)。この検査は同じ欠落を、model 側の詰め替え関数を直接呼ぶ形で固定する。
 */
import type { ShapeExportFile, ShapeExportMeshBody, ShapeExportResult } from '@pointercad/kernel';
import { describe, expect, it } from 'vitest';

import { toShapeExportOutcome } from './exchangeConversions.js';
import type {
  ExportColor,
  ShapeExportBody,
  ShapeExportFormat,
  ShapeExportOptions,
  ShapeExportOutcome,
} from './exchangeContracts.js';

const BODY_COLOR: ExportColor = [1, 0, 0];
const FACE_COLOR: ExportColor = [0, 0, 1];

function meshResultBody(): ShapeExportMeshBody {
  return {
    bodyKey: 'body-1',
    triangles: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      normals: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      triangleCount: 2,
      faceRanges: [
        { triangleOffset: 0, triangleCount: 1 },
        { triangleOffset: 1, triangleCount: 1 },
      ],
    },
  };
}

function exportOptions(
  bodies: readonly ShapeExportBody[],
  format: ShapeExportFormat = 'mesh',
): ShapeExportOptions {
  return {
    format,
    bodies,
    meshQuality: { deviationMm: 0.1, angularDeflectionRad: 0.2 },
    withColors: true,
    ascii: false,
    baseName: 'model',
  };
}

describe("toShapeExportOutcome('mesh') の面色・面範囲(R04)", () => {
  it('依頼の faceColors と kernel が返した faceRanges を、そのまま結果へ引き継ぐ', () => {
    const bodies: readonly ShapeExportBody[] = [
      {
        featureId: 'feature-1',
        name: 'box',
        color: BODY_COLOR,
        faceColors: new Map([[1, FACE_COLOR]]),
      },
    ];
    const outcome = toShapeExportOutcome(
      { format: 'mesh', bodies: [meshResultBody()] },
      exportOptions(bodies),
    );
    expect(outcome.kind).toBe('meshes');
    if (outcome.kind !== 'meshes') throw new Error('unreachable');
    expect(outcome.bodies).toHaveLength(1);
    expect(outcome.bodies[0]?.color).toEqual(BODY_COLOR);
    expect(outcome.bodies[0]?.faceColors?.get(1)).toEqual(FACE_COLOR);
    expect(outcome.bodies[0]?.faceRanges).toEqual([
      { triangleOffset: 0, triangleCount: 1 },
      { triangleOffset: 1, triangleCount: 1 },
    ]);
  });

  it('面の色を付けていない立体では faceColors・faceRanges を省く(空の表を作らない)', () => {
    const bodies: readonly ShapeExportBody[] = [
      { featureId: 'feature-1', name: 'box', color: BODY_COLOR },
    ];
    const outcome = toShapeExportOutcome(
      { format: 'mesh', bodies: [meshResultBody()] },
      exportOptions(bodies),
    );
    if (outcome.kind !== 'meshes') throw new Error('unreachable');
    expect(outcome.bodies[0]).not.toHaveProperty('faceColors');
    expect(outcome.bodies[0]).not.toHaveProperty('faceRanges');
  });
});

/*
 * 形式ごとに「面の色が出力まで届く」ことを確かめる共通の検査(指示書「すること」3)。
 *
 * **kernel(`worker/kernelApi.ts`)は STEP・OBJ・glTF を、面ごとの色を焼き込んだ
 * 完成ファイル(`kind: 'files'`)で返す**(`writeStep.test.ts`・`writeCafMesh.test.ts`が
 * 焼き込み自体を検査済み)。model の役目は、その `result.files` を 1 バイトも変えずに
 * `outcome.files` へそのまま渡すことだけであり、ここを詰め替えると R04 と同じ欠落が
 * また起こり得る。**3MF(`'mesh'`)だけは kernel が三角形までしか返さないので、
 * 面の色・面の範囲を model が依頼側から引き継ぐ必要がある**(上のテスト)。
 *
 * この `switch` は網羅的(`default` を作らない)なので、`ShapeExportResult` に新しい
 * 形式が増えたら、ここへ判定を足すまで型検査が落ちる——新しい形式で同じ欠落を
 * 見逃さない仕組み(rules/06 の「同じ種類の誤りを機械で防ぐ」)。
 */
describe('形式ごとに面の色の運び手が出力まで届く(共通検査、R04)', () => {
  function assertCarriesFaceColor(format: ShapeExportFormat, outcome: ShapeExportOutcome): void {
    switch (format) {
      case 'step':
      case 'stl':
      case 'obj':
      case 'gltf':
        // 面の色は kernel がファイルへ焼き込み済み。model は `files` を詰め替えない
        // ことだけを保証する(焼き込み自体は writeStep.test.ts・writeCafMesh.test.ts)。
        if (outcome.kind !== 'files') throw new Error(`${format} は 'files' で返るはず`);
        break;
      case 'mesh':
        // 面の色は依頼にしか無いので、model が結果へ引き継がないと 3MF まで届かない(R04)。
        if (outcome.kind !== 'meshes') throw new Error("mesh は 'meshes' で返るはず");
        expect(outcome.bodies[0]?.faceColors?.get(1)).toEqual(FACE_COLOR);
        expect(outcome.bodies[0]?.faceRanges).toBeDefined();
        break;
      default: {
        // 網羅チェック(`ShapeExportFormat` に新しい形式が増えたらここが型検査で落ちる)。
        // 新しい形式を足したのに、この共通検査へ判定を足し忘れることを防ぐ。
        const exhaustive: never = format;
        throw new Error(`未対応の形式です: ${String(exhaustive)}`);
      }
    }
  }

  const bodies: readonly ShapeExportBody[] = [
    {
      featureId: 'feature-1',
      name: 'box',
      color: BODY_COLOR,
      faceColors: new Map([[1, FACE_COLOR]]),
    },
  ];

  const filesResult = (format: 'step' | 'stl' | 'obj' | 'gltf'): ShapeExportFile[] => [
    { fileName: `model.${format}`, bytes: new Uint8Array([1, 2, 3]) },
  ];

  it.each<{ format: ShapeExportFormat; result: ShapeExportResult }>([
    { format: 'step', result: { format: 'step', bytes: new Uint8Array([1, 2, 3]), colorWritten: true } },
    {
      format: 'stl',
      result: { format: 'stl', files: filesResult('stl'), triangleCount: 2, droppedTriangleCount: 0 },
    },
    {
      format: 'obj',
      result: { format: 'obj', files: filesResult('obj'), triangleCount: 2, droppedTriangleCount: 0 },
    },
    {
      format: 'gltf',
      result: { format: 'gltf', files: filesResult('gltf'), triangleCount: 2, droppedTriangleCount: 0 },
    },
    { format: 'mesh', result: { format: 'mesh', bodies: [meshResultBody()] } },
  ])('$format: 面の色の運び手が outcome まで届く', ({ format, result }) => {
    const outcome = toShapeExportOutcome(result, exportOptions(bodies, format));
    assertCarriesFaceColor(format, outcome);
  });
});
