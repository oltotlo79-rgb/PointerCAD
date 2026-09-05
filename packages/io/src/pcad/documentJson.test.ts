import {
  createEmptyPartDocument,
  createPrimitiveFeature,
  emptyAppearanceTable,
  PART_SCHEMA_VERSION,
  resolveSketch,
  sketchConstraints,
  type AppearanceTable,
  type PartDocument,
  type Parameter,
  type PrimitiveFeature,
  type PrimitiveShape,
  type ReferenceFeature,
  type SketchConstraint,
  type SketchDocument,
  type SketchFeature,
  type SolidFeature,
  type SolidOrigin,
  type SubShapeRef,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  parseDocument,
  serializeDocument,
  type ParseDocumentResult,
  type ParseError,
} from './documentJson.js';
import type { ExpressionValueJson } from './guards.js';
import {
  PCAD_APP_NAME,
  PCAD_DOCUMENT_KIND,
  PCAD_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
} from './schema.js';

/** 検査で時刻を固定する(保存時刻が違っても文字列が同じであることを確かめるため)。 */
const SAVED_AT = '2026-09-03T01:23:45.678Z';

/** 式文字列と評価値の組(FR-202)。 */
function ev(source: string, value: number): ExpressionValueJson {
  return { source, value, display: String(value) };
}

/** 5 種類のスケッチフィーチャーと 3 種類の座標指定、4 種類の基準を全部入れたスケッチ。 */
function richSketch(): SketchDocument {
  return {
    id: 'sketch-1',
    name: 'スケッチ1',
    features: [
      {
        id: 'point-1',
        kind: 'point',
        name: '点1',
        planeId: 'xy',
        at: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      },
      {
        id: 'line-1',
        kind: 'line',
        name: '線分1',
        planeId: 'xy',
        from: {
          mode: 'relative',
          base: { kind: 'previous' },
          dx: ev('40', 40),
          dy: ev('0', 0),
          dz: ev('0', 0),
        },
        to: {
          mode: 'polar',
          base: { kind: 'point', pointId: 'point-1' },
          distance: ev('30', 30),
          azimuth: ev('90', 90),
          elevation: ev('0', 0),
        },
        construction: false,
      },
      {
        id: 'arc-1',
        kind: 'arc',
        name: '円弧1',
        planeId: 'xz',
        center: {
          mode: 'relative',
          base: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
          dx: ev('1', 1),
          dy: ev('2', 2),
          dz: ev('3', 3),
        },
        radius: ev('5*2', 10),
        startAngle: ev('0', 0),
        endAngle: ev('360', 360),
        construction: false,
      },
      {
        id: 'pointArray-1',
        kind: 'pointArray',
        name: '点列1',
        planeId: 'yz',
        layout: {
          kind: 'linear',
          base: {
            mode: 'relative',
            base: { kind: 'origin' },
            dx: ev('0', 0),
            dy: ev('0', 0),
            dz: ev('0', 0),
          },
          azimuth: ev('45', 45),
          spacing: ev('10', 10),
          count: ev('4', 4),
        },
      },
      {
        id: 'face-1',
        kind: 'face',
        name: '面1',
        planeId: 'xy',
        boundary: [{ featureId: 'line-1' }, { featureId: 'pointArray-1', index: 2 }],
        color: '#7aa2f7',
      },
    ],
    // 拘束14種すべて(FR-313、P4b タスク21)。往復で id・名前・対象・目標値の式が保たれることを
    // この一覧で確かめる(documentJson.test.ts の「拘束の往復」節)。
    constraints: richConstraints(),
  };
}

/** 拘束14種すべて(FR-313)。`richSketch` の要素(point-1・line-1・arc-1)を指す。 */
function richConstraints(): readonly SketchConstraint[] {
  return [
    {
      id: 'coincident-1',
      name: '一致1',
      kind: 'coincident',
      a: { kind: 'point', pointId: 'point-1' },
      b: { kind: 'vertex', featureId: 'line-1', vertex: 'start' },
    },
    {
      id: 'horizontal-1',
      name: '水平1',
      kind: 'horizontal',
      target: { kind: 'curve', element: { featureId: 'line-1' } },
    },
    {
      id: 'vertical-1',
      name: '垂直1',
      kind: 'vertical',
      target: { kind: 'curve', element: { featureId: 'line-1' } },
    },
    {
      id: 'parallel-1',
      name: '平行1',
      kind: 'parallel',
      a: { kind: 'curve', element: { featureId: 'line-1' } },
      b: { kind: 'curve', element: { featureId: 'arc-1' } },
    },
    {
      id: 'perpendicular-1',
      name: '直角1',
      kind: 'perpendicular',
      a: { kind: 'curve', element: { featureId: 'line-1' } },
      b: { kind: 'curve', element: { featureId: 'arc-1' } },
    },
    {
      id: 'tangent-1',
      name: '接線1',
      kind: 'tangent',
      line: { kind: 'curve', element: { featureId: 'line-1' } },
      circle: { kind: 'curve', element: { featureId: 'arc-1' } },
    },
    {
      id: 'concentric-1',
      name: '同心1',
      kind: 'concentric',
      a: { kind: 'vertex', featureId: 'arc-1', vertex: 'center' },
      b: { kind: 'point', pointId: 'point-1' },
    },
    {
      id: 'equal-1',
      name: '等しい1',
      kind: 'equal',
      a: { kind: 'curve', element: { featureId: 'line-1' } },
      b: { kind: 'curve', element: { featureId: 'arc-1' } },
    },
    {
      id: 'symmetric-1',
      name: '対称1',
      kind: 'symmetric',
      a: { kind: 'point', pointId: 'point-1' },
      b: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
      axis: { featureId: 'arc-1' },
    },
    {
      id: 'fix-1',
      name: '固定1',
      kind: 'fix',
      target: { kind: 'point', pointId: 'point-1' },
    },
    {
      id: 'distance-1',
      name: '距離1',
      kind: 'distance',
      a: { kind: 'vertex', featureId: 'line-1', vertex: 'start' },
      b: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
      length: ev('幅 / 2', 20),
    },
    {
      id: 'angle-1',
      name: '角度1',
      kind: 'angle',
      a: { kind: 'curve', element: { featureId: 'line-1' } },
      b: { kind: 'curve', element: { featureId: 'arc-1' } },
      angle: ev('30', 30),
    },
    {
      id: 'radius-1',
      name: '半径1',
      kind: 'radius',
      target: { kind: 'curve', element: { featureId: 'arc-1' } },
      size: ev('5*2', 10),
    },
    {
      id: 'diameter-1',
      name: '直径1',
      kind: 'diameter',
      target: { kind: 'curve', element: { featureId: 'arc-1' } },
      size: ev('12', 12),
    },
  ];
}

/** 検査で使う面の指紋(P3 §2.2.2)。 */
function faceRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [0, 0, 10],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

/** 検査で使うまっすぐな辺の指紋(P3 §2.2.2)。 */
function edgeRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'edge',
      curveKind: 'line',
      length: 40,
      position: [20, 0, 0],
      axis: [1, 0, 0],
      radius: null,
    },
  };
}

/**
 * 基準ジオメトリ 4 種(FR-328、FR-329)と、平面の決め方 7 種すべて。
 * 基準軸の決め方 4 種・基準点の決め方 4 種・軸の指定 3 種(world / line / reference)も含める。
 */
function richReferences(): readonly ReferenceFeature[] {
  return [
    {
      id: 'referencePoint-1',
      kind: 'referencePoint',
      name: '基準点1',
      visible: true,
      definition: {
        kind: 'coordinate',
        at: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('5', 5) },
      },
    },
    {
      id: 'referencePoint-2',
      kind: 'referencePoint',
      name: '基準点2',
      visible: false,
      definition: {
        kind: 'vertex',
        vertex: { bodyFeatureId: 'extrude-1', index: 1, fingerprint: { kind: 'vertex', position: [1, 2, 3] } },
      },
    },
    {
      id: 'referencePoint-3',
      kind: 'referencePoint',
      name: '基準点3',
      visible: true,
      definition: { kind: 'edgeMidpoint', edge: edgeRef('extrude-1', 2) },
    },
    {
      id: 'referencePoint-4',
      kind: 'referencePoint',
      name: '基準点4',
      visible: true,
      definition: { kind: 'faceCenter', face: faceRef('extrude-1', 3) },
    },
    {
      id: 'referenceAxis-1',
      kind: 'referenceAxis',
      name: '基準軸1',
      visible: true,
      definition: { kind: 'twoPoints', from: { kind: 'origin' }, to: { kind: 'point', pointId: 'point-1' } },
    },
    {
      id: 'referenceAxis-2',
      kind: 'referenceAxis',
      name: '基準軸2',
      visible: false,
      definition: { kind: 'edge', edge: edgeRef('extrude-1', 4) },
    },
    {
      id: 'referenceAxis-3',
      kind: 'referenceAxis',
      name: '基準軸3',
      visible: true,
      definition: { kind: 'faceNormal', face: faceRef('extrude-1', 5) },
    },
    {
      id: 'referenceAxis-4',
      kind: 'referenceAxis',
      name: '基準軸4',
      visible: true,
      definition: {
        kind: 'faceIntersection',
        face1: faceRef('extrude-1', 6),
        face2: faceRef('extrude-1', 7),
      },
    },
    {
      id: 'referencePlane-1',
      kind: 'referencePlane',
      name: '作業平面1',
      visible: true,
      plane: {
        kind: 'threePoints',
        p1: { kind: 'origin' },
        p2: { kind: 'point', pointId: 'point-1' },
        p3: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
      },
    },
    {
      id: 'referencePlane-2',
      kind: 'referencePlane',
      name: '作業平面2',
      visible: false,
      plane: { kind: 'pointAndEdge', point: { kind: 'origin' }, edge: edgeRef('extrude-1', 8), mode: 'containing' },
    },
    {
      id: 'referencePlane-3',
      kind: 'referencePlane',
      name: '作業平面3',
      visible: true,
      plane: {
        kind: 'pointAndAxis',
        point: { kind: 'origin' },
        axis: { kind: 'reference', referenceFeatureId: 'referenceAxis-1' },
        tilt: ev('30', 30),
        azimuth: ev('0', 0),
      },
    },
    {
      id: 'referencePlane-4',
      kind: 'referencePlane',
      name: '作業平面4',
      visible: true,
      plane: { kind: 'pointAndParallelFace', point: { kind: 'origin' }, face: faceRef('extrude-1', 9) },
    },
    {
      id: 'referencePlane-5',
      kind: 'referencePlane',
      name: '作業平面5',
      visible: true,
      plane: { kind: 'face', face: faceRef('extrude-1', 10), offset: ev('5', 5) },
    },
    {
      id: 'referencePlane-6',
      kind: 'referencePlane',
      name: '作業平面6',
      visible: true,
      plane: { kind: 'workPlane', planeId: 'xy', offset: ev('10', 10) },
    },
    {
      id: 'referencePlane-7',
      kind: 'referencePlane',
      name: '作業平面7',
      visible: true,
      plane: {
        kind: 'tilted',
        base: 'referencePlane-6',
        axis: { kind: 'world', axis: 'x' },
        angle: ev('45', 45),
      },
    },
    {
      id: 'referenceCoordinateSystem-1',
      kind: 'referenceCoordinateSystem',
      name: '座標系1',
      visible: true,
      origin: { kind: 'origin' },
      xAxis: { kind: 'world', axis: 'x' },
      yAxis: { kind: 'line', line: { sketchId: 'sketch-1', lineFeatureId: 'line-1' } },
    },
  ];
}

/**
 * 10 種類のソリッドフィーチャー(P2 の4種 + P3 の加工5種・ばね)と、2 種類の回転軸。
 * 部分形状の指紋は面・辺・頂点の3種類、辺の指紋は軸ありと軸なし(§2.2.2)の両方を含める。
 */
