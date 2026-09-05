/**
 * Should 群のコマンド(`shapeEditCommands.ts`)の検査
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク50 の検証表)。
 *
 * 押せる条件(NFR-UX-5)と、確定して積まれるフィーチャーの中身を固定する。
 * `machiningCommands.test.ts` と同じひな型(手で組んだ `SubShapeBody`)を使う。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  appendSolid,
  createEmptyPartDocument,
  createPointFeature,
  DEFAULT_FACE_COLOR,
  DEFAULT_RIB_EXTEND_TO_BODY,
  findSolid,
  replaceSketch,
  type ExtrudeFeature,
  type HoleFeature,
  type PartDocument,
  type SketchDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { SolidInputCommit } from '../sketch/numericInput.js';

import type { MachiningContext } from './machiningCommands.js';
import {
  commitShapeEdit,
  shapeEditReadiness,
  shapeEditToolOf,
  type ShapeEditToolId,
} from './shapeEditCommands.js';
import { solidToolReadiness } from './solidCommands.js';
import {
  subShapeElementId,
  type SolidFaceEntry,
  type SolidVertexEntry,
  type SubShapeBody,
} from './subShapeSelection.js';

/* ------------------------------------------------------------------ *
 * ひな型
 * ------------------------------------------------------------------ */

const TEN = expressionValueFromNumber(10);

function faceEntry(index: number, surfaceKind: SolidFaceEntry['surfaceKind'] = 'plane'): SolidFaceEntry {
  return {
    index,
    surfaceKind,
    area: 100,
    centroid: [0, 0, index],
    axis: [0, 0, 1],
    radius: surfaceKind === 'cylinder' ? 5 : null,
    triangleOffset: index * 2,
    triangleCount: 2,
  };
}

function vertexEntry(index: number, position: readonly [number, number, number]): SolidVertexEntry {
  return { index, position };
}

function makeBody(
  featureId: string,
  fields: {
    readonly faces?: readonly SolidFaceEntry[];
    readonly vertices?: readonly SolidVertexEntry[];
  } = {},
): SubShapeBody {
  return {
    featureId,
    mesh: { edgePositions: new Float32Array(0) },
    faces: fields.faces ?? [faceEntry(0), faceEntry(1), faceEntry(2, 'cylinder')],
    edges: [],
    vertices: fields.vertices ?? [vertexEntry(0, [0, 0, 0]), vertexEntry(1, [1, 0, 0])],
  };
}

function extrudeFeature(id: string): ExtrudeFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance: TEN,
    reversed: false,
    symmetric: false,
  };
}

function holeFeature(id: string, targetFeatureId: string): HoleFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'hole',
    targetFeatureId,
    face: {
      bodyFeatureId: targetFeatureId,
      index: 0,
      fingerprint: {
        kind: 'face',
        surfaceKind: 'plane',
        area: 100,
        position: [0, 0, 0],
        axis: [0, 0, 1],
        radius: null,
      },
    },
    centers: [],
    diameter: TEN,
    depth: { kind: 'through' },
    tiltAngle: expressionValueFromNumber(0),
    tiltAzimuth: expressionValueFromNumber(0),
  };
}

/** スケッチへ面フィーチャーを 1 枚足す(`ruledCommands.test.ts` と同じひな型)。 */
function addFace(sketch: SketchDocument, id: string): SketchDocument {
  return appendFeature(sketch, {
    id,
    name: id,
    planeId: 'xy',
    kind: 'face',
    boundary: [],
    color: DEFAULT_FACE_COLOR,
  });
}

/** スケッチへ線分フィーチャーを 1 本足す(スイープの経路・リブの輪郭・曲面の輪郭)。 */
function addLine(sketch: SketchDocument, id: string): SketchDocument {
  return appendFeature(sketch, {
    id,
    name: id,
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(0, 0, 0),
    to: absoluteCoordinate(10, 0, 0),
    construction: false,
  });
}

