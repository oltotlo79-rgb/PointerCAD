/**
 * 書き出し・読み込みの橋渡し(`partExchanger.ts`、計画書 docs/plans/P6-入出力.md
 * §2.4・§2.5.1・§2.8、タスク32b)の検査。
 *
 * 対応要件: FR-802、FR-803、FR-804、FR-1106、NFR-RE-1。
 *
 * **幾何カーネルも Worker も起こさない。** 橋の口(`KernelBridge.exportShapes` /
 * `importShape`)を関数で受ける作りなので、記憶上の偽物を差し込んで
 * 「何を渡したか」「返ってきたものをどう直したか」だけを固定できる。実カーネルでの
 * 往復は model の `part/importedShapeKernel.test.ts` が確かめている。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appearanceFromPreset,
  appearanceOf,
  appendSolid,
  assignBodyAppearance,
  assignFaceAppearance,
  createEmptyPartDocument,
  createOffsetCache,
  createProjectionCache,
  createSubShapeCache,
  DEFAULT_EXPORT_COLOR,
  parseHexColor,
  rgbTupleOf,
  type AppearanceMatchEntry,
  type ImportedBody,
  type PartDocument,
  type PrimitiveFeature,
  type ResolvedSolidStep,
  type ShapeExportOptions,
  type ShapeExportOutcome,
  type ShapeImportOptions,
  type ShapeImportOutcome,
  type SubShapeRef,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  createPartExchanger,
  exportBodiesFor,
  toExchangeExportOutcome,
  toExchangeImportedBody,
  type PartExchangeSnapshot,
  type PartExchangerDeps,
} from './partExchanger.js';

/* ---------------------------------------------------------------------------
 * 見本
 * ------------------------------------------------------------------------- */

/** 半径 10 の球 1 つ。名前(「球1」)がそのままファイルへ書き込まれる(FR-804)。 */
const SPHERE: PrimitiveFeature = {
  id: 'sphere-1',
  name: '球1',
  suppressed: false,
  kind: 'primitive',
  origin: {
    kind: 'coordinate',
    value: {
      mode: 'absolute',
      x: expressionValueFromNumber(0),
      y: expressionValueFromNumber(0),
      z: expressionValueFromNumber(0),
    },
  },
  axis: { kind: 'world', axis: 'z' },
  shape: { kind: 'sphere', radius: expressionValueFromNumber(10) },
};

/** 球 1 つだけの部品。 */
const DOCUMENT: PartDocument = appendSolid(createEmptyPartDocument(), SPHERE);

/** 段の一覧の代わり(名前を引くのにしか使わないので、鍵は何でもよい)。 */
const STEPS: readonly ResolvedSolidStep[] = [
  {
    featureId: 'sphere-1',
    name: '球1',
    key: 'key-1',
    visible: true,
    plan: {
      kind: 'primitive',
      origin: [0, 0, 0],
      axis: [0, 0, 1],
      shape: { kind: 'sphere', radius: 10 },
      originQuery: null,
      targetKey: null,
    },
  },
];

function faceRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 100,
      position: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

function snapshotOf(
  document: PartDocument,
  appearanceMatches: readonly AppearanceMatchEntry[] = [],
): PartExchangeSnapshot {
  return { document, appearanceMatches };
}

/** 覚え書きは 3 つとも空のまま(球は投影もオフセットも使わない)。 */
function caches(): Pick<PartExchangerDeps, 'offsets' | 'projections' | 'subShapes'> {
  return {
    offsets: createOffsetCache(),
    projections: createProjectionCache(),
    subShapes: createSubShapeCache(),
  };
}

/* ---------------------------------------------------------------------------
 * 名前と色(FR-804、FR-1106、§2.5.1)
 * ------------------------------------------------------------------------- */