function richSolids(): readonly SolidFeature[] {
  return [
    {
      id: 'extrude-1',
      kind: 'extrude',
      name: '押し出し1',
      suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      distance: ev('5*2', 10),
      reversed: false,
      symmetric: true,
    },
    {
      id: 'revolve-1',
      kind: 'revolve',
      name: '回転1',
      suppressed: true,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      axis: { kind: 'world', axis: 'z' },
      angle: ev('360', 360),
      reversed: false,
    },
    {
      id: 'revolve-2',
      kind: 'revolve',
      name: '回転2',
      suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      axis: { kind: 'line', line: { sketchId: 'sketch-1', lineFeatureId: 'line-1' } },
      angle: ev('90', 90),
      reversed: true,
    },
    {
      id: 'sew-1',
      kind: 'sew',
      name: '縫合1',
      suppressed: false,
      faces: [
        { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
        { sketchId: 'sketch-1', faceFeatureId: 'face-2' },
      ],
      tolerance: ev('0.01', 0.01),
    },
    {
      id: 'union-1',
      kind: 'boolean',
      name: '和1',
      suppressed: false,
      operation: 'union',
      targetFeatureId: 'extrude-1',
      toolFeatureId: 'sew-1',
    },
    {
      id: 'hole-1',
      kind: 'hole',
      name: '穴1',
      suppressed: false,
      targetFeatureId: 'union-1',
      face: {
        bodyFeatureId: 'union-1',
        index: 3,
        fingerprint: {
          kind: 'face',
          surfaceKind: 'plane',
          area: 1200,
          position: [0, 0, 10],
          axis: [0, 0, 1],
          radius: null,
        },
      },
      centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
      diameter: ev('6', 6),
      depth: { kind: 'blind', depth: ev('10', 10) },
      tiltAngle: ev('0', 0),
      tiltAzimuth: ev('0', 0),
    },
    {
      id: 'threadHole-1',
      kind: 'threadHole',
      name: 'ねじ穴1',
      suppressed: false,
      targetFeatureId: 'hole-1',
      face: {
        bodyFeatureId: 'hole-1',
        index: 5,
        fingerprint: {
          kind: 'face',
          surfaceKind: 'cylinder',
          area: 314.159265,
          position: [5, 5, 5],
          axis: [0, 0, 1],
          radius: 8,
        },
      },
      centers: [
        { sketchId: 'sketch-1', pointFeatureId: 'point-1' },
        { sketchId: 'sketch-1', pointFeatureId: 'pointArray-1' },
      ],
      designation: 'M6',
      series: 'coarse',
      pitch: ev('1', 1),
      drillDiameter: ev('5.16', 5.16),
      depth: { kind: 'through' },
      threadLength: ev('10', 10),
      representation: 'simplified',
      tiltAngle: ev('5', 5),
      tiltAzimuth: ev('45', 45),
    },
    {
      id: 'fillet-1',
      kind: 'fillet',
      name: 'R面取り1',
      suppressed: false,
      targetFeatureId: 'threadHole-1',
      targets: [
        {
          bodyFeatureId: 'threadHole-1',
          index: 2,
          fingerprint: {
            kind: 'edge',
            curveKind: 'line',
            length: 20,
            position: [1, 2, 3],
            axis: [1, 0, 0],
            radius: null,
          },
        },
        {
          bodyFeatureId: 'threadHole-1',
          index: 6,
          // 自由曲面・その他の辺は軸が求まらないので null(§2.2.2、往復で undefined にならないことを検査)。
          fingerprint: {
            kind: 'edge',
            curveKind: 'other',
            length: 12.5,
            position: [0, 0, 0],
            axis: null,
            radius: null,
          },
        },
        {
          bodyFeatureId: 'threadHole-1',
          index: 7,
          fingerprint: { kind: 'vertex', position: [4, 5, 6] },
        },
      ],
      radius: ev('2', 2),
    },
    {
      id: 'chamfer-1',
      kind: 'chamfer',
      name: 'C面取り1',
      suppressed: false,
      targetFeatureId: 'fillet-1',
      targets: [
        {
          bodyFeatureId: 'fillet-1',
          index: 0,
          fingerprint: {
            kind: 'edge',
            curveKind: 'circle',
            length: 31.415926536,
            position: [2, 2, 2],
            axis: [0, 1, 0],
            radius: 5,
          },
        },
      ],
      size: { kind: 'equal', distance: ev('1', 1) },
      swapReferenceFace: false,
    },
    {
      id: 'linearPattern-1',
      kind: 'pattern',
      name: '直線パターン1',
      suppressed: false,
      sourceFeatureId: 'hole-1',
      placement: {
        kind: 'linear',
        direction: { kind: 'world', axis: 'x' },
        spacing: ev('20', 20),
        count: ev('3', 3),
        symmetric: false,
      },
    },
    {
      id: 'spring-1',
      kind: 'spring',
      name: 'ばね1',
      suppressed: false,
      origin: { sketchId: 'sketch-1', pointFeatureId: 'point-1' },
      axis: { kind: 'line', line: { sketchId: 'sketch-1', lineFeatureId: 'line-1' } },
      tiltAngle: ev('3', 3),
      tiltAzimuth: ev('30', 30),
      length: ev('20', 20),
      pitch: ev('5', 5),
      turns: ev('4', 4),
      derived: 'length',
      coilDiameter: ev('20', 20),
      wireDiameter: ev('2', 2),
      handedness: 'right',
    },
  ];
}

function richDocument(): PartDocument {
  return {
    id: 'part-1',
    name: '部品1',
    schemaVersion: PART_SCHEMA_VERSION,
    sketches: [richSketch()],
    activeSketchId: 'sketch-1',
    references: richReferences(),
    solids: richSolids(),
    // パラメータ表(FR-207、P4b タスク21)。3件・日本語の名前・並び順を含む。
    parameters: richParameters(),
    // 外観の割り当て(FR-1106〜1110、P5 タスク5)。立体1つと面1枚、プリセットと個別調整を
    // 両方含む。
    appearance: richAppearance(),
  };
}

/** パラメータ3件(FR-207)。日本語の名前と、他のパラメータを参照する式を含む。 */
function richParameters(): readonly Parameter[] {
  return [
    { name: '板厚', value: ev('3', 3), unit: 'mm', description: '板の厚み' },
    { name: '個数', value: ev('板厚 + 1', 4), unit: 'none', description: '' },
    { name: '角度', value: ev('30', 30), unit: 'degree', description: '傾き' },
  ];
}

/** 面 1 枚の参照(union-1 の面。P3 の指紋と同じ形)。外観の面割り当ての検査に使う。 */
function richAppearanceFaceRef(): SubShapeRef {
  return {
    bodyFeatureId: 'union-1',
    index: 2,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 800,
      position: [0, 0, 5],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

/**
 * 外観の割り当て2件(FR-1106〜1110)。立体1つ(鉄板プリセット)と面1枚(個別調整・
 * 木目の柄・透過率は式のまま(`50*2`))を両方含む。
 */
function richAppearance(): AppearanceTable {
  return {
    entries: [
      {
        id: 'appearance-1',
        target: { kind: 'body', bodyFeatureId: 'extrude-1' },
        appearance: {
          preset: 'steel',
          color: '#8c9199',
          transmission: ev('0', 0),
          gloss: ev('100', 100),
          roughness: ev('42', 42),
          pattern: { kind: 'none' },
        },
      },
      {
        id: 'appearance-2',
        target: { kind: 'face', ref: richAppearanceFaceRef() },
        appearance: {
          preset: 'custom',
          color: '#3355ff',
          transmission: ev('50*2', 100),
          gloss: ev('10', 10),
          roughness: ev('20', 20),
          pattern: { kind: 'woodGrain', spacing: ev('6', 6), species: 'oak' },
        },
      },
    ],
  };
}

/** 型を通さない生の部品文書。欄の欠落や型違いを自由に作れる。 */
// 版4(P4 タスク31)は construction・layout・references のいずれも必須で、
// 版5(P4b タスク21)は parameters も必須になり、版6(P5 タスク5)は appearance も
// 必須になったので、既定値は「壊す前提の欄以外はすべて版6として妥当」な形にしておく
// (references・parameters は空配列、appearance は空の表で足す。個別の検査は overrides
// で意図的に外す)。スケッチの constraints は型自体が恒常的に省略可能なので、既定の
// スケッチには含めない(省略時も欄が無いスケッチとして自然に読める。§0.a-0.17)。
function rawDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'part-1',
    name: '部品1',
    schemaVersion: PCAD_SCHEMA_VERSION,
    sketches: [{ id: 'sketch-1', name: 'スケッチ1', features: [] }],
    activeSketchId: 'sketch-1',
    references: [],
    solids: [],
    parameters: [],
    appearance: { entries: [] },
    ...overrides,
  };
}

/** `rawDocument` の既定に入っている `references` を取り除く(欄が無い版3を模す検査専用)。 */
function withoutReferences(document: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...document };
  delete copy['references'];
  return copy;
}

/** `rawDocument` の既定に入っている `parameters` を取り除く(欄が無い版4を模す検査専用)。 */
function withoutParameters(document: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...document };
  delete copy['parameters'];
  return copy;
}

/** `rawDocument` の既定に入っている `appearance` を取り除く(欄が無い版5を模す検査専用)。 */
function withoutAppearance(document: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...document };
  delete copy['appearance'];
  return copy;
}

/** 型を通さない生のファイル。 */
function rawFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: PCAD_SCHEMA_VERSION,
    kind: PCAD_DOCUMENT_KIND,
    app: PCAD_APP_NAME,
    savedAt: SAVED_AT,
    document: rawDocument(),
    ...overrides,
  });
}

function expectOk(result: ParseDocumentResult): PartDocument {
  if (!result.ok) {
    throw new Error(`読み込みに失敗しました: ${result.error.code} / ${result.error.message}`);
  }
  return result.document;
}

function expectError(result: ParseDocumentResult): ParseError {
  if (result.ok) {
    throw new Error('断るはずの入力を読み込んでしまいました');
  }
  return result.error;
}

/** 保存 → 読み込みの往復。 */
function roundTrip(document: PartDocument): PartDocument {
  return expectOk(parseDocument(serializeDocument(document, { savedAt: SAVED_AT })));
}

// P4 タスク31(§0.a-0.24)で版 3 → 4 へ上げ、P4b タスク21(§0.a-0.17)で版 4 → 5 へ上げた。
describe('.pcad の版(§0.a-0.3、§0.a-0.22、§0.a-0.24、§0.a-0.17、P5 タスク5・§0.a-0.15)', () => {
  it('封筒の版は 6 で、部品文書の版と同じ値である', () => {
    expect(PCAD_SCHEMA_VERSION).toBe(6);
    expect(PCAD_SCHEMA_VERSION).toBe(PART_SCHEMA_VERSION);
  });

  it(
    '版を上げる変換表は版 2→3・3→4・4→5・5→6 の4つを持つ' +
      '(P3・P4 タスク31・P4b タスク21・P5 タスク5が版を1つずつ足したため)',
    () => {
      expect(Object.keys(SCHEMA_MIGRATIONS)).toEqual(['2', '3', '4', '5']);
    },
  );
});

describe('部品文書の書き出し(serializeDocument)', () => {
  it('封筒に版・種別・アプリ名・保存時刻・文書を書く', () => {
    const text = serializeDocument(createEmptyPartDocument(), { savedAt: SAVED_AT });
    expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
    expect(text).toContain(`"kind": "${PCAD_DOCUMENT_KIND}"`);
    expect(text).toContain(`"app": "${PCAD_APP_NAME}"`);
    expect(text).toContain(`"savedAt": "${SAVED_AT}"`);
  });

  it('書き出す種別はいつでも part(部品)である(要件§8)', () => {
    expect(PCAD_DOCUMENT_KIND).toBe('part');
    const text = serializeDocument(richDocument(), { savedAt: SAVED_AT });
    expect(text).not.toContain('"kind": "assembly"');
    expect(text).not.toContain('"kind": "drawing"');
  });

  it('インデントは 2 で、末尾に改行が 1 つだけ付く', () => {
    const text = serializeDocument(createEmptyPartDocument(), { savedAt: SAVED_AT });
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('}\n\n')).toBe(false);
    expect(text).toContain('\n  "schema"');
  });

  it('保存時刻を渡さなければ今の時刻を ISO 8601 で書く', () => {
    const before = Date.now();
    const text = serializeDocument(createEmptyPartDocument());
    const after = Date.now();
    const savedAt = expectOk(parseDocument(text));
    expect(savedAt.id).toBe('part-1');
    const stamp = /"savedAt": "([^"]+)"/.exec(text);
    expect(stamp).not.toBeNull();
    const at = Date.parse(stamp === null ? '' : stamp[1]);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  // 版の数字は P4 タスク31(§0.a-0.24)で 3 → 4、P4b タスク21(§0.a-0.17)で 4 → 5、
  // P5 タスク5(§0.a-0.15)で 5 → 6 に更新(PCAD_SCHEMA_VERSION の値そのもの)。
  it('封筒と文書の並びが計画書 §2.8 の例のとおりになる', () => {
    const document: PartDocument = {
      id: 'part-1',
      name: '部品1',
      schemaVersion: PART_SCHEMA_VERSION,
      sketches: [{ id: 'sketch-1', name: 'スケッチ1', features: [] }],
      activeSketchId: 'sketch-1',
      references: [],
      solids: [
        {
          id: 'extrude-1',
          kind: 'extrude',
          name: '押し出し1',
          suppressed: false,
          profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
          distance: ev('5*2', 10),
          reversed: false,
          symmetric: false,
        },
      ],
      parameters: [],
      appearance: emptyAppearanceTable(),
    };
    expect(serializeDocument(document, { savedAt: SAVED_AT })).toBe(
      `{
  "schema": 6,
  "kind": "part",
  "app": "PointerCAD",
  "savedAt": "2026-09-03T01:23:45.678Z",
  "document": {
    "id": "part-1",
    "name": "部品1",
    "schemaVersion": 6,
    "sketches": [
      {
        "id": "sketch-1",
        "name": "スケッチ1",
        "features": []
      }
    ],
    "activeSketchId": "sketch-1",
    "references": [],
    "solids": [
      {
        "id": "extrude-1",
        "kind": "extrude",
        "name": "押し出し1",
        "suppressed": false,
        "profile": {
          "sketchId": "sketch-1",
          "faceFeatureId": "face-1"
        },
        "distance": {
          "source": "5*2",
          "value": 10,
          "display": "10"
        },
        "reversed": false,
        "symmetric": false
      }
    ],
    "parameters": [],
    "appearance": {
      "entries": []
    }
  }
}
`,
    );
  });

  it('同じ文書からは同じ文字列ができる(決定的)', () => {
    const document = richDocument();
    const first = serializeDocument(document, { savedAt: SAVED_AT });
    const second = serializeDocument(richDocument(), { savedAt: SAVED_AT });
    expect(second).toBe(first);
  });

  it('欄を書いた順が違っても同じ文字列ができる(決定的)', () => {
    const document = richDocument();
    const shuffled: PartDocument = {
      parameters: document.parameters,
      appearance: document.appearance,
      solids: document.solids,
      references: document.references,
      activeSketchId: document.activeSketchId,
      sketches: document.sketches,
      schemaVersion: document.schemaVersion,
      name: document.name,
      id: document.id,
    };
    expect(serializeDocument(shuffled, { savedAt: SAVED_AT })).toBe(
      serializeDocument(document, { savedAt: SAVED_AT }),
    );
  });

  it('知らない欄は書き出さない(保存し直したときに壊れた組み合わせを書かないため)', () => {
    const document = Object.assign({}, createEmptyPartDocument(), {
      resolvedPoints: [{ x: 1 }],
      cacheKey: 'abcdef',
    });
    const text = serializeDocument(document, { savedAt: SAVED_AT });
    expect(text).not.toContain('resolvedPoints');
    expect(text).not.toContain('cacheKey');
    expect(roundTrip(document)).toEqual(createEmptyPartDocument());
  });
});