interface Fixture {
  readonly document: PartDocument;
  readonly bodies: readonly SubShapeBody[];
}

/** 押し出し 1 つ(ボディ `extrude-1`)と、面 1 枚・線分 2 本を持つ部品文書。 */
function fixture(): Fixture {
  const base = createEmptyPartDocument();
  let sketch = base.sketches[0];
  sketch = addFace(sketch, 'face-1');
  sketch = addLine(sketch, 'line-1');
  sketch = addLine(sketch, 'line-2');
  const document = appendSolid(replaceSketch(base, sketch), extrudeFeature('extrude-1'));
  return { document, bodies: [makeBody('extrude-1')] };
}

function contextOf(selection: readonly string[], base: Fixture = fixture()): MachiningContext {
  return { document: base.document, bodies: base.bodies, selection };
}

const FACE_0 = subShapeElementId('extrude-1', 'face', 0);
const FACE_1 = subShapeElementId('extrude-1', 'face', 1);
const CYLINDER_FACE = subShapeElementId('extrude-1', 'face', 2);
const VERTEX_0 = subShapeElementId('extrude-1', 'vertex', 0);
const VERTEX_1 = subShapeElementId('extrude-1', 'vertex', 1);

function commitOf(overrides: Partial<SolidInputCommit> = {}): SolidInputCommit {
  return {
    kind: 'solid',
    tool: 'draft',
    step: 'draftAngle',
    values: {},
    flags: {},
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 押せる条件(タスク50 の検証表)
 * ------------------------------------------------------------------ */

describe('Should 群の押せる条件(タスク50、NFR-UX-5)', () => {
  const TOOLS: readonly ShapeEditToolId[] = [
    'draft',
    'mirrorSolid',
    'transform',
    'scale',
    'sweep',
    'rib',
    'emboss',
    'threadShaft',
    'surface',
    'pointPattern',
    'shell',
  ];

  it('11 の道具すべてが、何も選ばないと理由つきで押せない', () => {
    for (const tool of TOOLS) {
      const readiness = shapeEditReadiness(contextOf([]), tool);
      expect(readiness.ready, tool).toBe(false);
      expect(readiness.reasonKey, tool).not.toBeNull();
    }
  });

  it('抜き勾配: 面が 1 枚だと理由が出て、2 枚で押せる', () => {
    expect(shapeEditReadiness(contextOf([]), 'draft').reasonKey).toBe('shapeError.noNeutralFace');
    expect(shapeEditReadiness(contextOf([FACE_0]), 'draft').reasonKey).toBe(
      'shapeError.noDraftFace',
    );
    expect(shapeEditReadiness(contextOf([FACE_0, FACE_1]), 'draft')).toEqual({
      ready: true,
      reasonKey: null,
    });
  });

  it('抜き勾配: 基準にする 1 枚目が平らでなければ断る', () => {
    expect(shapeEditReadiness(contextOf([CYLINDER_FACE, FACE_0]), 'draft').reasonKey).toBe(
      'shapeError.noNeutralFace',
    );
  });

  it('ミラー・移動/回転・拡大縮小・くり抜き: 立体 1 つで押せる', () => {
    for (const tool of ['mirrorSolid', 'transform', 'scale', 'shell'] as const) {
      expect(shapeEditReadiness(contextOf([]), tool).reasonKey, tool).toBe(
        'shapeError.noTargetBody',
      );
      expect(shapeEditReadiness(contextOf(['extrude-1']), tool).ready, tool).toBe(true);
    }
  });

  it('ミラー: 立体を 2 つ選ぶと決まらないので押せない', () => {
    const base = fixture();
    const two = appendSolid(base.document, extrudeFeature('extrude-2'));
    const context: MachiningContext = {
      document: two,
      bodies: [...base.bodies, makeBody('extrude-2')],
      selection: ['extrude-1', 'extrude-2'],
    };
    expect(shapeEditReadiness(context, 'mirrorSolid').reasonKey).toBe('shapeError.noTargetBody');
  });

  it('スイープ: 断面 1 + 経路 1 が要る', () => {
    expect(shapeEditReadiness(contextOf(['line-1']), 'sweep').reasonKey).toBe(
      'shapeError.noProfile',
    );
    expect(shapeEditReadiness(contextOf(['face-1']), 'sweep').reasonKey).toBe('shapeError.noPath');
    expect(shapeEditReadiness(contextOf(['face-1', 'line-1']), 'sweep').ready).toBe(true);
  });

  it('リブ: 立体 1 + 輪郭 1 が要る', () => {
    expect(shapeEditReadiness(contextOf(['line-1']), 'rib').reasonKey).toBe(
      'shapeError.noTargetBody',
    );
    expect(shapeEditReadiness(contextOf(['extrude-1']), 'rib').reasonKey).toBe(
      'shapeError.noProfile',
    );
    expect(shapeEditReadiness(contextOf(['extrude-1', 'line-1']), 'rib').ready).toBe(true);
  });

  it('エンボス: 平らな面 1 + 輪郭 1 が要る', () => {
    expect(shapeEditReadiness(contextOf(['face-1']), 'emboss').reasonKey).toBe(
      'shapeError.noFlatFace',
    );
    expect(shapeEditReadiness(contextOf([FACE_0]), 'emboss').reasonKey).toBe(
      'shapeError.noProfile',
    );
    expect(shapeEditReadiness(contextOf([FACE_0, 'face-1']), 'emboss').ready).toBe(true);
  });

  it('外ねじ: 平らな面を選んだら理由が出て、円柱面で押せる', () => {
    expect(shapeEditReadiness(contextOf([FACE_0]), 'threadShaft').reasonKey).toBe(
      'shapeError.notCylinderFace',
    );
    expect(shapeEditReadiness(contextOf([CYLINDER_FACE]), 'threadShaft').ready).toBe(true);
  });

  it('曲面: 輪郭でも立体の面でも押せる', () => {
    expect(shapeEditReadiness(contextOf([]), 'surface').reasonKey).toBe(
      'shapeError.noSurfaceSource',
    );
    expect(shapeEditReadiness(contextOf(['line-1']), 'surface').ready).toBe(true);
    expect(shapeEditReadiness(contextOf([FACE_0]), 'surface').ready).toBe(true);
  });

  it('点集合パターン: 加工 1 + 点 2 つ以上が要る', () => {
    const base = fixture();
    const withHole = appendSolid(base.document, holeFeature('hole-1', 'extrude-1'));
    const withPoints = ((): PartDocument => {
      let document = withHole;
      const sketch = document.sketches[0];
      const p1 = createPointFeature(sketch, absoluteCoordinate(0, 0, 0));
      const withP1 = appendFeature(sketch, p1);
      const p2 = createPointFeature(withP1, absoluteCoordinate(5, 0, 0));
      document = replaceSketch(document, appendFeature(withP1, p2));
      return document;
    })();
    const bodies = [...base.bodies, makeBody('hole-1')];
    const readinessOf = (selection: readonly string[]): string | null =>
      shapeEditReadiness({ document: withPoints, bodies, selection }, 'pointPattern').reasonKey;
    expect(readinessOf([])).toBe('shapeError.noPatternSource');
    // 穴でない立体(押し出し)を選んでも「並べる加工」にはならない。
    expect(readinessOf(['extrude-1'])).toBe('shapeError.noPatternSource');
    expect(readinessOf(['hole-1'])).toBe('shapeError.noPatternPoints');
    expect(readinessOf(['hole-1', 'point-1'])).toBe('shapeError.noPatternPoints');
    expect(readinessOf(['hole-1', 'point-1', 'point-2'])).toBeNull();
  });

  it('`solidToolReadiness` から同じ判定が引ける(判定を 2 か所に置かない)', () => {
    const base = fixture();
    for (const tool of TOOLS) {
      const direct = shapeEditReadiness(contextOf(['extrude-1'], base), tool);
      const viaToolbar = solidToolReadiness(base.document, ['extrude-1'], tool, base.bodies);
      expect(viaToolbar, tool).toEqual(direct);
    }
  });

  it('道具 id の絞り込みは Should 群だけを通す', () => {
    for (const tool of TOOLS) {
      expect(shapeEditToolOf(tool), tool).toBe(tool);
    }
    for (const other of ['extrude', 'hole', 'cut', 'measure', 'unknown']) {
      expect(shapeEditToolOf(other), other).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 確定(積まれるフィーチャーの中身)
 * ------------------------------------------------------------------ */

describe('Should 群の確定(タスク50)', () => {
  it('何も選ばずに確定すると、どの道具も履歴を 1 つも変えない', () => {
    const base = fixture();
    for (const tool of [
      'draft',
      'mirrorSolid',
      'transform',
      'scale',
      'sweep',
      'rib',
      'emboss',
      'threadShaft',
      'surface',
      'pointPattern',
      'shell',
    ] as const) {
      const outcome = commitShapeEdit(contextOf([], base), commitOf({ tool }), tool);
      expect(outcome.ok, tool).toBe(false);
      expect(base.document.solids).toHaveLength(1);
    }
  });

  it('抜き勾配: 1 枚目が基準の面、残りが傾ける面になる(FR-417)', () => {
    const outcome = commitShapeEdit(
      contextOf([FACE_0, FACE_1]),
      commitOf({ values: { draftAngle: expressionValueFromNumber(3) }, flags: { reversed: true } }),
      'draft',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind).toBe('draft');
    if (feature?.kind !== 'draft') {
      return;
    }
    expect(feature.targetFeatureId).toBe('extrude-1');
    expect(feature.neutralFace.index).toBe(0);
    expect(feature.faces.map((face) => face.index)).toEqual([1]);
    expect(feature.angle.value).toBe(3);
    expect(feature.reversed).toBe(true);
  });

  it('ミラー: 選択肢の文字列が基準平面へ読み替わる(FR-419)', () => {
    const outcome = commitShapeEdit(
      contextOf(['extrude-1']),
      commitOf({ tool: 'mirrorSolid', shapeChoices: { mirrorPlane: 'xz' } }),
      'mirrorSolid',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind).toBe('mirror');
    if (feature?.kind !== 'mirror') {
      return;
    }
    expect(feature.plane).toEqual({ kind: 'workPlane', planeId: 'xz' });
    expect(feature.targetFeatureId).toBe('extrude-1');
  });

  it('ミラー: 「選んだ面」は平らな面が要る。既定は XY 面(§0.a-0.36)', () => {
    const noFace = commitShapeEdit(
      contextOf(['extrude-1']),
      commitOf({ tool: 'mirrorSolid', shapeChoices: { mirrorPlane: 'face' } }),
      'mirrorSolid',
    );
    expect(noFace).toEqual({ ok: false, reasonKey: 'shapeError.noFlatFace' });

    const withFace = commitShapeEdit(
      contextOf([FACE_0]),
      commitOf({ tool: 'mirrorSolid', shapeChoices: { mirrorPlane: 'face' } }),
      'mirrorSolid',
    );
    expect(withFace.ok).toBe(true);

    const fallback = commitShapeEdit(
      contextOf(['extrude-1']),
      commitOf({ tool: 'mirrorSolid' }),
      'mirrorSolid',
    );
    expect(fallback.ok).toBe(true);
    if (!fallback.ok) {
      return;
    }
    const feature = findSolid(fallback.document, fallback.featureId);
    expect(feature?.kind === 'mirror' ? feature.plane : null).toEqual({
      kind: 'workPlane',
      planeId: 'xy',
    });
  });

  it('ミラー: 知らない選択肢の値は断る(黙って既定へ落とさない)', () => {
    expect(
      commitShapeEdit(
        contextOf(['extrude-1']),
        commitOf({ tool: 'mirrorSolid', shapeChoices: { mirrorPlane: 'ななめ' } }),
        'mirrorSolid',
      ),
    ).toEqual({ ok: false, reasonKey: 'shapeError.unknownChoice' });
  });

  it('移動/回転: 角度 0 なら回す軸を持たない(FR-424)', () => {
    const outcome = commitShapeEdit(
      contextOf(['extrude-1']),
      commitOf({
        tool: 'transform',
        values: {
          translationX: expressionValueFromNumber(5),
          translationY: expressionValueFromNumber(-3),
        },
      }),
      'transform',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind).toBe('transform');
    if (feature?.kind !== 'transform') {
      return;
    }
    expect(feature.translation.map((value) => value.value)).toEqual([5, -3, 0]);
    expect(feature.rotationAxis).toBeNull();
    expect(feature.rotationAngle.value).toBe(0);
  });

  it('移動/回転: 角度を入れると軸が入る(既定は Z)', () => {
    const outcome = commitShapeEdit(
      contextOf(['extrude-1']),
      commitOf({
        tool: 'transform',
        values: { rotationAngle: expressionValueFromNumber(90) },
      }),
      'transform',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind === 'transform' ? feature.rotationAxis : null).toEqual({
      kind: 'world',
      axis: 'z',
    });
  });

  it('拡大縮小: つまみで全体の倍率と軸ごとの倍率が入れ替わる(FR-424)', () => {
    const uniform = commitShapeEdit(
      contextOf(['extrude-1']),
      commitOf({ tool: 'scale', values: { scaleFactor: expressionValueFromNumber(3) } }),
      'scale',
    );
    expect(uniform.ok).toBe(true);
    if (uniform.ok) {
      const feature = findSolid(uniform.document, uniform.featureId);
      expect(feature?.kind === 'scale' ? feature.factor : null).toEqual({
        kind: 'uniform',
        value: expressionValueFromNumber(3),
      });
    }

    const perAxis = commitShapeEdit(
      contextOf(['extrude-1']),
      commitOf({
        tool: 'scale',
        flags: { scalePerAxis: true },
        values: {
          scaleX: expressionValueFromNumber(2),
          scaleY: expressionValueFromNumber(3),
          scaleZ: expressionValueFromNumber(4),
        },
      }),
      'scale',
    );
    expect(perAxis.ok).toBe(true);
    if (!perAxis.ok) {
      return;
    }
    const feature = findSolid(perAxis.document, perAxis.featureId);
    expect(feature?.kind === 'scale' ? feature.factor.kind : null).toBe('perAxis');
  });

  it('スイープ: 断面はスケッチの面、経路は線の連なりになる(FR-409)', () => {
    const outcome = commitShapeEdit(
      contextOf(['face-1', 'line-1', 'line-2']),
      commitOf({ tool: 'sweep', flags: { sweepFrenet: true } }),
      'sweep',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind).toBe('sweep');
    if (feature?.kind !== 'sweep') {
      return;
    }
    expect(feature.profile.faceFeatureId).toBe('face-1');
    expect(feature.path.curveIds).toEqual(['line-1', 'line-2']);
    expect(feature.frenet).toBe(true);
  });

  it('リブ: 厚みと側を持ち、材料へ届くまで伸ばす既定になる(FR-420)', () => {
    const outcome = commitShapeEdit(
      contextOf(['extrude-1', 'line-1']),
      commitOf({
        tool: 'rib',
        values: { ribThickness: expressionValueFromNumber(4) },
        shapeChoices: { ribSide: 'positive' },
      }),
      'rib',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind).toBe('rib');
    if (feature?.kind !== 'rib') {
      return;
    }
    expect(feature.thickness.value).toBe(4);
    expect(feature.side).toBe('positive');
    expect(feature.extendToBody).toBe(DEFAULT_RIB_EXTEND_TO_BODY);
  });

  it('エンボス: 平らな面と輪郭を持ち、既定は彫る(FR-421)', () => {
    const outcome = commitShapeEdit(
      contextOf([FACE_0, 'face-1']),
      commitOf({ tool: 'emboss', values: { embossHeight: expressionValueFromNumber(2) } }),
      'emboss',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind).toBe('emboss');
    if (feature?.kind !== 'emboss') {
      return;
    }
    expect(feature.face.index).toBe(0);
    expect(feature.profile.faceFeatureId).toBe('face-1');
    expect(feature.height.value).toBe(2);
    expect(feature.raised).toBe(false);
  });

  it('外ねじ: 呼びからピッチが入り、径は聞かない(FR-423、NFR-UX-4)', () => {
    const outcome = commitShapeEdit(
      contextOf([CYLINDER_FACE]),
      commitOf({
        tool: 'threadShaft',
        threadDesignation: 'M10',
        threadSeries: 'coarse',
        shapeChoices: { threadShaftEnd: 'last' },
      }),
      'threadShaft',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind).toBe('threadShaft');
    if (feature?.kind !== 'threadShaft') {
      return;
    }
    expect(feature.nominal).toBe('M10');
    // M10 並目のピッチは 1.5mm(規格表から入る。同じ数を 2 か所に書かない)。
    expect(feature.pitch.value).toBe(1.5);
    expect(feature.fromEnd).toBe('last');
    expect(feature.modeled).toBe(false);
    expect(feature.length.value).toBe(20);
  });

  it('曲面: 作り方ごとに要る材料が違い、足りなければ断る(FR-428)', () => {
    const base = fixture();
    const extrude = commitShapeEdit(
      contextOf(['line-1'], base),
      commitOf({ tool: 'surface', shapeChoices: { surfaceOperation: 'extrude' } }),
      'surface',
    );
    expect(extrude.ok).toBe(true);

    const loftTooFew = commitShapeEdit(
      contextOf(['line-1'], base),
      commitOf({ tool: 'surface', shapeChoices: { surfaceOperation: 'loft' } }),
      'surface',
    );
    expect(loftTooFew).toEqual({ ok: false, reasonKey: 'shapeError.noProfile' });

    const loft = commitShapeEdit(
      contextOf(['line-1', 'line-2'], base),
      commitOf({ tool: 'surface', shapeChoices: { surfaceOperation: 'loft' } }),
      'surface',
    );
    expect(loft.ok).toBe(true);

    const faceOnly = commitShapeEdit(
      contextOf(['line-1'], base),
      commitOf({ tool: 'surface', shapeChoices: { surfaceOperation: 'face' } }),
      'surface',
    );
    expect(faceOnly).toEqual({ ok: false, reasonKey: 'shapeError.noSurfaceSource' });
  });

  it('曲面: 「立体の面を離す」は対象を消費しない参照だけを持つ(§0.a-0.45)', () => {
    const outcome = commitShapeEdit(
      contextOf([FACE_0]),
      commitOf({
        tool: 'surface',
        shapeChoices: { surfaceOperation: 'offset' },
        values: { surfaceOffset: expressionValueFromNumber(3) },
      }),
      'surface',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind).toBe('surface');
    if (feature?.kind !== 'surface' || feature.operation.kind !== 'offset') {
      return;
    }
    expect(feature.operation.targetFeatureId).toBe('extrude-1');
    expect(feature.operation.distance.value).toBe(3);
  });

  it('曲面: 知らない作り方は断る', () => {
    expect(
      commitShapeEdit(
        contextOf(['line-1']),
        commitOf({ tool: 'surface', shapeChoices: { surfaceOperation: 'ねじる' } }),
        'surface',
      ),
    ).toEqual({ ok: false, reasonKey: 'shapeError.unknownChoice' });
  });

  it('点集合パターン: 点の一覧がそのまま置き場所になる(FR-425)', () => {
    const base = fixture();
    let document = appendSolid(base.document, holeFeature('hole-1', 'extrude-1'));
    const sketch = document.sketches[0];
    const p1 = createPointFeature(sketch, absoluteCoordinate(0, 0, 0));
    const withP1 = appendFeature(sketch, p1);
    const p2 = createPointFeature(withP1, absoluteCoordinate(5, 0, 0));
    document = replaceSketch(document, appendFeature(withP1, p2));
    const context: MachiningContext = {
      document,
      bodies: [...base.bodies, makeBody('hole-1')],
      selection: ['hole-1', p1.id, p2.id, VERTEX_0],
    };
    const outcome = commitShapeEdit(context, commitOf({ tool: 'pointPattern' }), 'pointPattern');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind).toBe('pattern');
    if (feature?.kind !== 'pattern' || feature.placement.kind !== 'points') {
      return;
    }
    expect(feature.sourceFeatureId).toBe('hole-1');
    expect(feature.placement.points).toHaveLength(3);
    expect(feature.placement.points[0]).toEqual({ kind: 'point', pointId: p1.id });
    // 立体の頂点も置き場所にできる(座標を写さず参照で持つ)。
    expect(feature.placement.points[2]?.kind).toBe('subShape');
  });

  it('くり抜き: 開ける面 0 枚でも作れる(§2.12、タスク53 の実測)', () => {
    const closed = commitShapeEdit(
      contextOf(['extrude-1']),
      commitOf({ tool: 'shell', values: { shellThickness: expressionValueFromNumber(2) } }),
      'shell',
    );
    expect(closed.ok).toBe(true);
    if (!closed.ok) {
      return;
    }
    const feature = findSolid(closed.document, closed.featureId);
    expect(feature?.kind).toBe('shell');
    if (feature?.kind !== 'shell') {
      return;
    }
    expect(feature.openFaces).toEqual([]);
    expect(feature.thickness.value).toBe(2);
    expect(feature.outward).toBe(false);
  });

  it('くり抜き: 選んだ面が開ける面になる', () => {
    const outcome = commitShapeEdit(
      contextOf([FACE_0, FACE_1]),
      commitOf({ tool: 'shell' }),
      'shell',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind === 'shell' ? feature.openFaces.map((face) => face.index) : null).toEqual([
      0, 1,
    ]);
  });

  it('確定は履歴を 1 段だけ積み、元の文書を書き換えない(FR-505)', () => {
    const base = fixture();
    const outcome = commitShapeEdit(
      contextOf(['extrude-1'], base),
      commitOf({ tool: 'shell' }),
      'shell',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.document.solids).toHaveLength(2);
    expect(base.document.solids).toHaveLength(1);
  });

  it('名前と id は種類ごとの連番になる(FR-501)', () => {
    const base = fixture();
    const first = commitShapeEdit(contextOf(['extrude-1'], base), commitOf({ tool: 'shell' }), 'shell');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.featureId).toBe('shell-1');
    // 1 つ目のくり抜きが `extrude-1` を消費するので、2 つ目の対象は `shell-1` になる。
    const second = commitShapeEdit(
      { document: first.document, bodies: base.bodies, selection: ['shell-1'] },
      commitOf({ tool: 'shell' }),
      'shell',
    );
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.featureId).toBe('shell-2');
    expect(findSolid(second.document, 'shell-2')?.name).toBe('くり抜き2');
  });

  it('頂点だけを選んでいても、その立体が対象になる(部分形状からの絞り込み)', () => {
    const outcome = commitShapeEdit(
      contextOf([VERTEX_0, VERTEX_1]),
      commitOf({ tool: 'transform' }),
      'transform',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind === 'transform' ? feature.targetFeatureId : null).toBe('extrude-1');
  });
});