describe('exportBodiesFor(書き出す立体に名前と色を添える)', () => {
  it('名前は段の名前、色は割り当てが無ければ既定の外観の色になる', () => {
    const bodies = exportBodiesFor(snapshotOf(DOCUMENT), STEPS, ['sphere-1'], true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].featureId).toBe('sphere-1');
    expect(bodies[0].name).toBe('球1');
    expect(bodies[0].color).toEqual(rgbTupleOf(DEFAULT_EXPORT_COLOR));
    // 色を付けた面が 1 枚も無い立体には面の表を添えない(空の表を作らない)。
    expect(bodies[0].faceColors).toBeUndefined();
  });

  it('立体へ割り当てた色を書き込む', () => {
    const assigned = assignBodyAppearance(DOCUMENT, 'sphere-1', appearanceFromPreset('steel'));
    const color = parseHexColor(appearanceFromPreset('steel').color);
    const bodies = exportBodiesFor(snapshotOf(assigned), STEPS, ['sphere-1'], true);
    expect(color).not.toBeNull();
    expect(bodies[0].color).toEqual(color === null ? null : rgbTupleOf(color));
  });

  it('面へ割り当てた色は、カーネルが選び直した面の通し番号の表になる', () => {
    const assigned = assignFaceAppearance(
      DOCUMENT,
      faceRef('sphere-1', 2),
      appearanceFromPreset('glass'),
    );
    const entry = appearanceOf(assigned).entries[0];
    // 保存されている通し番号(2)ではなく、照合が返した番号(5)に入る(§2.5.1)。
    const matches: AppearanceMatchEntry[] = [
      { id: entry.id, bodyFeatureId: 'sphere-1', faceIndex: 5 },
    ];
    const bodies = exportBodiesFor(snapshotOf(assigned, matches), STEPS, ['sphere-1'], true);
    const glass = parseHexColor(appearanceFromPreset('glass').color);
    expect(bodies[0].faceColors?.get(5)).toEqual(glass === null ? null : rgbTupleOf(glass));
    expect(bodies[0].faceColors?.has(2)).toBe(false);
  });

  it('「色を含める」が切れていれば、立体の色も面の色も渡さない(§0.a-0.22)', () => {
    const assigned = assignFaceAppearance(
      assignBodyAppearance(DOCUMENT, 'sphere-1', appearanceFromPreset('steel')),
      faceRef('sphere-1', 0),
      appearanceFromPreset('glass'),
    );
    const entry = appearanceOf(assigned).entries.find((item) => item.target.kind === 'face');
    const matches: AppearanceMatchEntry[] = [
      { id: entry?.id ?? '', bodyFeatureId: 'sphere-1', faceIndex: 0 },
    ];
    const bodies = exportBodiesFor(snapshotOf(assigned, matches), STEPS, ['sphere-1'], false);
    expect(bodies[0].color).toBeNull();
    expect(bodies[0].faceColors).toBeUndefined();
  });

  it('段の一覧に無い id は名前を null にして渡す(断るのは model の橋)', () => {
    const bodies = exportBodiesFor(snapshotOf(DOCUMENT), STEPS, ['missing-1'], true);
    expect(bodies[0].name).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * 結果の詰め替え(§2.4、§0.a-0.19)
 * ------------------------------------------------------------------------- */

describe('toExchangeExportOutcome(書き出しの結果を手続きの形へ直す)', () => {
  it('ファイルはそのまま持ち回る(名前を変えない)', () => {
    const files = [{ fileName: 'box.obj', bytes: new Uint8Array([1]) }];
    expect(toExchangeExportOutcome({ kind: 'files', files, droppedTriangleCount: 3 })).toEqual({
      files,
      droppedTriangleCount: 3,
    });
  });

  it('3MF の三角形は meshes に載り、ファイルは 0 個になる(組むのは io)', () => {
    const outcome = toExchangeExportOutcome({
      kind: 'meshes',
      bodies: [
        {
          name: '球1',
          color: [1, 0, 0],
          positions: new Float32Array([0, 0, 0]),
          indices: new Uint32Array([0, 0, 0]),
        },
      ],
    });
    expect(outcome.files).toEqual([]);
    expect(outcome.droppedTriangleCount).toBe(0);
    expect(outcome.meshes?.[0].name).toBe('球1');
  });

  it('断りは日本語の理由の例外で投げる(画面はそのまま帯へ出す)', () => {
    expect(() => toExchangeExportOutcome({ kind: 'failed', message: '書けませんでした。' })).toThrow(
      '書けませんでした。',
    );
  });
});

describe('toExchangeImportedBody(読み込んだ立体を手続きの形へ直す)', () => {
  it('B-rep を持つ立体は brepBytes の枝になる', () => {
    const body: ImportedBody = {
      bodyKind: 'solid',
      name: 'Box',
      color: null,
      volume: 8000,
      triangleCount: 12,
      brepBytes: new Uint8Array([9, 9]),
    };
    const converted = toExchangeImportedBody(body);
    expect(converted.bodyKind).toBe('solid');
    expect(converted.volume).toBe(8000);
    expect(converted.triangleCount).toBe(12);
    if (converted.bodyKind === 'mesh') {
      throw new Error('B-rep を持つ立体が三角形の枝になった');
    }
    expect(converted.brepBytes).toEqual(new Uint8Array([9, 9]));
  });

  it('三角形だけの形は mesh の枝になる', () => {
    const body: ImportedBody = {
      bodyKind: 'mesh',
      name: null,
      color: null,
      volume: 0,
      triangleCount: 1,
      mesh: {
        positions: new Float32Array([0, 0, 0]),
        normals: new Float32Array([0, 0, 1]),
        indices: new Uint32Array([0, 0, 0]),
      },
    };
    const converted = toExchangeImportedBody(body);
    expect(converted.bodyKind).toBe('mesh');
    if (converted.bodyKind !== 'mesh') {
      throw new Error('三角形の形が B-rep の枝になった');
    }
    expect(converted.mesh.indices).toEqual(new Uint32Array([0, 0, 0]));
  });
});

/* ---------------------------------------------------------------------------
 * 口の組み立て(FR-802、FR-803)
 * ------------------------------------------------------------------------- */

describe('createPartExchanger(タスク32 が空けた口を埋める)', () => {
  it('書き出しは文書を解いた段と、名前・色を添えた立体をカーネルへ渡す', async () => {
    const seen: { steps: readonly ResolvedSolidStep[]; options: ShapeExportOptions }[] = [];
    const exchanger = createPartExchanger({
      ...caches(),
      snapshot: () => snapshotOf(DOCUMENT),
      exportShapes: (steps, options) => {
        seen.push({ steps, options });
        return Promise.resolve({
          kind: 'files',
          files: [{ fileName: 'model.step', bytes: new Uint8Array([1, 2]) }],
          droppedTriangleCount: 0,
        });
      },
      importShape: () => Promise.reject(new Error('この検査は読み込みを呼ばない')),
    });

    const outcome = await exchanger.exportShapes({
      format: 'step',
      featureIds: ['sphere-1'],
      meshQuality: null,
      withColors: true,
      ascii: false,
      baseName: 'model',
    });

    expect(seen).toHaveLength(1);
    // 文書を解いた段がそのまま渡る(鍵への引き直しは model の橋が行う)。
    expect(seen[0].steps.map((step) => step.featureId)).toEqual(['sphere-1']);
    expect(seen[0].options.format).toBe('step');
    expect(seen[0].options.baseName).toBe('model');
    expect(seen[0].options.bodies[0].name).toBe('球1');
    expect(outcome.files[0].fileName).toBe('model.step');
  });

  it('読み込みは形式・ファイル名・バイト列をそのまま渡し、単位と立体を返す', async () => {
    const seen: ShapeImportOptions[] = [];
    const imported: ShapeImportOutcome = {
      kind: 'imported',
      unit: 'other',
      bodies: [
        {
          bodyKind: 'mesh',
          name: null,
          color: null,
          volume: 1,
          triangleCount: 1,
          mesh: {
            positions: new Float32Array([0, 0, 0]),
            normals: new Float32Array([0, 0, 1]),
            indices: new Uint32Array([0, 0, 0]),
          },
        },
      ],
    };
    const exchanger = createPartExchanger({
      ...caches(),
      snapshot: () => snapshotOf(DOCUMENT),
      exportShapes: () => Promise.reject(new Error('この検査は書き出しを呼ばない')),
      importShape: (options) => {
        seen.push(options);
        return Promise.resolve(imported);
      },
    });

    const outcome = await exchanger.importShape('stl', 'part.stl', new Uint8Array([7]));
    expect(seen[0]).toEqual({
      format: 'stl',
      fileName: 'part.stl',
      bytes: new Uint8Array([7]),
    });
    // STL には単位が無いので `'other'` のまま返し、訊くのは手続きの側(§0.a-0.6)。
    expect(outcome.unit).toBe('other');
    expect(outcome.bodies[0].bodyKind).toBe('mesh');
  });

  it('読み込めなかった理由は例外で返す(手続きが帯へ出す)', async () => {
    const failed: ShapeImportOutcome = { kind: 'failed', message: '読めませんでした。' };
    const exchanger = createPartExchanger({
      ...caches(),
      snapshot: () => snapshotOf(DOCUMENT),
      exportShapes: () => Promise.reject(new Error('この検査は書き出しを呼ばない')),
      importShape: () => Promise.resolve(failed),
    });
    await expect(exchanger.importShape('step', 'a.step', new Uint8Array())).rejects.toThrow(
      '読めませんでした。',
    );
  });

  it('カーネルが断ったら、書き出しも同じ理由の例外になる', async () => {
    const refused: ShapeExportOutcome = { kind: 'failed', message: 'もとになる立体が見つかりません。' };
    const exchanger = createPartExchanger({
      ...caches(),
      snapshot: () => snapshotOf(DOCUMENT),
      exportShapes: () => Promise.resolve(refused),
      importShape: () => Promise.reject(new Error('この検査は読み込みを呼ばない')),
    });
    await expect(
      exchanger.exportShapes({
        format: 'stl',
        featureIds: ['sphere-1'],
        meshQuality: { deviationMm: 0.1, angularDeflectionRad: 0.2 },
        withColors: false,
        ascii: false,
        baseName: 'model',
      }),
    ).rejects.toThrow('もとになる立体が見つかりません。');
  });
});