describe('往復(serializeDocument → parseDocument)', () => {
  it('空の部品文書が往復で一致する', () => {
    const document = createEmptyPartDocument();
    expect(roundTrip(document)).toEqual(document);
  });

  it('スケッチ 5 種と押し出し・回転・縫合・ブーリアンを含む文書が往復で一致する', () => {
    const document = richDocument();
    expect(roundTrip(document)).toEqual(document);
  });

  it('10 種類のソリッドフィーチャー(P2 の4種 + 加工5種 + ばね)を含む文書が往復で一致する', () => {
    const document = richDocument();
    // revolve は2種類の回転軸(world / line)を確かめるため2件あるので、件数は11。
    expect(document.solids).toHaveLength(11);
    expect(new Set(document.solids.map((feature) => feature.kind)).size).toBe(10);
    const roundTripped = roundTrip(document);
    expect(roundTripped).toEqual(document);
    // 面・辺・頂点の3種類の指紋、軸ありと軸なし(null)の辺、貫通/止まりの両方を含むことを確かめる。
    const kinds = roundTripped.solids.map((feature) => feature.kind);
    expect(kinds).toEqual([
      'extrude',
      'revolve',
      'revolve',
      'sew',
      'boolean',
      'hole',
      'threadHole',
      'fillet',
      'chamfer',
      'pattern',
      'spring',
    ]);
  });

  it('辺の指紋の axis が null のときは往復しても null のまま(undefined にならない)', () => {
    const roundTripped = roundTrip(richDocument());
    const fillet = roundTripped.solids.find((feature) => feature.id === 'fillet-1');
    if (fillet === undefined || fillet.kind !== 'fillet') {
      throw new Error('fillet-1 が見つからないはず');
    }
    const freeEdge = fillet.targets[1];
    if (freeEdge.fingerprint.kind !== 'edge') {
      throw new Error('辺の指紋のはず');
    }
    expect(freeEdge.fingerprint.axis).toBeNull();
    expect('axis' in freeEdge.fingerprint).toBe(true);
  });

  it('部分形状の指紋は面・辺・頂点の3種類とも往復で一致する', () => {
    const roundTripped = roundTrip(richDocument());
    const hole = roundTripped.solids.find((feature) => feature.id === 'hole-1');
    const fillet = roundTripped.solids.find((feature) => feature.id === 'fillet-1');
    if (hole === undefined || hole.kind !== 'hole' || fillet === undefined || fillet.kind !== 'fillet') {
      throw new Error('hole-1 / fillet-1 が見つからないはず');
    }
    expect(hole.face.fingerprint.kind).toBe('face');
    expect(fillet.targets[0].fingerprint.kind).toBe('edge');
    expect(fillet.targets[2].fingerprint).toEqual({ kind: 'vertex', position: [4, 5, 6] });
  });

  it('式は評価値ではなく式文字列のまま往復する(FR-202)', () => {
    const document = roundTrip(richDocument());
    const feature = document.solids[0];
    if (feature.kind !== 'extrude') {
      throw new Error('最初のソリッドは押し出しのはず');
    }
    expect(feature.distance).toEqual({ source: '5*2', value: 10, display: '10' });
  });

  it('面の境界の index は、あるときだけ往復する', () => {
    const document = roundTrip(richDocument());
    const face = document.sketches[0].features[4];
    if (face.kind !== 'face') {
      throw new Error('5 番目の要素は面のはず');
    }
    expect(face.boundary).toEqual([{ featureId: 'line-1' }, { featureId: 'pointArray-1', index: 2 }]);
  });

  it('読み込みは保存時刻も返す(自動保存の案内に使う)', () => {
    const result = parseDocument(serializeDocument(createEmptyPartDocument(), { savedAt: SAVED_AT }));
    if (!result.ok) {
      throw new Error('読み込みに失敗しました');
    }
    expect(result.savedAt).toBe(SAVED_AT);
  });

  it('往復した文書をもう一度書き出すと同じ文字列になる', () => {
    const text = serializeDocument(richDocument(), { savedAt: SAVED_AT });
    const again = serializeDocument(expectOk(parseDocument(text)), { savedAt: SAVED_AT });
    expect(again).toBe(text);
  });
});

/** 1つのソリッドフィーチャーだけを持つ最小の文書(欄の組み合わせを1つずつ確かめる検査に使う)。 */
function documentWithSolid(feature: SolidFeature): PartDocument {
  return { ...createEmptyPartDocument(), solids: [feature] };
}

/** 1つのスケッチフィーチャーだけを持つ最小の文書。 */
function documentWithSketchFeature(feature: SketchFeature): PartDocument {
  const empty = createEmptyPartDocument();
  return {
    ...empty,
    sketches: empty.sketches.map((sketch) => ({ ...sketch, features: [feature] })),
  };
}

// P4 タスク31(§0.a-0.24): 矩形・正多角形・長穴(タスク4)の専用の往復検査が
// 無かったため、ここで1件ずつ足す(他の検査では複製系の source としてしか使われていない)。
describe('矩形・正多角形・長穴の往復(P4 タスク4、FR-314〜316)', () => {
  it('矩形(対角の2点)の欄がすべて往復で一致する', () => {
    const rectangle: SketchFeature = {
      id: 'rectangle-9',
      kind: 'rectangle',
      name: '矩形1',
      planeId: 'xy',
      corner1: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      corner2: { mode: 'absolute', x: ev('40', 40), y: ev('30', 30), z: ev('0', 0) },
      construction: false,
    };
    expect(roundTrip(documentWithSketchFeature(rectangle)).sketches[0].features[0]).toEqual(
      rectangle,
    );
  });

  it('正多角形(内接・外接)の欄がすべて往復で一致する', () => {
    const inscribed: SketchFeature = {
      id: 'polygon-9',
      kind: 'polygon',
      name: '正多角形1',
      planeId: 'xy',
      center: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      sides: ev('6', 6),
      radius: ev('10', 10),
      radiusMode: 'inscribed',
      construction: false,
    };
    const circumscribed: SketchFeature = { ...inscribed, id: 'polygon-10', radiusMode: 'circumscribed' };
    expect(roundTrip(documentWithSketchFeature(inscribed)).sketches[0].features[0]).toEqual(
      inscribed,
    );
    expect(roundTrip(documentWithSketchFeature(circumscribed)).sketches[0].features[0]).toEqual(
      circumscribed,
    );
  });

  it('長穴(2つの中心点+幅)の欄がすべて往復で一致する', () => {
    const slot: SketchFeature = {
      id: 'slot-9',
      kind: 'slot',
      name: '長穴1',
      planeId: 'xy',
      center1: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      center2: { mode: 'absolute', x: ev('20', 20), y: ev('0', 0), z: ev('0', 0) },
      width: ev('8', 8),
      construction: true,
    };
    expect(roundTrip(documentWithSketchFeature(slot)).sketches[0].features[0]).toEqual(slot);
  });
});

describe('楕円・スプラインの往復(P4 タスク5、FR-317・FR-318)', () => {
  const ellipse: SketchFeature = {
    id: 'ellipse-1',
    kind: 'ellipse',
    name: '楕円1',
    planeId: 'xz',
    center: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
    majorRadius: ev('10*2', 20),
    minorRadius: ev('10', 10),
    rotation: ev('30', 30),
    startAngle: ev('0', 0),
    endAngle: ev('360', 360),
    construction: false,
  };

  it('楕円の欄がすべて往復で一致する', () => {
    const document = documentWithSketchFeature(ellipse);
    expect(roundTrip(document).sketches[0].features[0]).toEqual(ellipse);
  });

  it('スプラインは点の並び・通過点/制御点・閉じるかが往復で一致する', () => {
    const spline: SketchFeature = {
      id: 'spline-1',
      kind: 'spline',
      name: 'スプライン1',
      planeId: 'xy',
      mode: 'control',
      points: [
        { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
        {
          mode: 'relative',
          base: { kind: 'previous' },
          dx: ev('10', 10),
          dy: ev('5', 5),
          dz: ev('0', 0),
        },
        {
          mode: 'polar',
          base: { kind: 'origin' },
          distance: ev('20', 20),
          azimuth: ev('45', 45),
          elevation: ev('0', 0),
        },
      ],
      closed: true,
      construction: true,
    };
    const restored = roundTrip(documentWithSketchFeature(spline)).sketches[0].features[0];
    expect(restored).toEqual(spline);
  });

  it('スプラインの点の並びの型が違えば、その場所を添えて断る(FR-504、NFR-UX-5)', () => {
    const broken = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'spline-1',
              kind: 'spline',
              name: 'スプライン1',
              planeId: 'xy',
              mode: 'interpolate',
              points: [{ mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: 'ゼロ' }],
              closed: false,
              construction: false,
            },
          ],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.message).toContain('points');
  });
});

describe('点列の拡張・構築線の往復(P4 タスク6、FR-320・FR-327)', () => {
  it('円周上の点列(layout.kind === "circular")が往復で一致する', () => {
    const array: SketchFeature = {
      id: 'pointArray-2',
      kind: 'pointArray',
      name: '点列2',
      planeId: 'xy',
      layout: {
        kind: 'circular',
        center: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
        radius: ev('10', 10),
        count: ev('4', 4),
      },
    };
    expect(roundTrip(documentWithSketchFeature(array)).sketches[0].features[0]).toEqual(array);
  });

  it('格子状の点列(layout.kind === "grid")が往復で一致する', () => {
    const array: SketchFeature = {
      id: 'pointArray-3',
      kind: 'pointArray',
      name: '点列3',
      planeId: 'xy',
      layout: {
        kind: 'grid',
        base: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
        rowAzimuth: ev('0', 0),
        rowSpacing: ev('10', 10),
        rowCount: ev('3', 3),
        colAzimuth: ev('90', 90),
        colSpacing: ev('5', 5),
        colCount: ev('2', 2),
      },
    };
    expect(roundTrip(documentWithSketchFeature(array)).sketches[0].features[0]).toEqual(array);
  });

  it('construction な線分・円弧が往復で一致する(FR-320)', () => {
    const line: SketchFeature = {
      id: 'line-9',
      kind: 'line',
      name: '線分9',
      planeId: 'xy',
      from: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      to: { mode: 'absolute', x: ev('10', 10), y: ev('0', 0), z: ev('0', 0) },
      construction: true,
    };
    const arc: SketchFeature = {
      id: 'arc-9',
      kind: 'arc',
      name: '円弧9',
      planeId: 'xy',
      center: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      radius: ev('5', 5),
      startAngle: ev('0', 0),
      endAngle: ev('90', 90),
      construction: true,
    };
    expect(roundTrip(documentWithSketchFeature(line)).sketches[0].features[0]).toEqual(line);
    expect(roundTrip(documentWithSketchFeature(arc)).sketches[0].features[0]).toEqual(arc);
  });

  it('点列の layout.kind が壊れていれば、その場所を添えて断る(FR-504、NFR-UX-5)', () => {
    const broken = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'pointArray-1',
              kind: 'pointArray',
              name: '点列1',
              planeId: 'xy',
              layout: { kind: 'これはない' },
            },
          ],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.message).toContain('layout');
  });
});

describe(
  '版3 → 版4の移行(construction 無し・pointArray がフラット形式、' +
    'SCHEMA_MIGRATIONS[3]、P4 タスク31・§0.a-0.24。元は統括の差し戻し 2026-09-04、要件§8・P3完了条件9)',
  () => {
    /** 版3の書き手が construction をまだ書いていなかった頃の線分。 */
    const legacyLine = {
      id: 'line-1',
      kind: 'line',
      name: '線分1',
      planeId: 'xy',
      from: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      to: { mode: 'absolute', x: ev('10', 10), y: ev('0', 0), z: ev('0', 0) },
      // construction は無い(版3以前)。
    };
    /** layout を挟まない、版3以前のフラットな点列。 */
    const legacyPointArray = {
      id: 'pointArray-1',
      kind: 'pointArray',
      name: '点列1',
      planeId: 'xy',
      base: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      azimuth: ev('0', 0),
      spacing: ev('10', 10),
      count: ev('3', 3),
    };

    /** 版3として保存された(schema/schemaVersion とも 3 の)生の部品文書。 */
    function legacyRawDocument(): Record<string, unknown> {
      return rawDocument({
        schemaVersion: 3,
        sketches: [
          { id: 'sketch-1', name: 'スケッチ1', features: [legacyLine, legacyPointArray] },
        ],
      });
    }

    /** 版3の生ファイル。封筒の schema も 3(SCHEMA_MIGRATIONS[3] を通す)。 */
    function legacyRawFile(): string {
      return rawFile({ schema: 3, document: legacyRawDocument() });
    }

    it('construction の無い線分は移行で false になる', () => {
      const document = expectOk(parseDocument(legacyRawFile()));
      const line = document.sketches[0].features[0];
      if (line.kind !== 'line') {
        throw new Error('線分のはず');
      }
      expect(line.construction).toBe(false);
    });

    it('layout の無い点列は移行で直線状(linear)へ包み直される', () => {
      const document = expectOk(parseDocument(legacyRawFile()));
      const array = document.sketches[0].features[1];
      if (array.kind !== 'pointArray') {
        throw new Error('点列のはず');
      }
      expect(array.layout).toEqual({
        kind: 'linear',
        base: legacyPointArray.base,
        azimuth: legacyPointArray.azimuth,
        spacing: legacyPointArray.spacing,
        count: legacyPointArray.count,
      });
    });

    it('版3から移行した読み込み結果は、版4で書いた同じ内容と同じ解決結果になる', () => {
      const legacyResult = expectOk(parseDocument(legacyRawFile()));
      const modernDocument = rawDocument({
        sketches: [
          {
            id: 'sketch-1',
            name: 'スケッチ1',
            features: [
              { ...legacyLine, construction: false },
              {
                id: 'pointArray-1',
                kind: 'pointArray',
                name: '点列1',
                planeId: 'xy',
                layout: {
                  kind: 'linear',
                  base: legacyPointArray.base,
                  azimuth: legacyPointArray.azimuth,
                  spacing: legacyPointArray.spacing,
                  count: legacyPointArray.count,
                },
              },
            ],
          },
        ],
      });
      const modernResult = expectOk(parseDocument(rawFile({ document: modernDocument })));
      expect(resolveSketch(legacyResult.sketches[0])).toEqual(
        resolveSketch(modernResult.sketches[0]),
      );
    });

    it('版3を読み込んだ文書を書き出すと現在の版(construction・layout あり)で正規化される', () => {
      const document = expectOk(parseDocument(legacyRawFile()));
      const text = serializeDocument(document, { savedAt: SAVED_AT });
      expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
      expect(text).toContain('"construction": false');
      expect(text).toContain('"layout"');
      // 正規化後は自分自身との往復でも文字列が変わらない(決定的、§0.a-0.2 と同じ確認)。
      const again = serializeDocument(expectOk(parseDocument(text)), { savedAt: SAVED_AT });
      expect(again).toBe(text);
    });

    it('版4になったのに construction が無ければ断る(寛容な読みは版3までに限る)', () => {
      const broken = rawDocument({
        sketches: [{ id: 'sketch-1', name: 'スケッチ1', features: [legacyLine] }],
      });
      const error = expectError(parseDocument(rawFile({ document: broken })));
      expect(error.code).toBe('missingField');
      expect(error.message).toContain('construction');
    });

    it('版4になったのに pointArray に layout が無ければ断る(寛容な読みは版3までに限る)', () => {
      const broken = rawDocument({
        sketches: [{ id: 'sketch-1', name: 'スケッチ1', features: [legacyPointArray] }],
      });
      const error = expectError(parseDocument(rawFile({ document: broken })));
      expect(error.code).toBe('missingField');
      expect(error.message).toContain('layout');
    });
  },
);

describe(
  '版4 → 版5の移行(parameters 無し、SCHEMA_MIGRATIONS[4]、P4b タスク21・§0.a-0.17)',
  () => {
    /** 版4として保存された(schema/schemaVersion とも 4 の、parameters を持たない)生の部品文書。 */
    function legacyRawDocument(): Record<string, unknown> {
      return withoutParameters(rawDocument({ schemaVersion: 4 }));
    }

    /** 版4の生ファイル。封筒の schema も 4(SCHEMA_MIGRATIONS[4] を通す)。 */
    function legacyRawFile(): string {
      return rawFile({ schema: 4, document: legacyRawDocument() });
    }

    it('parameters の欄が無い版4のファイルも開ける(移行で空の表として読む)', () => {
      const document = expectOk(parseDocument(legacyRawFile()));
      expect(document.parameters).toEqual([]);
    });

    it('版4のファイルは appearance も空の表になる(4→5→6と連続して移行する)', () => {
      const document = expectOk(parseDocument(legacyRawFile()));
      expect(document.appearance.entries).toEqual([]);
    });

    it('版4を読み込んだ文書を書き出すと現在の版(parameters・appearance あり)で正規化される', () => {
      const document = expectOk(parseDocument(legacyRawFile()));
      const text = serializeDocument(document, { savedAt: SAVED_AT });
      expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
      expect(text).toContain('"parameters": []');
      expect(text).toContain('"appearance": {\n      "entries": []\n    }');
      // 正規化後は自分自身との往復でも文字列が変わらない(決定的、§0.a-0.2 と同じ確認)。
      const again = serializeDocument(expectOk(parseDocument(text)), { savedAt: SAVED_AT });
      expect(again).toBe(text);
    });

    it('版5になったのに parameters の欄が無ければ断る(寛容な読みは版4までに限る)', () => {
      const broken = withoutParameters(rawDocument());
      expect('parameters' in broken).toBe(false);
      const error = expectError(parseDocument(rawFile({ document: broken })));
      expect(error.code).toBe('missingField');
      expect(error.message).toContain('parameters');
    });

    // スケッチの constraints は型自体が恒常的に省略可能なので、版に関係なく
    // 「無ければ触らない」まま読み込む(migrateDocumentToV5 のコメント参照)。移行の対象にしない。
    it('constraints の欄が無いスケッチは版に関係なく開ける(欄そのものを持たないまま読む)', () => {
      const document = expectOk(parseDocument(rawFile()));
      expect('constraints' in document.sketches[0]).toBe(false);
      expect(sketchConstraints(document.sketches[0])).toEqual([]);
    });
  },
);

describe(
  '版5 → 版6の移行(appearance 無し、SCHEMA_MIGRATIONS[5]、P5 タスク5・§0.a-0.15)',
  () => {
    /** 版5として保存された(schema/schemaVersion とも 5 の、appearance を持たない)生の部品文書。 */
    function legacyRawDocument(): Record<string, unknown> {
      return withoutAppearance(rawDocument({ schemaVersion: 5 }));
    }

    /** 版5の生ファイル。封筒の schema も 5(SCHEMA_MIGRATIONS[5] を通す)。 */
    function legacyRawFile(): string {
      return rawFile({ schema: 5, document: legacyRawDocument() });
    }

    it('appearance の欄が無い版5のファイルも開ける(移行で空の表として読む)', () => {
      const document = expectOk(parseDocument(legacyRawFile()));
      expect(document.appearance.entries).toEqual([]);
    });

    it('版5を読み込んだ文書を書き出すと版6(appearance あり)で正規化される', () => {
      const document = expectOk(parseDocument(legacyRawFile()));
      const text = serializeDocument(document, { savedAt: SAVED_AT });
      expect(text).toContain('"schema": 6');
      expect(text).toContain('"appearance": {\n      "entries": []\n    }');
      // 正規化後は自分自身との往復でも文字列が変わらない(決定的、§0.a-0.2 と同じ確認)。
      const again = serializeDocument(expectOk(parseDocument(text)), { savedAt: SAVED_AT });
      expect(again).toBe(text);
    });

    it('版6になったのに appearance の欄が無ければ断る(寛容な読みは版5までに限る)', () => {
      const broken = withoutAppearance(rawDocument());
      expect('appearance' in broken).toBe(false);
      const error = expectError(parseDocument(rawFile({ document: broken })));
      expect(error.code).toBe('missingField');
      expect(error.message).toContain('appearance');
    });
  },
);

describe('外観の往復と断り方(FR-1106〜1110、要件§4.12、P5 タスク5)', () => {
  it('立体1つ・面1枚の割り当てが id・対象・外観のまま往復する(外観2件)', () => {
    const restored = roundTrip(richDocument());
    expect(restored.appearance).toEqual(richAppearance());
    expect(restored.appearance.entries).toHaveLength(2);
  });

  it('透過率の式(50*2)が文字列のまま往復する', () => {
    const restored = roundTrip(richDocument());
    const faceEntry = restored.appearance.entries.find((entry) => entry.target.kind === 'face');
    if (faceEntry === undefined) {
      throw new Error('面の割り当てのはず');
    }
    expect(faceEntry.appearance.transmission.source).toBe('50*2');
    expect(faceEntry.appearance.transmission.value).toBe(100);
  });

  it('面の割り当ての SubShapeRef が往復する(指紋の数値が一致)', () => {
    const restored = roundTrip(richDocument());
    const faceEntry = restored.appearance.entries.find((entry) => entry.target.kind === 'face');
    if (faceEntry === undefined || faceEntry.target.kind !== 'face') {
      throw new Error('面の割り当てのはず');
    }
    expect(faceEntry.target.ref).toEqual(richAppearanceFaceRef());
  });

  it('柄の間隔(spacing)の式が文字列のまま往復する(woodGrain)', () => {
    const restored = roundTrip(richDocument());
    const faceEntry = restored.appearance.entries.find((entry) => entry.target.kind === 'face');
    if (faceEntry === undefined || faceEntry.appearance.pattern.kind !== 'woodGrain') {
      throw new Error('woodGrain の割り当てのはず');
    }
    expect(faceEntry.appearance.pattern.spacing.source).toBe('6');
    expect(faceEntry.appearance.pattern.species).toBe('oak');
  });

  it('立体の割り当てのプリセット id・光沢・粗さの式が往復する(steel)', () => {
    const restored = roundTrip(richDocument());
    const bodyEntry = restored.appearance.entries.find((entry) => entry.target.kind === 'body');
    if (bodyEntry === undefined) {
      throw new Error('立体の割り当てのはず');
    }
    expect(bodyEntry.appearance.preset).toBe('steel');
    expect(bodyEntry.appearance.color).toBe('#8c9199');
    expect(bodyEntry.appearance.gloss.source).toBe('100');
    expect(bodyEntry.appearance.roughness.source).toBe('42');
  });

  it('未知のプリセット id を含む割り当ては、その割り当てだけ落ちる。ほかは読める(前方互換)', () => {
    const broken = rawDocument({
      appearance: {
        entries: [
          {
            id: 'appearance-1',
            target: { kind: 'body', bodyFeatureId: 'extrude-1' },
            appearance: {
              preset: 'これはない',
              color: '#ffffff',
              transmission: ev('0', 0),
              gloss: ev('0', 0),
              roughness: ev('0', 0),
              pattern: { kind: 'none' },
            },
          },
          {
            id: 'appearance-2',
            target: { kind: 'body', bodyFeatureId: 'extrude-2' },
            appearance: {
              preset: 'steel',
              color: '#8c9199',
              transmission: ev('0', 0),
              gloss: ev('100', 100),
              roughness: ev('42', 42),
              pattern: { kind: 'none' },
            },
          },
        ],
      },
    });
    const document = expectOk(parseDocument(rawFile({ document: broken })));
    expect(document.appearance.entries).toHaveLength(1);
    expect(document.appearance.entries[0].id).toBe('appearance-2');
  });

  it('未知の柄の種類を含む割り当ては、その割り当てだけ落ちる(前方互換)', () => {
    const broken = rawDocument({
      appearance: {
        entries: [
          {
            id: 'appearance-1',
            target: { kind: 'body', bodyFeatureId: 'extrude-1' },
            appearance: {
              preset: 'custom',
              color: '#ffffff',
              transmission: ev('0', 0),
              gloss: ev('0', 0),
              roughness: ev('0', 0),
              pattern: { kind: 'これはない' },
            },
          },
        ],
      },
    });
    const document = expectOk(parseDocument(rawFile({ document: broken })));
    expect(document.appearance.entries).toEqual([]);
  });

  it('未知の樹種を含む woodGrain の割り当ては、その割り当てだけ落ちる(前方互換)', () => {
    const broken = rawDocument({
      appearance: {
        entries: [
          {
            id: 'appearance-1',
            target: { kind: 'body', bodyFeatureId: 'extrude-1' },
            appearance: {
              preset: 'custom',
              color: '#ffffff',
              transmission: ev('0', 0),
              gloss: ev('0', 0),
              roughness: ev('0', 0),
              pattern: { kind: 'woodGrain', spacing: ev('6', 6), species: 'これはない' },
            },
          },
        ],
      },
    });
    const document = expectOk(parseDocument(rawFile({ document: broken })));
    expect(document.appearance.entries).toEqual([]);
  });

  it('光沢が範囲外(101%)なら断る(統括の指示、範囲外は invalidField)', () => {
    const broken = rawDocument({
      appearance: {
        entries: [
          {
            id: 'appearance-1',
            target: { kind: 'body', bodyFeatureId: 'extrude-1' },
            appearance: {
              preset: 'custom',
              color: '#ffffff',
              transmission: ev('0', 0),
              gloss: ev('101', 101),
              roughness: ev('0', 0),
              pattern: { kind: 'none' },
            },
          },
        ],
      },
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('gloss');
  });

  it('透過率が範囲外(負)なら断る', () => {
    const broken = rawDocument({
      appearance: {
        entries: [
          {
            id: 'appearance-1',
            target: { kind: 'body', bodyFeatureId: 'extrude-1' },
            appearance: {
              preset: 'custom',
              color: '#ffffff',
              transmission: ev('-1', -1),
              gloss: ev('0', 0),
              roughness: ev('0', 0),
              pattern: { kind: 'none' },
            },
          },
        ],
      },
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('transmission');
  });

  it('id が表の中で重なっていれば断る(統括の指示)', () => {
    const broken = rawDocument({
      appearance: {
        entries: [
          {
            id: 'dup-1',
            target: { kind: 'body', bodyFeatureId: 'extrude-1' },
            appearance: {
              preset: 'steel',
              color: '#8c9199',
              transmission: ev('0', 0),
              gloss: ev('100', 100),
              roughness: ev('42', 42),
              pattern: { kind: 'none' },
            },
          },
          {
            id: 'dup-1',
            target: { kind: 'body', bodyFeatureId: 'extrude-2' },
            appearance: {
              preset: 'aluminum',
              color: '#c9ced6',
              transmission: ev('0', 0),
              gloss: ev('100', 100),
              roughness: ev('32', 32),
              pattern: { kind: 'none' },
            },
          },
        ],
      },
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('dup-1');
  });
});

describe('穴の深さ(HoleDepth)の往復(§0.a-0.11、§0.a-0.12)', () => {
  it('貫通(through)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'hole-1',
      kind: 'hole',
      name: '穴1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      face: {
        bodyFeatureId: 'extrude-1',
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
      centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
      diameter: ev('6', 6),
      depth: { kind: 'through' },
      tiltAngle: ev('0', 0),
      tiltAzimuth: ev('0', 0),
    });
    const parsed = roundTrip(document);
    const hole = parsed.solids[0];
    if (hole.kind !== 'hole') {
      throw new Error('穴のはず');
    }
    expect(hole.depth).toEqual({ kind: 'through' });
  });

  it('止まり(blind、式つき)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'hole-1',
      kind: 'hole',
      name: '穴1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      face: {
        bodyFeatureId: 'extrude-1',
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
      centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
      diameter: ev('6', 6),
      depth: { kind: 'blind', depth: ev('4*2.5', 10) },
      tiltAngle: ev('0', 0),
      tiltAzimuth: ev('0', 0),
    });
    const parsed = roundTrip(document);
    const hole = parsed.solids[0];
    if (hole.kind !== 'hole') {
      throw new Error('穴のはず');
    }
    expect(hole.depth).toEqual({ kind: 'blind', depth: ev('4*2.5', 10) });
  });
});

describe('C 面取りの大きさ(ChamferSize)の3種類の往復(§0.a-0.18)', () => {
  it('等距離(equal)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'chamfer-1',
      kind: 'chamfer',
      name: 'C面取り1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      targets: [
        {
          bodyFeatureId: 'extrude-1',
          index: 0,
          fingerprint: { kind: 'edge', curveKind: 'line', length: 10, position: [0, 0, 0], axis: [1, 0, 0], radius: null },
        },
      ],
      size: { kind: 'equal', distance: ev('1', 1) },
      swapReferenceFace: false,
    });
    const parsed = roundTrip(document);
    const chamfer = parsed.solids[0];
    if (chamfer.kind !== 'chamfer') {
      throw new Error('面取りのはず');
    }
    expect(chamfer.size).toEqual({ kind: 'equal', distance: ev('1', 1) });
  });

  it('2距離(twoDistances)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'chamfer-1',
      kind: 'chamfer',
      name: 'C面取り1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      targets: [
        {
          bodyFeatureId: 'extrude-1',
          index: 0,
          fingerprint: { kind: 'edge', curveKind: 'line', length: 10, position: [0, 0, 0], axis: [1, 0, 0], radius: null },
        },
      ],
      size: { kind: 'twoDistances', distance1: ev('1', 1), distance2: ev('2', 2) },
      swapReferenceFace: true,
    });
    const parsed = roundTrip(document);
    const chamfer = parsed.solids[0];
    if (chamfer.kind !== 'chamfer') {
      throw new Error('面取りのはず');
    }
    expect(chamfer.size).toEqual({ kind: 'twoDistances', distance1: ev('1', 1), distance2: ev('2', 2) });
    expect(chamfer.swapReferenceFace).toBe(true);
  });

  it('距離と角度(distanceAngle)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'chamfer-1',
      kind: 'chamfer',
      name: 'C面取り1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      targets: [
        {
          bodyFeatureId: 'extrude-1',
          index: 0,
          fingerprint: { kind: 'edge', curveKind: 'line', length: 10, position: [0, 0, 0], axis: [1, 0, 0], radius: null },
        },
      ],
      size: { kind: 'distanceAngle', distance: ev('1', 1), angle: ev('45', 45) },
      swapReferenceFace: false,
    });
    const parsed = roundTrip(document);
    const chamfer = parsed.solids[0];
    if (chamfer.kind !== 'chamfer') {
      throw new Error('面取りのはず');
    }
    expect(chamfer.size).toEqual({ kind: 'distanceAngle', distance: ev('1', 1), angle: ev('45', 45) });
  });
});

describe('パターンの並べ方(PatternPlacement)の2種類の往復(§0.a-0.20、§0.a-0.21)', () => {
  it('直線(linear、両側へ)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'pattern-1',
      kind: 'pattern',
      name: '直線パターン1',
      suppressed: false,
      sourceFeatureId: 'hole-1',
      placement: {
        kind: 'linear',
        direction: { kind: 'line', line: { sketchId: 'sketch-1', lineFeatureId: 'line-1' } },
        spacing: ev('15', 15),
        count: ev('5', 5),
        symmetric: true,
      },
    });
    const parsed = roundTrip(document);
    const pattern = parsed.solids[0];
    if (pattern.kind !== 'pattern') {
      throw new Error('パターンのはず');
    }
    expect(pattern.placement).toEqual({
      kind: 'linear',
      direction: { kind: 'line', line: { sketchId: 'sketch-1', lineFeatureId: 'line-1' } },
      spacing: ev('15', 15),
      count: ev('5', 5),
      symmetric: true,
    });
  });

  it('円形(circular、全周)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'pattern-1',
      kind: 'pattern',
      name: '円形パターン1',
      suppressed: false,
      sourceFeatureId: 'hole-1',
      placement: {
        kind: 'circular',
        axis: { kind: 'world', axis: 'z' },
        angle: ev('360', 360),
        count: ev('4', 4),
        fullCircle: true,
      },
    });
    const parsed = roundTrip(document);
    const pattern = parsed.solids[0];
    if (pattern.kind !== 'pattern') {
      throw new Error('パターンのはず');
    }
    expect(pattern.placement).toEqual({
      kind: 'circular',
      axis: { kind: 'world', axis: 'z' },
      angle: ev('360', 360),
      count: ev('4', 4),
      fullCircle: true,
    });
  });
});

describe('ばね(SpringFeature)の derived / handedness の往復(FR-414、§0.a-0.30、§0.a-0.33)', () => {
  const DERIVED_VALUES = ['length', 'pitch', 'turns'] as const;
  const HANDEDNESS_VALUES = ['right', 'left'] as const;

  for (const derived of DERIVED_VALUES) {
    for (const handedness of HANDEDNESS_VALUES) {
      it(`derived: '${derived}' / handedness: '${handedness}' が往復で一致する`, () => {
        const document = documentWithSolid({
          id: 'spring-1',
          kind: 'spring',
          name: 'ばね1',
          suppressed: false,
          origin: { sketchId: 'sketch-1', pointFeatureId: 'point-1' },
          axis: { kind: 'world', axis: 'z' },
          tiltAngle: ev('0', 0),
          tiltAzimuth: ev('0', 0),
          length: ev('20', 20),
          pitch: ev('5', 5),
          turns: ev('4', 4),
          derived,
          coilDiameter: ev('20', 20),
          wireDiameter: ev('2', 2),
          handedness,
        });
        const parsed = roundTrip(document);
        const spring = parsed.solids[0];
        if (spring.kind !== 'spring') {
          throw new Error('ばねのはず');
        }
        expect(spring.derived).toBe(derived);
        expect(spring.handedness).toBe(handedness);
      });
    }
  }

  it('derived に知らない値(\'foo\')があれば断る(選択肢の一覧で絞っているため)', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'spring-1',
          kind: 'spring',
          name: 'ばね1',
          suppressed: false,
          origin: { sketchId: 'sketch-1', pointFeatureId: 'point-1' },
          axis: { kind: 'world', axis: 'z' },
          tiltAngle: ev('0', 0),
          tiltAzimuth: ev('0', 0),
          length: ev('20', 20),
          pitch: ev('5', 5),
          turns: ev('4', 4),
          derived: 'foo',
          coilDiameter: ev('20', 20),
          wireDiameter: ev('2', 2),
          handedness: 'right',
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].derived');
  });

  it('handedness に知らない値(\'both\')があれば断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'spring-1',
          kind: 'spring',
          name: 'ばね1',
          suppressed: false,
          origin: { sketchId: 'sketch-1', pointFeatureId: 'point-1' },
          axis: { kind: 'world', axis: 'z' },
          tiltAngle: ev('0', 0),
          tiltAzimuth: ev('0', 0),
          length: ev('20', 20),
          pitch: ev('5', 5),
          turns: ev('4', 4),
          derived: 'length',
          coilDiameter: ev('20', 20),
          wireDiameter: ev('2', 2),
          handedness: 'both',
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].handedness');
  });
});

describe('基本形状(PrimitiveFeature)の読み書き(FR-429、FR-801、P5 タスク17)', () => {
  const SHAPE_KINDS = ['sphere', 'box', 'cylinder', 'cone', 'torus'] as const;
  type PrimitiveShapeTestKind = (typeof SHAPE_KINDS)[number];

  /** 5 種の寸法(§2.7.1)。球だけ式(`5*2`)を含めて FR-202 の確認も兼ねる。 */
  function primitiveShapeFor(kind: PrimitiveShapeTestKind): PrimitiveShape {
    switch (kind) {
      case 'sphere':
        return { kind: 'sphere', radius: ev('5*2', 10) };
      case 'box':
        return { kind: 'box', sizeX: ev('20', 20), sizeY: ev('20', 20), sizeZ: ev('20', 20) };
      case 'cylinder':
        return { kind: 'cylinder', radius: ev('10', 10), height: ev('20', 20) };
      case 'cone':
        return {
          kind: 'cone',
          bottomRadius: ev('10', 10),
          topRadius: ev('0', 0),
          height: ev('20', 20),
        };
      case 'torus':
        return { kind: 'torus', majorRadius: ev('20', 20), minorRadius: ev('5', 5) };
    }
  }

  const ORIGIN_KINDS = ['coordinate', 'sketchPoint', 'vertex'] as const;
  type SolidOriginTestKind = (typeof ORIGIN_KINDS)[number];

  /** 基準点の3通り(§0.a-0.18)。`vertex` は指紋つきの部分形状の参照を持つ。 */
  function originFor(kind: SolidOriginTestKind): SolidOrigin {
    switch (kind) {
      case 'coordinate':
        return {
          kind: 'coordinate',
          value: { mode: 'absolute', x: ev('5*2', 10), y: ev('0', 0), z: ev('0', 0) },
        };
      case 'sketchPoint':
        return { kind: 'sketchPoint', ref: { sketchId: 'sketch-1', pointFeatureId: 'point-1' } };
      case 'vertex':
        return {
          kind: 'vertex',
          ref: {
            bodyFeatureId: 'extrude-1',
            index: 3,
            fingerprint: { kind: 'vertex', position: [1.5, 2.5, 3.5] },
          },
        };
    }
  }

  function primitiveFeatureFor(
    shapeKind: PrimitiveShapeTestKind,
    originKind: SolidOriginTestKind,
  ): PrimitiveFeature {
    return {
      id: 'primitive-1',
      kind: 'primitive',
      name: '基本形状1',
      suppressed: false,
      origin: originFor(originKind),
      axis: { kind: 'world', axis: 'z' },
      shape: primitiveShapeFor(shapeKind),
    };
  }

  for (const shapeKind of SHAPE_KINDS) {
    for (const originKind of ORIGIN_KINDS) {
      it(`${shapeKind} × 基準点(${originKind})が往復で一致する`, () => {
        const feature = primitiveFeatureFor(shapeKind, originKind);
        const parsed = roundTrip(documentWithSolid(feature));
        expect(parsed.solids[0]).toEqual(feature);
      });
    }
  }

  it('式は文字列のまま往復する(FR-202、球の半径 "5*2")', () => {
    const feature = primitiveFeatureFor('sphere', 'coordinate');
    const parsed = roundTrip(documentWithSolid(feature));
    const primitive = parsed.solids[0];
    if (primitive.kind !== 'primitive' || primitive.shape.kind !== 'sphere') {
      throw new Error('球のはず');
    }
    expect(primitive.shape.radius.source).toBe('5*2');
  });

  it('頂点参照の指紋が往復で一致する(位置の数値が変わらない)', () => {
    const feature = primitiveFeatureFor('box', 'vertex');
    const parsed = roundTrip(documentWithSolid(feature));
    const primitive = parsed.solids[0];
    if (primitive.kind !== 'primitive' || primitive.origin.kind !== 'vertex') {
      throw new Error('頂点基準のはず');
    }
    expect(primitive.origin.ref.fingerprint).toEqual({
      kind: 'vertex',
      position: [1.5, 2.5, 3.5],
    });
  });

  it('向き(軸)がスケッチの線分でも往復で一致する', () => {
    const feature: SolidFeature = {
      ...primitiveFeatureFor('cylinder', 'coordinate'),
      axis: { kind: 'line', line: { sketchId: 'sketch-1', lineFeatureId: 'line-1' } },
    };
    const parsed = roundTrip(documentWithSolid(feature));
    expect(parsed.solids[0]).toEqual(feature);
  });

  it('shape.kind に知らない種類(\'cube\')があれば断る(エラーコードを増やさない)', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'primitive-1',
          kind: 'primitive',
          name: '基本形状1',
          suppressed: false,
          origin: {
            kind: 'coordinate',
            value: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
          },
          axis: { kind: 'world', axis: 'z' },
          shape: { kind: 'cube', size: ev('10', 10) },
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].shape.kind');
  });

  it('origin.kind に知らない種類(\'face\')があれば断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'primitive-1',
          kind: 'primitive',
          name: '基本形状1',
          suppressed: false,
          origin: { kind: 'face', ref: { bodyFeatureId: 'extrude-1', index: 0 } },
          axis: { kind: 'world', axis: 'z' },
          shape: { kind: 'sphere', radius: ev('10', 10) },
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].origin.kind');
  });

  it('球の寸法から radius の欄が欠けていれば断る(missingField)', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'primitive-1',
          kind: 'primitive',
          name: '基本形状1',
          suppressed: false,
          origin: {
            kind: 'coordinate',
            value: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
          },
          axis: { kind: 'world', axis: 'z' },
          shape: { kind: 'sphere' },
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.solids[0].shape.radius');
  });

  it('基本形状を含まない版5のファイルは移行で開ける(旧版は基本形状を持たない)', () => {
    const legacyDocument = withoutAppearance(rawDocument({ schemaVersion: 5 }));
    const legacyFile = rawFile({ schema: 5, document: legacyDocument });
    const document = expectOk(parseDocument(legacyFile));
    expect(document.solids).toEqual([]);
  });

  it('既定の球1つだけの文書のバイト数(参考、FR-801)', () => {
    const empty = createEmptyPartDocument();
    const sphere = createPrimitiveFeature(empty, 'sphere');
    const document: PartDocument = { ...empty, solids: [sphere] };
    const text = serializeDocument(document, { savedAt: SAVED_AT });
    expect(Buffer.byteLength(text, 'utf8')).toBe(1313);
  });
});

describe('加工フィーチャーの読み方の規則(タスク19)', () => {
  it('知らない欄「foo」を足した加工フィーチャーは読めて、往復すると foo が消える', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'hole-1',
          kind: 'hole',
          name: '穴1',
          suppressed: false,
          foo: 1,
          targetFeatureId: 'extrude-1',
          face: {
            bodyFeatureId: 'extrude-1',
            index: 0,
            fingerprint: {
              kind: 'face',
              surfaceKind: 'plane',
              area: 100,
              position: [0, 0, 0],
              axis: [0, 0, 1],
              radius: null,
            },
            foo: 1,
          },
          centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
          diameter: ev('6', 6),
          depth: { kind: 'through' },
          tiltAngle: ev('0', 0),
          tiltAzimuth: ev('0', 0),
        },
      ],
    });
    const parsed = expectOk(parseDocument(rawFile({ document })));
    const text = serializeDocument(parsed, { savedAt: SAVED_AT });
    expect(text).not.toContain('foo');
    const hole = parsed.solids[0];
    if (hole.kind !== 'hole') {
      throw new Error('穴のはず');
    }
    expect(Object.keys(hole).sort()).toEqual(
      ['centers', 'depth', 'diameter', 'face', 'id', 'kind', 'name', 'suppressed', 'targetFeatureId', 'tiltAngle', 'tiltAzimuth'].sort(),
    );
  });

  it('穴の直径(diameter)の評価値が数値でなければ NaN として読み、ファイルは開ける(FR-504)', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'hole-1',
          kind: 'hole',
          name: '穴1',
          suppressed: false,
          targetFeatureId: 'extrude-1',
          face: {
            bodyFeatureId: 'extrude-1',
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
          centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
          diameter: { source: '6', value: '六', display: '6' },
          depth: { kind: 'through' },
          tiltAngle: ev('0', 0),
          tiltAzimuth: ev('0', 0),
        },
      ],
    });
    const parsed = expectOk(parseDocument(rawFile({ document })));
    const hole = parsed.solids[0];
    if (hole.kind !== 'hole') {
      throw new Error('穴のはず');
    }
    expect(hole.diameter.source).toBe('6');
    expect(Number.isNaN(hole.diameter.value)).toBe(true);
  });

  it('知らない種類のフィーチャー(未実装のシェル等)は断る(§0.a-0.1)', () => {
    const document = rawDocument({
      solids: [{ id: 'shell-1', kind: 'shell', name: 'シェル1', suppressed: false }],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].kind');
  });
});

describe('版2から版3への移行(§0.a-0.22、SCHEMA_MIGRATIONS[2])', () => {
  it('版2のファイル(P2 が書いたもの)がそのまま開けて内容が一致する', () => {
    const v2Solids = richSolids().filter(
      (feature) =>
        feature.kind === 'extrude' ||
        feature.kind === 'revolve' ||
        feature.kind === 'sew' ||
        feature.kind === 'boolean',
    );
    const v2Document: PartDocument = {
      id: 'part-1',
      name: '部品1',
      schemaVersion: 2,
      sketches: [richSketch()],
      activeSketchId: 'sketch-1',
      references: [],
      solids: v2Solids,
      parameters: [],
      appearance: emptyAppearanceTable(),
    };
    const v2File = JSON.stringify({
      schema: 2,
      kind: PCAD_DOCUMENT_KIND,
      app: PCAD_APP_NAME,
      savedAt: SAVED_AT,
      document: v2Document,
    });
    const result = parseDocument(v2File);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`読み込みに失敗しました: ${result.error.code}`);
    }
    expect(result.document).toEqual({ ...v2Document, schemaVersion: PCAD_SCHEMA_VERSION });
  });

  it('封筒3・中身2は versionMismatch で断る(移行は封筒の版でだけ判定するため)', () => {
    const error = expectError(
      parseDocument(rawFile({ schema: 3, document: rawDocument({ schemaVersion: 2 }) })),
    );
    expect(error.code).toBe('versionMismatch');
  });
});

/** 型を通さない生の面の指紋(平面)。壊す前提の検査で使い回す。 */
function rawFaceFingerprint(): Record<string, unknown> {
  return {
    kind: 'face',
    surfaceKind: 'plane',
    area: 100,
    position: [0, 0, 0],
    axis: [0, 0, 1],
    radius: null,
  };
}

/** 型を通さない生の SubShapeRef(面)。 */
function rawFaceRef(): Record<string, unknown> {
  return { bodyFeatureId: 'extrude-1', index: 0, fingerprint: rawFaceFingerprint() };
}

/** 型を通さない生の穴フィーチャー。壊す前提の検査で使い回す。 */
function rawHole(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'hole-1',
    kind: 'hole',
    name: '穴1',
    suppressed: false,
    targetFeatureId: 'extrude-1',
    face: rawFaceRef(),
    centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
    diameter: ev('6', 6),
    depth: { kind: 'through' },
    tiltAngle: ev('0', 0),
    tiltAzimuth: ev('0', 0),
    ...overrides,
  };
}

describe('読み込みの断り方(P3、部分形状の参照と加工フィーチャー、タスク19)', () => {
  it('ねじ穴の系列(series)に知らない値があれば断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'threadHole-1',
          kind: 'threadHole',
          name: 'ねじ穴1',
          suppressed: false,
          targetFeatureId: 'extrude-1',
          face: rawFaceRef(),
          centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
          designation: 'M6',
          series: 'medium',
          pitch: ev('1', 1),
          drillDiameter: ev('5.16', 5.16),
          depth: { kind: 'through' },
          threadLength: ev('10', 10),
          representation: 'simplified',
          tiltAngle: ev('0', 0),
          tiltAzimuth: ev('0', 0),
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].series');
  });

  it('ねじ穴の表現(representation)に知らない値があれば断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'threadHole-1',
          kind: 'threadHole',
          name: 'ねじ穴1',
          suppressed: false,
          targetFeatureId: 'extrude-1',
          face: rawFaceRef(),
          centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
          designation: 'M6',
          series: 'coarse',
          pitch: ev('1', 1),
          drillDiameter: ev('5.16', 5.16),
          depth: { kind: 'through' },
          threadLength: ev('10', 10),
          representation: 'realistic',
          tiltAngle: ev('0', 0),
          tiltAzimuth: ev('0', 0),
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].representation');
  });

  it('穴の深さ(depth.kind)に知らない値があれば断る', () => {
    const document = rawDocument({
      solids: [rawHole({ depth: { kind: 'partial', depth: ev('5', 5) } })],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].depth.kind');
  });

  it('部分形状の指紋(fingerprint.kind)に知らない値があれば断る', () => {
    const document = rawDocument({
      solids: [
        rawHole({ face: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'curve' } } }),
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].face.fingerprint.kind');
  });

  it('C 面取りの大きさ(size.kind)に知らない値があれば断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'chamfer-1',
          kind: 'chamfer',
          name: 'C面取り1',
          suppressed: false,
          targetFeatureId: 'extrude-1',
          targets: [rawFaceRef()],
          size: { kind: 'threeDistances', distance: ev('1', 1) },
          swapReferenceFace: false,
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].size.kind');
  });

  it('パターンの向き(direction.kind)に知らない値があれば断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'pattern-1',
          kind: 'pattern',
          name: '直線パターン1',
          suppressed: false,
          sourceFeatureId: 'hole-1',
          placement: {
            kind: 'linear',
            direction: { kind: 'curve' },
            spacing: ev('20', 20),
            count: ev('3', 3),
            symmetric: false,
          },
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].placement.direction.kind');
  });

  it('パターンの並べ方(placement.kind)に知らない値があれば断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'pattern-1',
          kind: 'pattern',
          name: 'パターン1',
          suppressed: false,
          sourceFeatureId: 'hole-1',
          placement: { kind: 'spiral' },
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].placement.kind');
  });

  it('部分形状の参照(SubShapeRef)に fingerprint 欄が無ければ、どこが無いかを添えて断る', () => {
    const document = rawDocument({
      solids: [rawHole({ face: { bodyFeatureId: 'extrude-1', index: 0 } })],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.solids[0].face.fingerprint');
  });

  it('中心の点参照(SketchPointRef)に pointFeatureId 欄が無ければ断る', () => {
    const document = rawDocument({
      solids: [rawHole({ centers: [{ sketchId: 'sketch-1' }] })],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.solids[0].centers[0].pointFeatureId');
  });

  it('R 面取りに radius 欄が無ければ断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'fillet-1',
          kind: 'fillet',
          name: 'R面取り1',
          suppressed: false,
          targetFeatureId: 'extrude-1',
          targets: [rawFaceRef()],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.solids[0].radius');
  });

  it('ばねに handedness 欄が無ければ断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'spring-1',
          kind: 'spring',
          name: 'ばね1',
          suppressed: false,
          origin: { sketchId: 'sketch-1', pointFeatureId: 'point-1' },
          axis: { kind: 'world', axis: 'z' },
          tiltAngle: ev('0', 0),
          tiltAzimuth: ev('0', 0),
          length: ev('20', 20),
          pitch: ev('5', 5),
          turns: ev('4', 4),
          derived: 'length',
          coilDiameter: ev('20', 20),
          wireDiameter: ev('2', 2),
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.solids[0].handedness');
  });

  it('パターンに placement 欄が無ければ断る', () => {
    const document = rawDocument({
      solids: [
        { id: 'pattern-1', kind: 'pattern', name: 'パターン1', suppressed: false, sourceFeatureId: 'hole-1' },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.solids[0].placement');
  });

  it('指紋の奥にある欄(area)の型違いも、その場所を添えて断る', () => {
    const document = rawDocument({
      solids: [
        rawHole({
          face: {
            bodyFeatureId: 'extrude-1',
            index: 0,
            fingerprint: { ...rawFaceFingerprint(), area: '100' },
          },
        }),
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].face.fingerprint.area');
  });

  it('指紋の axis が3要素でない配列なら断る', () => {
    const document = rawDocument({
      solids: [
        rawHole({
          face: {
            bodyFeatureId: 'extrude-1',
            index: 0,
            fingerprint: { ...rawFaceFingerprint(), axis: [0, 0] },
          },
        }),
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].face.fingerprint.axis');
  });
});

describe('読み込みの断り方(FR-504、NFR-UX-5)', () => {
  it('JSON として読めないものは例外にせず理由を返す', () => {
    const error = expectError(parseDocument('{'));
    expect(error.code).toBe('invalidJson');
    expect(error.message).toContain('読み取れませんでした');
  });

  it('空文字列も理由を返す', () => {
    expect(expectError(parseDocument('')).code).toBe('invalidJson');
  });

  it('JSON がオブジェクトでなければ PointerCAD のファイルではないと断る', () => {
    const error = expectError(parseDocument('[1,2,3]'));
    expect(error.code).toBe('notPcad');
    expect(error.message).toContain('PointerCAD の部品ファイルではないようです');
  });

  it('封筒の版が数値でなければ PointerCAD のファイルではないと断る', () => {
    const error = expectError(parseDocument(rawFile({ schema: 'two' })));
    expect(error.code).toBe('notPcad');
  });

  it('アプリ名が違えば PointerCAD のファイルではないと断る', () => {
    const error = expectError(parseDocument(rawFile({ app: 'OtherCAD' })));
    expect(error.code).toBe('notPcad');
    expect(error.message).toContain('PointerCAD の部品ファイルではないようです');
  });

  it('種別の欄が無ければ PointerCAD のファイルではないと断る(統括の決定、要件§8)', () => {
    const file = JSON.stringify({
      schema: PCAD_SCHEMA_VERSION,
      app: PCAD_APP_NAME,
      savedAt: SAVED_AT,
      document: rawDocument(),
    });
    const error = expectError(parseDocument(file));
    expect(error.code).toBe('notPcad');
    expect(error.message).toContain('PointerCAD の部品ファイルではないようです');
  });

  it('種別が part でなければ、その種別を添えてまだ対応していないと断る', () => {
    const error = expectError(parseDocument(rawFile({ kind: 'assembly' })));
    expect(error.code).toBe('unsupportedKind');
    expect(error.message).toContain('assembly');
    expect(error.message).toContain('まだ対応していません');
  });

  it('種別が図面でも同じように断る(P2 は部品だけを読む)', () => {
    const error = expectError(parseDocument(rawFile({ kind: 'drawing' })));
    expect(error.code).toBe('unsupportedKind');
    expect(error.message).toContain('drawing');
  });

  it('種別が文字列でなければ PointerCAD のファイルではないと断る', () => {
    const error = expectError(parseDocument(rawFile({ kind: 2 })));
    expect(error.code).toBe('notPcad');
  });

  // 現在の版が 6(P5 タスク5)になったので、断るべき「新しすぎる版」も 7 に更新する。
  it('版 7 は「新しい版で保存されています」と断る', () => {
    const error = expectError(parseDocument(rawFile({ schema: 7 })));
    expect(error.code).toBe('unsupportedNewVersion');
    expect(error.message).toContain('新しい版の PointerCAD で保存されています');
    expect(error.message).toContain('7');
  });

  it('版 1 は「対応していない古い版です」と断る(版2への移行表が無いため)', () => {
    const error = expectError(parseDocument(rawFile({ schema: 1 })));
    expect(error.code).toBe('unsupportedOldVersion');
    expect(error.message).toContain('対応していない古い版です');
    expect(error.message).toContain('1');
  });

  it('封筒の版と文書の版が食い違えば断る(封筒の版を先に検査する)', () => {
    const error = expectError(
      parseDocument(rawFile({ document: rawDocument({ schemaVersion: 1 }) })),
    );
    expect(error.code).toBe('versionMismatch');
    expect(error.message).toContain('食い違って');
  });

  it('欄が無ければ、どこが無いかを添えて断る', () => {
    const document = rawDocument();
    delete document['name'];
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.name');
  });

  it('欄の型が違えば、どこが違うかを添えて断る', () => {
    const error = expectError(parseDocument(rawFile({ document: rawDocument({ sketches: {} }) })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.sketches');
  });

  it('深いところの欄の型違いも、その場所を添えて断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'extrude-1',
          kind: 'extrude',
          name: '押し出し1',
          suppressed: false,
          profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
          distance: { source: 10, value: 10, display: '10' },
          reversed: false,
          symmetric: false,
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].distance.source');
  });

  it('知らない種類のフィーチャーは断る', () => {
    const document = rawDocument({
      solids: [{ id: 'loft-1', kind: 'loft', name: 'ロフト1', suppressed: false }],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].kind');
  });

  it('保存時刻が文字列でなければ断る', () => {
    const error = expectError(parseDocument(rawFile({ savedAt: 20260903 })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('savedAt');
  });

  it('文書の欄そのものが無ければ断る', () => {
    const file = JSON.stringify({
      schema: PCAD_SCHEMA_VERSION,
      kind: PCAD_DOCUMENT_KIND,
      app: PCAD_APP_NAME,
      savedAt: SAVED_AT,
    });
    const error = expectError(parseDocument(file));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document');
  });
});

describe('読み方の規則(計画書 タスク14)', () => {
  it('知らない欄は捨てて読み込む', () => {
    const document = rawDocument({ foo: 1 });
    const parsed = expectOk(parseDocument(rawFile({ document })));
    expect(serializeDocument(parsed, { savedAt: SAVED_AT })).not.toContain('foo');
    expect(Object.keys(parsed).sort()).toEqual([
      'activeSketchId',
      // 外観の割り当て(FR-1106〜1110、P5 タスク5)。読み手は常に空の表で補う(§0.a-0.15)。
      'appearance',
      'id',
      'name',
      // パラメータ表(FR-207、P4b タスク2)。読み手は常に空の配列で補う(中身は版5から)。
      'parameters',
      'references',
      'schemaVersion',
      'sketches',
      'solids',
    ]);
  });

  it('式の評価値が数値でなければ NaN として読み、ファイルは開ける(FR-504)', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'extrude-1',
          kind: 'extrude',
          name: '押し出し1',
          suppressed: false,
          profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
          distance: { source: '5*2', value: '十', display: '10' },
          reversed: false,
          symmetric: false,
        },
      ],
    });
    const parsed = expectOk(parseDocument(rawFile({ document })));
    const feature = parsed.solids[0];
    if (feature.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(feature.distance.source).toBe('5*2');
    expect(Number.isNaN(feature.distance.value)).toBe(true);
  });

  it('式の評価値の欄そのものが無ければ断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'extrude-1',
          kind: 'extrude',
          name: '押し出し1',
          suppressed: false,
          profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
          distance: { source: '5*2', display: '10' },
          reversed: false,
          symmetric: false,
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.solids[0].distance.value');
  });

  it('読めないフィーチャーが 1 つでもあればファイル全体を断る(半端に開かない)', () => {
    const document = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'point-1',
              kind: 'point',
              name: '点1',
              planeId: 'xy',
              at: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
            },
            { id: 'point-2', kind: 'point', name: '点2', planeId: 'zz' },
          ],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.message).toContain('document.sketches[0].features[1]');
  });
});

describe('基準ジオメトリの読み書き(FR-328、FR-329、P4 タスク9)', () => {
  it('4 種類の基準ジオメトリと 7 種類の平面の指定が往復しても変わらない', () => {
    const document = richDocument();
    const text = serializeDocument(document, { savedAt: SAVED_AT });
    const parsed = expectOk(parseDocument(text));
    expect(parsed.references).toEqual(document.references);
    expect(parsed.references).toHaveLength(16);
  });

  it('平面の指定の 7 種類が書き出しに現れる', () => {
    const text = serializeDocument(richDocument(), { savedAt: SAVED_AT });
    for (const kind of [
      'threePoints',
      'pointAndEdge',
      'pointAndAxis',
      'pointAndParallelFace',
      'face',
      'workPlane',
      'tilted',
    ]) {
      expect(text, kind).toContain(`"kind": "${kind}"`);
    }
  });

  // P4 タスク31(§0.a-0.24)で版4になった: references の無い版3のファイルは
  // SCHEMA_MIGRATIONS[3] が空配列で補ってから開く(版4自身はこの欄を必須にする)。
  it('references の欄が無い版 3 のファイルも開ける(移行で空の履歴として読む)', () => {
    const raw = withoutReferences(rawDocument({ schemaVersion: 3 }));
    expect('references' in raw).toBe(false);
    const parsed = expectOk(parseDocument(rawFile({ schema: 3, document: raw })));
    expect(parsed.references).toEqual([]);
    // 読み直したものを書き出すと、現在の版・欄ありの形へ正規化される。
    const text = serializeDocument(parsed, { savedAt: SAVED_AT });
    expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
    expect(text).toContain('"references": []');
  });

  it('版4になったのに references の欄が無ければ断る(寛容な読みは版3までに限る)', () => {
    const raw = withoutReferences(rawDocument());
    expect('references' in raw).toBe(false);
    const error = expectError(parseDocument(rawFile({ document: raw })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('references');
  });

  it('基準ジオメトリの欄が壊れていればファイル全体を断る(場所つき)', () => {
    const broken = rawDocument({
      references: [{ id: 'referencePlane-1', kind: 'referencePlane', name: '作業平面1' }],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('references');
  });

  it('回転軸・パターンの向きに基準軸を選んだ文書も往復できる(FR-329)', () => {
    const document: PartDocument = {
      ...richDocument(),
      solids: [
        {
          id: 'revolve-1',
          kind: 'revolve',
          name: '回転1',
          suppressed: false,
          profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
          axis: { kind: 'reference', referenceFeatureId: 'referenceAxis-1' },
          angle: ev('90', 90),
          reversed: false,
        },
      ],
    };
    const parsed = expectOk(parseDocument(serializeDocument(document, { savedAt: SAVED_AT })));
    expect(parsed.solids[0]).toEqual(document.solids[0]);
  });

  it('作図面に任意の作業平面の id を持つスケッチも往復できる(WorkPlaneId の拡張)', () => {
    const document: PartDocument = {
      ...richDocument(),
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'point-1',
              kind: 'point',
              name: '点1',
              planeId: 'referencePlane-6',
              at: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
            },
          ],
        },
      ],
      solids: [],
    };
    const parsed = expectOk(parseDocument(serializeDocument(document, { savedAt: SAVED_AT })));
    expect(parsed.sketches[0].features[0].planeId).toBe('referencePlane-6');
  });

  it('作図面の id が空文字なら断る', () => {
    const broken = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'point-1',
              kind: 'point',
              name: '点1',
              planeId: '',
              at: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
            },
          ],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.message).toContain('planeId');
  });
});

describe('3D スケッチの読み書き(FR-330、P4 タスク10)', () => {
  /** 立体の頂点の指紋(P3 §2.2.2)。3D スケッチの点はこれを基準にする。 */
  function vertexRef(bodyFeatureId: string, index: number): SubShapeRef {
    return { bodyFeatureId, index, fingerprint: { kind: 'vertex', position: [40, 30, 10] } };
  }

  /** 作図面 'free' の点(立体の頂点を基準)と、向きを持つ円弧。 */
  function freeSketch(): SketchDocument {
    return {
      id: 'sketch-1',
      name: 'スケッチ1',
      features: [
        {
          id: 'point-1',
          kind: 'point',
          name: '点1',
          planeId: 'free',
          at: {
            mode: 'relative',
            base: { kind: 'subShape', ref: vertexRef('extrude-1', 7) },
            dx: ev('0', 0),
            dy: ev('0', 0),
            dz: ev('0', 0),
          },
        },
        {
          id: 'arc-1',
          kind: 'arc',
          name: '円弧1',
          planeId: 'free',
          center: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
          radius: ev('10', 10),
          startAngle: ev('0', 0),
          endAngle: ev('90', 90),
          construction: false,
          freeOrientation: {
            normal: { mode: 'absolute', x: ev('0', 0), y: ev('1', 1), z: ev('0', 0) },
            xAxis: { mode: 'absolute', x: ev('1', 1), y: ev('0', 0), z: ev('0', 0) },
          },
        },
      ],
    };
  }

  /** 作図面の上の円弧だけを持つスケッチ(向きの欄を持たないことの確認用)。 */
  function planeArcSketch(): SketchDocument {
    return {
      id: 'sketch-1',
      name: 'スケッチ1',
      features: [
        {
          id: 'arc-1',
          kind: 'arc',
          name: '円弧1',
          planeId: 'xy',
          center: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
          radius: ev('10', 10),
          startAngle: ev('0', 0),
          endAngle: ev('90', 90),
          construction: false,
        },
      ],
    };
  }

  function documentWith(sketch: SketchDocument): PartDocument {
    return { ...createEmptyPartDocument(), sketches: [sketch] };
  }

  it('立体の頂点の参照と円弧の向きが往復で一致する', () => {
    const document = documentWith(freeSketch());
    expect(roundTrip(document)).toEqual(document);
  });

  it('保存した頂点の参照は、読み戻しても同じ位置に解決できる(指紋をそのまま保つ)', () => {
    const roundTripped = roundTrip(documentWith(freeSketch()));
    const resolved = resolveSketch(roundTripped.sketches[0]);
    expect(resolved.errors).toEqual([]);
    expect(resolved.points[0].position).toEqual([40, 30, 10]);
    // 向きの指定も生きていて、法線 (0,1,0) の円弧として解ける。
    expect(resolved.arcs[0].normal).toEqual([0, 1, 0]);
    expect(resolved.arcs[0].xAxis).toEqual([1, 0, 0]);
  });

  it('作図面の上の円弧には向きの欄を書かない(版 3 以前の読み手が読めるまま)', () => {
    const text = serializeDocument(documentWith(planeArcSketch()), { savedAt: SAVED_AT });
    expect(text).not.toContain('freeOrientation');
    const arc = roundTrip(documentWith(planeArcSketch())).sketches[0].features[0];
    if (arc.kind !== 'arc') {
      throw new Error('最初の要素は円弧のはず');
    }
    // 欄そのものが無い(undefined が入った状態にもしない)。
    expect('freeOrientation' in arc).toBe(false);
  });

  // タスク10の時点では freeOrientation・subShape 参照のどちらも省略可能なので
  // 版は3のまま上げなかった(前方互換が壊れないため)。P4 タスク31(§0.a-0.24)で
  // 版4へ上げたのは construction・point列の layout・references の3件が理由で、
  // この2件(freeOrientation・subShape 参照)は版4になった今も省略可能なまま
  // (`readFreeOrientation` のコメント参照。§0.a-0.24 は移行対象にしていない)。
  it('freeOrientation・subShape 参照は現在の版でも省略可能(前方互換とは無関係な理由で版が上がった)', () => {
    const text = serializeDocument(documentWith(freeSketch()), { savedAt: SAVED_AT });
    expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
    expect(PCAD_SCHEMA_VERSION).toBe(6);
  });
});

describe('オフセットの往復(P4 タスク15、FR-321)', () => {
  const offset: SketchFeature = {
    id: 'offset-1',
    kind: 'offset',
    name: 'オフセット1',
    planeId: 'xy',
    source: [{ featureId: 'rectangle-1' }, { featureId: 'line-1', index: 2 }],
    distance: ev('5*2', 10),
    side: 'inside',
    corner: 'sharp',
    construction: true,
  };

  it('元の要素・距離・側・角がすべて往復で一致する', () => {
    const document = documentWithSketchFeature(offset);
    expect(roundTrip(document).sketches[0].features[0]).toEqual(offset);
  });

  it('ずらした後の曲線は保存しない(導出できるものは保存しない)', () => {
    const text = serializeDocument(documentWithSketchFeature(offset), { savedAt: SAVED_AT });
    expect(text).toContain('"kind": "offset"');
    expect(text).toContain('"side": "inside"');
    expect(text).toContain('"corner": "sharp"');
    // ずらした結果の曲線は書き出さない(再計算で導く)。
    expect(text).not.toContain('"curves"');
  });

  it('側が知らない値なら、その場所を添えて断る(FR-504、NFR-UX-5)', () => {
    const broken = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'offset-1',
              kind: 'offset',
              name: 'オフセット1',
              planeId: 'xy',
              source: [{ featureId: 'rectangle-1' }],
              distance: ev('5', 5),
              side: 'ひだり',
              corner: 'round',
              construction: false,
            },
          ],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.message).toContain('side');
  });

  it('角が知らない値なら、その場所を添えて断る', () => {
    const broken = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'offset-1',
              kind: 'offset',
              name: 'オフセット1',
              planeId: 'xy',
              source: [{ featureId: 'rectangle-1' }],
              distance: ev('5', 5),
              side: 'outside',
              corner: 'まる',
              construction: false,
            },
          ],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.message).toContain('corner');
  });
});

describe('ミラー・複写・配列複写の往復(P4 タスク20、FR-324)', () => {
  const mirrorByAxis: SketchFeature = {
    id: 'copy-1',
    kind: 'copy',
    name: '複製1',
    planeId: 'xy',
    source: [{ featureId: 'rectangle-1' }, { featureId: 'line-1', index: 2 }],
    placement: { kind: 'mirror', basis: { kind: 'axis', axis: { featureId: 'line-9' } } },
    construction: true,
  };

  const mirrorByPlane: SketchFeature = {
    ...mirrorByAxis,
    placement: { kind: 'mirror', basis: { kind: 'plane', planeId: 'referencePlane-1' } },
    construction: false,
  };

  const translate: SketchFeature = {
    ...mirrorByAxis,
    placement: {
      kind: 'translate',
      delta: { mode: 'absolute', x: ev('a*2', 20), y: ev('0', 0), z: ev('0', 0) },
    },
    construction: false,
  };

  const linearArray: SketchFeature = {
    ...mirrorByAxis,
    placement: {
      kind: 'linearArray',
      direction: { mode: 'absolute', x: ev('1', 1), y: ev('0', 0), z: ev('0', 0) },
      spacing: ev('20', 20),
      count: ev('3', 3),
    },
    construction: false,
  };

  const circularArray: SketchFeature = {
    ...mirrorByAxis,
    placement: {
      kind: 'circularArray',
      center: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      angle: ev('90', 90),
      count: ev('4', 4),
      fullCircle: true,
    },
    construction: false,
  };

  it('4 通りの複製のしかたがすべて往復で一致する', () => {
    for (const feature of [mirrorByAxis, mirrorByPlane, translate, linearArray, circularArray]) {
      expect(roundTrip(documentWithSketchFeature(feature)).sketches[0].features[0]).toEqual(
        feature,
      );
    }
  });

  it('複製された曲線は保存しない(導出できるものは保存しない)', () => {
    const text = serializeDocument(documentWithSketchFeature(linearArray), { savedAt: SAVED_AT });
    expect(text).toContain('"kind": "copy"');
    expect(text).toContain('"kind": "linearArray"');
    expect(text).not.toContain('"curves"');
  });

  it('鏡の基準は軸と平面のどちらか一方だけを持つ(欄が混ざらない)', () => {
    const text = serializeDocument(documentWithSketchFeature(mirrorByAxis), { savedAt: SAVED_AT });
    expect(text).toContain('"kind": "axis"');
    expect(text).not.toContain('"planeId": null');
  });

  // タスク20の時点では新種(copy)を足しただけで既存の欄は変えていないので版は3のまま
  // 上げなかった。P4 タスク31(§0.a-0.24)で版4へ上げたのは construction・点列の
  // layout・references の3件が理由で、この copy 自体とは無関係(現在の版を確認するだけ)。
  it('現在の版で書き出される(copy 自体は版が上がった理由ではない)', () => {
    const text = serializeDocument(documentWithSketchFeature(linearArray), { savedAt: SAVED_AT });
    expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
  });

  it('知らない並べ方なら、その場所を添えて断る(FR-504、NFR-UX-5)', () => {
    const broken = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'copy-1',
              kind: 'copy',
              name: '複製1',
              planeId: 'xy',
              source: [{ featureId: 'line-1' }],
              placement: { kind: 'ならべる', spacing: ev('20', 20), count: ev('3', 3) },
              construction: false,
            },
          ],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.message).toContain('placement');
  });

  it('知らない鏡の基準なら、その場所を添えて断る', () => {
    const broken = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'copy-1',
              kind: 'copy',
              name: '複製1',
              planeId: 'xy',
              source: [{ featureId: 'line-1' }],
              placement: { kind: 'mirror', basis: { kind: 'かがみ' } },
              construction: false,
            },
          ],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.message).toContain('basis');
  });

  it('個数の欄が欠けていれば断る(欠けた欄を既定値で埋めない)', () => {
    const broken = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [
            {
              id: 'copy-1',
              kind: 'copy',
              name: '複製1',
              planeId: 'xy',
              source: [{ featureId: 'line-1' }],
              placement: {
                kind: 'linearArray',
                direction: { mode: 'absolute', x: ev('1', 1), y: ev('0', 0), z: ev('0', 0) },
                spacing: ev('20', 20),
              },
              construction: false,
            },
          ],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.message).toContain('count');
  });

  it('読み込んだ複製は解決に使える(元の矩形をミラーして 4 本になる)', () => {
    const sketch: SketchDocument = {
      id: 'sketch-1',
      name: 'スケッチ1',
      features: [
        {
          id: 'line-9',
          kind: 'line',
          name: '線分9',
          planeId: 'xy',
          from: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
          to: { mode: 'absolute', x: ev('0', 0), y: ev('10', 10), z: ev('0', 0) },
          construction: true,
        },
        {
          id: 'rectangle-1',
          kind: 'rectangle',
          name: '矩形1',
          planeId: 'xy',
          corner1: { mode: 'absolute', x: ev('10', 10), y: ev('0', 0), z: ev('0', 0) },
          corner2: { mode: 'absolute', x: ev('50', 50), y: ev('30', 30), z: ev('0', 0) },
          construction: false,
        },
        {
          id: 'copy-1',
          kind: 'copy',
          name: '複製1',
          planeId: 'xy',
          source: [{ featureId: 'rectangle-1' }],
          placement: { kind: 'mirror', basis: { kind: 'axis', axis: { featureId: 'line-9' } } },
          construction: false,
        },
      ],
    };
    const restored = roundTrip({ ...createEmptyPartDocument(), sketches: [sketch] });
    const resolved = resolveSketch(restored.sketches[0]);
    expect(resolved.errors).toEqual([]);
    expect(resolved.curvesByFeature.get('copy-1')).toHaveLength(4);
  });
});

describe('投影・交差の往復(P4 タスク25、FR-325)', () => {
  const source: SubShapeRef = {
    bodyFeatureId: 'extrude-1',
    index: 4,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [20, 15, 10],
      axis: [0, 0, 1],
      radius: null,
    },
  };

  const projection: SketchFeature = {
    id: 'projectedCurve-1',
    name: '投影1',
    planeId: 'xy',
    kind: 'projectedCurve',
    source,
    construction: false,
  };

  const section: SketchFeature = {
    id: 'planeSection-1',
    name: '断面1',
    planeId: 'xz',
    kind: 'planeSection',
    targetFeatureId: 'extrude-1',
    construction: true,
  };

  function sketchWith(...features: SketchFeature[]): PartDocument {
    return {
      ...createEmptyPartDocument(),
      sketches: [{ id: 'sketch-1', name: 'スケッチ1', features }],
    };
  }

  it('投影は投影元の面の指紋ごと往復で一致する', () => {
    const restored = roundTrip(sketchWith(projection));
    expect(restored.sketches[0].features[0]).toEqual(projection);
  });

  it('交差は相手の立体の id と構築線の印が往復で一致する', () => {
    const restored = roundTrip(sketchWith(section));
    expect(restored.sketches[0].features[0]).toEqual(section);
  });

  it('投影された曲線そのものは保存しない(再計算で導く、rules/04)', () => {
    const json = JSON.parse(
      serializeDocument(sketchWith(projection), { savedAt: SAVED_AT }),
    ) as Record<string, unknown>;
    const text = JSON.stringify(json);
    expect(text).toContain('projectedCurve');
    // 曲線の欄(curves / segments)は 1 つも書かれない。
    expect(text).not.toContain('"curves"');
    expect(text).not.toContain('"segments"');
  });

  it('往復した投影・交差はそのまま解決でき、形が無ければ pendingProjections へ積む', () => {
    const restored = roundTrip(sketchWith(projection, section));
    const resolved = resolveSketch(restored.sketches[0]);
    expect(resolved.errors).toEqual([]);
    expect(resolved.pendingProjections.map((pending) => pending.featureId)).toEqual([
      'projectedCurve-1',
      'planeSection-1',
    ]);
  });

  // タスク25の時点では新種(projectedCurve・planeSection)を足しただけで版は3のまま
  // 上げなかった。P4 タスク31(§0.a-0.24)で版4へ上げたのは construction・点列の
  // layout・references の3件が理由で、この2種類自体とは無関係(現在の版を確認するだけ)。
  it('現在の版で書き出される(projectedCurve・planeSection 自体は版が上がった理由ではない)', () => {
    const json = JSON.parse(
      serializeDocument(sketchWith(projection), { savedAt: SAVED_AT }),
    ) as { readonly schema: number; readonly document: { readonly schemaVersion: number } };
    expect(json.schema).toBe(PCAD_SCHEMA_VERSION);
    expect(json.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
  });
});

describe('パラメータ表の往復(FR-207、P4b タスク21)', () => {
  it('3件のパラメータが名前・式・単位・説明・並び順のまま往復する', () => {
    const document = richDocument();
    const restored = roundTrip(document);
    expect(restored.parameters).toEqual(document.parameters);
    expect(restored.parameters.map((parameter) => parameter.name)).toEqual([
      '板厚',
      '個数',
      '角度',
    ]);
  });

  it('日本語の名前と、他のパラメータを参照する式がそのまま往復する', () => {
    const restored = roundTrip(richDocument());
    const count = restored.parameters[1];
    expect(count.name).toBe('個数');
    expect(count.value).toEqual(ev('板厚 + 1', 4));
  });

  it('単位3種(mm・none・degree)が往復する', () => {
    const restored = roundTrip(richDocument());
    expect(restored.parameters.map((parameter) => parameter.unit)).toEqual([
      'mm',
      'none',
      'degree',
    ]);
  });

  it('知らない単位が入った JSON は場所を添えて断る', () => {
    const broken = rawDocument({
      parameters: [{ name: 'x', value: ev('1', 1), unit: 'inch', description: '' }],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('unit');
  });
});

describe('拘束の往復(FR-313、P4b タスク21)', () => {
  function documentWithConstraints(): PartDocument {
    return { ...createEmptyPartDocument(), sketches: [richSketch()] };
  }

  it('14種類すべての拘束が id・名前・対象・目標値の式のまま往復する', () => {
    const restored = roundTrip(documentWithConstraints());
    const constraints = restored.sketches[0].constraints ?? [];
    expect(constraints).toEqual(richConstraints());
    expect(constraints).toHaveLength(14);
    expect(new Set(constraints.map((constraint) => constraint.kind)).size).toBe(14);
  });

  it('距離拘束の目標値はパラメータ表を参照する式のまま保存される(幅 / 2)', () => {
    const restored = roundTrip(documentWithConstraints());
    const constraints = restored.sketches[0].constraints ?? [];
    const distance = constraints.find((constraint) => constraint.kind === 'distance');
    if (distance === undefined || distance.kind !== 'distance') {
      throw new Error('距離拘束のはず');
    }
    expect(distance.length.source).toBe('幅 / 2');
  });

  it('知らない拘束の種類が入った JSON は場所を添えて断る', () => {
    const broken = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [],
          constraints: [{ id: 'c-1', name: '謎1', kind: 'これはない' }],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('kind');
  });

  it('拘束の id がスケッチをまたいで重なっていれば理由つきで断る', () => {
    const broken = rawDocument({
      sketches: [
        {
          id: 'sketch-1',
          name: 'スケッチ1',
          features: [],
          constraints: [
            { id: 'dup-1', name: '固定1', kind: 'fix', target: { kind: 'point', pointId: 'p' } },
          ],
        },
        {
          id: 'sketch-2',
          name: 'スケッチ2',
          features: [],
          constraints: [
            { id: 'dup-1', name: '固定2', kind: 'fix', target: { kind: 'point', pointId: 'q' } },
          ],
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document: broken })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('dup-1');
  });
});

describe('球面上の点の読み書き(FR-431、P5 タスク19)', () => {
  /** 球面上の点を基準にした 3D スケッチの点。座標は保存されない(要件§8)。 */
  const gridPoint: SketchFeature = {
    id: 'point-1',
    kind: 'point',
    name: '点1',
    planeId: 'free',
    at: {
      mode: 'relative',
      base: {
        kind: 'sphereGrid',
        sphereFeatureId: 'primitive-1',
        latitude: ev('30*2', 60),
        longitude: ev('45', 45),
      },
      dx: ev('0', 0),
      dy: ev('0', 0),
      dz: ev('0', 0),
    },
  };

  it('球の id と緯度・経度の式が往復で一致する', () => {
    const document = documentWithSketchFeature(gridPoint);
    expect(roundTrip(document).sketches[0].features[0]).toEqual(gridPoint);
  });

  it('式の文字列がそのまま残る(FR-202)', () => {
    const text = serializeDocument(documentWithSketchFeature(gridPoint), { savedAt: SAVED_AT });
    expect(text).toContain('"sphereGrid"');
    expect(text).toContain('"30*2"');
    // 解決した座標は書かない(導出できるものは保存しない。要件§8)。
    expect(text).not.toContain('6.123724356957945');
  });

  it('種類が 1 つ増えただけなのでスキーマ版は変えない', () => {
    const text = serializeDocument(documentWithSketchFeature(gridPoint), { savedAt: SAVED_AT });
    expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
    expect(PCAD_SCHEMA_VERSION).toBe(6);
  });

  it('緯度の欄が欠けていれば場所つきで断る', () => {
    const text = serializeDocument(documentWithSketchFeature(gridPoint), { savedAt: SAVED_AT });
    const broken = text.replace('"latitude"', '"latitudo"');
    const error = expectError(parseDocument(broken));
    expect(error.message).toContain('latitude');
  });
});
