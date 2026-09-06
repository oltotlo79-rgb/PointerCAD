import {
  createEmptyPartDocument,
  createPrimitiveFeature,
  emptyAppearanceTable,
  // P5 の Should 群(§2.11、タスク43)の既定値を与える口。省略された欄の意味を
  // io に写さず、model の 1 か所から取る。
  extrudeShapingOf,
  // 可変半径フィレット(FR-426、P5 タスク46)の既定を与える口。
  filletRadiusOf,
  holeEntryOf,
  PART_SCHEMA_VERSION,
  resolveSketch,
  // 球へつなぐときの点の数の選択肢(§0.a-0.74)。3 値すべての往復に使う(P5 タスク47)。
  RULED_SPHERE_SEGMENT_CHOICES,
  sketchConstraints,
  type AppearanceTable,
  type ExtrudeEnd,
  type HoleEntry,
  type LoftFeature,
  type PartDocument,
  type Parameter,
  // 平面による切断(FR-432、P5 タスク27c)。切断面は作業平面と同じ型を共有する。
  type PlaneSpec,
  // 点の指定 6 種の往復(P5 タスク47)。
  type PointReference,
  type PrimitiveFeature,
  type PrimitiveShape,
  type ReferenceFeature,
  type RuledFeature,
  // 選択セット(FR-112)と下絵(FR-332)の往復(P6 タスク37・38)。
  type SelectionSet,
  type SketchCanvas,
  type SketchConstraint,
  type SketchDocument,
  type SketchFeature,
  type SolidFeature,
  // 24 種の全欄の往復(P5 タスク47)。種類が増えたら見本の表が型エラーになる。
  type SolidFeatureKind,
  type SolidOrigin,
  type SubShapeRef,
  type SurfaceOperation,
  type ThicknessSide,
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
  PCAD_TEMPLATE_KIND,
  PCAD_TOOL_DEFAULT_KEYS,
  SCHEMA_MIGRATIONS,
  type PcadToolDefaults,
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
    // 選択セット(FR-112、P6 タスク37)。立体と部分形状の両方、空のセット、同じ名前の
    // 2 つを含む(§2.13 の表)。
    selectionSets: richSelectionSets(),
    // 下絵(FR-332、P6 タスク38)。式のままの寸法・向き・不透明度と、非表示の 1 枚。
    canvases: richCanvases(),
  };
}

/**
 * 選択セット3件(FR-112、P6 タスク37)。①立体と面を混ぜたセット、②同じ名前の別のセット
 * (§2.13「同じ名前を 2 つ ── 許す」)、③空のセット(同「空のセット ── 作れる」)。
 */
function richSelectionSets(): readonly SelectionSet[] {
  return [
    {
      id: 'selectionSet-1',
      name: '上面',
      members: [
        { kind: 'body', bodyFeatureId: 'extrude-1' },
        { kind: 'face', ref: richAppearanceFaceRef() },
      ],
    },
    {
      id: 'selectionSet-2',
      name: '上面',
      members: [{ kind: 'face', ref: richAppearanceFaceRef() }],
    },
    { id: 'selectionSet-3', name: '後で足す', members: [] },
  ];
}

/**
 * 下絵2枚(FR-332、P6 タスク38)。1 枚目は基準の作図面に式のままの寸法で貼ったもの、
 * 2 枚目は任意の作業平面に貼った非表示の下絵(§2.14 の表の「入切」)。
 */
function richCanvases(): readonly SketchCanvas[] {
  return [
    {
      id: 'canvas-1',
      name: '下絵1',
      plane: 'xy',
      imageId: 'canvas-1',
      width: ev('800*0.5', 400),
      height: ev('600*0.5', 300),
      origin: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      rotation: ev('30', 30),
      opacity: ev('0.5', 0.5),
      visible: true,
    },
    {
      id: 'canvas-2',
      name: '下絵2',
      plane: 'referencePlane-1',
      imageId: 'canvas-2',
      width: ev('100', 100),
      height: ev('50', 50),
      origin: {
        mode: 'polar',
        base: { kind: 'point', pointId: 'point-1' },
        distance: ev('10', 10),
        azimuth: ev('45', 45),
        elevation: ev('0', 0),
      },
      rotation: ev('0', 0),
      opacity: ev('1', 1),
      visible: false,
    },
  ];
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
    // 版7(P6 タスク37・38)で必須になった 2 欄。`references` / `parameters` / `appearance`
    // と同じく既定では妥当な空配列にし、欠けた版を模すときだけ下の関数で外す。
    selectionSets: [],
    canvases: [],
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

/** `rawDocument` の既定に入っている `selectionSets` を取り除く(欄が無い版6を模す)。 */
function withoutSelectionSets(document: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...document };
  delete copy['selectionSets'];
  return copy;
}

/** `rawDocument` の既定に入っている `canvases` を取り除く(欄が無い版6を模す)。 */
function withoutCanvases(document: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...document };
  delete copy['canvases'];
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

// P4 タスク31(§0.a-0.24)で版 3 → 4 へ上げ、P4b タスク21(§0.a-0.17)で版 4 → 5 へ上げ、
// P5 タスク5(§0.a-0.15)で版 5 → 6 へ、P6 タスク21(§0.a-0.55)で版 6 → 7 へ上げた。
describe(
  '.pcad の版(§0.a-0.3、§0.a-0.22、§0.a-0.24、§0.a-0.17、P5 タスク5・§0.a-0.15、' +
    'P6 タスク21・§0.a-0.55)',
  () => {
    it('封筒の版は 7 で、部品文書の版と同じ値である', () => {
      expect(PCAD_SCHEMA_VERSION).toBe(7);
      expect(PCAD_SCHEMA_VERSION).toBe(PART_SCHEMA_VERSION);
    });

    it(
      '版を上げる変換表は版 2→3・3→4・4→5・5→6・6→7 の5つを持つ' +
        '(P3・P4 タスク31・P4b タスク21・P5 タスク5・P6 タスク21が版を1つずつ足したため)',
      () => {
        expect(Object.keys(SCHEMA_MIGRATIONS)).toEqual(['2', '3', '4', '5', '6']);
      },
    );
  },
);

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
  // P5 タスク5(§0.a-0.15)で 5 → 6、P6 タスク21(§0.a-0.55)で 6 → 7 に更新
  // (PCAD_SCHEMA_VERSION の値そのもの)。
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
      selectionSets: [],
      canvases: [],
    };
    expect(serializeDocument(document, { savedAt: SAVED_AT })).toBe(
      `{
  "schema": 7,
  "kind": "part",
  "app": "PointerCAD",
  "savedAt": "2026-09-03T01:23:45.678Z",
  "document": {
    "id": "part-1",
    "name": "部品1",
    "schemaVersion": 7,
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
    },
    "selectionSets": [],
    "canvases": []
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
      canvases: document.canvases,
      selectionSets: document.selectionSets,
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
      expect(text).toContain('"schema": 7');
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
    // P6 タスク37・38 で `selectionSets` / `canvases` の 2 欄が増え、空の配列 2 つぶんの
    // 45 バイト(`,\n    "selectionSets": [],\n    "canvases": []`)だけ長くなった
    // (1313 → 1358)。中身のある文書ではこの 2 欄が増えるだけで他は 1 バイトも変わらない。
    expect(Buffer.byteLength(text, 'utf8')).toBe(1358);
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

  it('知らない種類のフィーチャー(未実装の厚み付け等)は断る(§0.a-0.1)', () => {
    // 見本は P5 タスク46 まで「シェル」だったが、くり抜き(FR-418)が実装された
    // (`SOLID_FEATURE_KINDS` に入った)ので、まだ無い「厚み付け」に取り替えた。
    // **確かめている規則(知らない `kind` は `invalidField` で断る)は変えていない。**
    const document = rawDocument({
      solids: [{ id: 'thicken-1', kind: 'thicken', name: '厚み付け1', suppressed: false }],
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
      // 版7 で足した 2 欄(P6 タスク37・38)。版2 のファイルは本来持たないが、`parameters` /
      // `appearance` と同じくここでは空で書いておく(移行が保つことを併せて確かめる)。
      selectionSets: [],
      canvases: [],
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

  // 現在の版が 7(P6 タスク21)になったので、断るべき「新しすぎる版」も 8 に更新する。
  it('版 8 は「新しい版で保存されています」と断る', () => {
    const error = expectError(parseDocument(rawFile({ schema: 8 })));
    expect(error.code).toBe('unsupportedNewVersion');
    expect(error.message).toContain('新しい版の PointerCAD で保存されています');
    expect(error.message).toContain('8');
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
    // 例に使う `kind` は**将来も実装しない名前**にする(P5 タスク25 で `loft` が実在の
    // 種類になり、この検査が「欄が足りない」で落ちたため。docs/報告記録.md 2026-09-05)。
    const document = rawDocument({
      solids: [{ id: 'unknown-1', kind: 'unknownKind', name: '謎1', suppressed: false }],
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
      // 下絵の画像(FR-332、P6 タスク38)。読み手は常に配列で補う(版6以前は移行が空にする)。
      'canvases',
      'id',
      'name',
      // パラメータ表(FR-207、P4b タスク2)。読み手は常に空の配列で補う(中身は版5から)。
      'parameters',
      'references',
      'schemaVersion',
      // 選択セット(FR-112、P6 タスク37)。`canvases` と同じ道筋で必須の欄になった。
      'selectionSets',
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
    expect(PCAD_SCHEMA_VERSION).toBe(7);
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

  it('種類が 1 つ増えただけでは(この検査を書いた時点では)スキーマ版は変わらなかった', () => {
    const text = serializeDocument(documentWithSketchFeature(gridPoint), { savedAt: SAVED_AT });
    expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
    // P6 タスク21(§0.a-0.55)が別の理由(ZIP の添付・選択セット・下絵)で 7 へ上げた。
    expect(PCAD_SCHEMA_VERSION).toBe(7);
  });

  it('緯度の欄が欠けていれば場所つきで断る', () => {
    const text = serializeDocument(documentWithSketchFeature(gridPoint), { savedAt: SAVED_AT });
    const broken = text.replace('"latitude"', '"latitudo"');
    const error = expectError(parseDocument(broken));
    expect(error.message).toContain('latitude');
  });
});

describe('面をつなぐ・ロフトの読み書き(FR-430、FR-410、FR-801、P5 タスク25 の最小の枝)', () => {
  /** 立体の面を輪郭にするときの指紋(§0.a-0.73)。面であることまで読み書きされる。 */
  const SOLID_FACE_REF: SubShapeRef = {
    bodyFeatureId: 'extrude-1',
    index: 0,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [20, 15, 10],
      axis: [0, 0, 1],
      radius: null,
    },
  };

  it('面をつなぐ(スケッチの面 × 球)が往復で一致する', () => {
    const feature: RuledFeature = {
      id: 'ruled-1',
      kind: 'ruled',
      name: '面をつなぐ1',
      suppressed: false,
      first: { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-1' } },
      second: { kind: 'sphere', sphereFeatureId: 'sphere-1' },
      twist: ev('1+1', 2),
      sphereSegments: 48,
    };
    const parsed = roundTrip(documentWithSolid(feature));
    expect(parsed.solids[0]).toEqual(feature);
  });

  it('ロフト(3 断面、立体の面を含む)が往復で一致する', () => {
    const feature: LoftFeature = {
      id: 'loft-1',
      kind: 'loft',
      name: 'ロフト1',
      suppressed: false,
      sections: [
        { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-1' } },
        { kind: 'solidFace', ref: SOLID_FACE_REF },
        { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-2' } },
      ],
      twist: ev('0', 0),
    };
    const parsed = roundTrip(documentWithSolid(feature));
    expect(parsed.solids[0]).toEqual(feature);
  });

  it('sphereSegments の欄が無い古い文書は既定の 24 として読む(§0.a-0.74)', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'ruled-1',
          kind: 'ruled',
          name: '面をつなぐ1',
          suppressed: false,
          first: { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-1' } },
          second: { kind: 'sphere', sphereFeatureId: 'sphere-1' },
          twist: ev('0', 0),
        },
      ],
    });
    const parsed = expectOk(parseDocument(rawFile({ document })));
    const ruled = parsed.solids[0];
    if (ruled.kind !== 'ruled') {
      throw new Error('面をつなぐのはず');
    }
    expect(ruled.sphereSegments).toBe(24);
  });

  it('sphereSegments に 24 / 48 / 72 以外(36)があれば断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'ruled-1',
          kind: 'ruled',
          name: '面をつなぐ1',
          suppressed: false,
          first: { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-1' } },
          second: { kind: 'sphere', sphereFeatureId: 'sphere-1' },
          twist: ev('0', 0),
          sphereSegments: 36,
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].sphereSegments');
  });

  it('断面に知らない kind があれば断る', () => {
    const document = rawDocument({
      solids: [
        {
          id: 'loft-1',
          kind: 'loft',
          name: 'ロフト1',
          suppressed: false,
          sections: [
            { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-1' } },
            { kind: 'edgeLoop', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-2' } },
          ],
          twist: ev('0', 0),
        },
      ],
    });
    const error = expectError(parseDocument(rawFile({ document })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].sections[1].kind');
  });
});

// ---------------------------------------------------------------------------
// P5 の Should 群(§2.11、タスク43)の読み書き。
//
// **この段は「型が通るだけの最小の枝」**(種類ごとに往復 1 件と、欄が無い古い文書の
// 読み込み)で、断りの網羅・移行・妥当性検査の作り込みは **タスク47** の担当である。
// ---------------------------------------------------------------------------

/** 面の指紋 1 つ(欄を埋めるためだけのもの)。 */
function shouldFaceRef(bodyFeatureId = 'extrude-1', index = 0): SubShapeRef {
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

describe('Should 群の読み書き(P5 §2.11、タスク43)', () => {
  it('抜き勾配(FR-417)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'draft-1',
      kind: 'draft',
      name: '抜き勾配1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      faces: [shouldFaceRef('extrude-1', 1), shouldFaceRef('extrude-1', 2)],
      neutralFace: shouldFaceRef(),
      angle: ev('1', 1),
      reversed: true,
    });
    expect(roundTrip(document)).toEqual(document);
  });

  it('ミラー(FR-419)は作業平面の id でも立体の面でも往復で一致する', () => {
    const onPlane = documentWithSolid({
      id: 'mirror-1',
      kind: 'mirror',
      name: 'ミラー1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      plane: { kind: 'workPlane', planeId: 'xy' },
    });
    expect(roundTrip(onPlane)).toEqual(onPlane);
    const onFace = documentWithSolid({
      id: 'mirror-1',
      kind: 'mirror',
      name: 'ミラー1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      plane: { kind: 'face', face: shouldFaceRef() },
    });
    expect(roundTrip(onFace)).toEqual(onFace);
  });

  it('移動/回転(FR-424)は回転軸が null でも往復で一致する', () => {
    const withAxis = documentWithSolid({
      id: 'transform-1',
      kind: 'transform',
      name: '移動・回転1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      translation: [ev('10', 10), ev('0', 0), ev('2.5', 2.5)],
      rotationAxis: { kind: 'world', axis: 'z' },
      rotationAngle: ev('45', 45),
    });
    expect(roundTrip(withAxis)).toEqual(withAxis);
    const noAxis = documentWithSolid({
      id: 'transform-1',
      kind: 'transform',
      name: '移動・回転1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      translation: [ev('10', 10), ev('0', 0), ev('0', 0)],
      rotationAxis: null,
      rotationAngle: ev('0', 0),
    });
    const parsed = roundTrip(noAxis);
    expect(parsed).toEqual(noAxis);
    const moved = parsed.solids[0];
    if (moved.kind !== 'transform') {
      throw new Error('移動/回転のはず');
    }
    // `null` は「回さない」という意味を持つ値なので、undefined にしない。
    expect(moved.rotationAxis).toBeNull();
  });

  it('拡大縮小(FR-424)は全体倍率でも軸ごとでも往復で一致する', () => {
    const uniform = documentWithSolid({
      id: 'scale-1',
      kind: 'scale',
      name: '拡大縮小1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      origin: { kind: 'origin' },
      factor: { kind: 'uniform', value: ev('2', 2) },
    });
    expect(roundTrip(uniform)).toEqual(uniform);
    const perAxis = documentWithSolid({
      id: 'scale-1',
      kind: 'scale',
      name: '拡大縮小1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      origin: { kind: 'subShape', ref: shouldFaceRef() },
      factor: { kind: 'perAxis', x: ev('2', 2), y: ev('1', 1), z: ev('0.5', 0.5) },
    });
    expect(roundTrip(perAxis)).toEqual(perAxis);
  });

  it('スイープ(FR-409)が往復で一致する(経路は曲線の id の並び)', () => {
    const document = documentWithSolid({
      id: 'sweep-1',
      kind: 'sweep',
      name: 'スイープ1',
      suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      path: { sketchId: 'sketch-1', curveIds: ['line-1', 'arc-1', 'line-2'] },
      frenet: true,
    });
    const parsed = roundTrip(document);
    expect(parsed).toEqual(document);
    const sweep = parsed.solids[0];
    if (sweep.kind !== 'sweep') {
      throw new Error('スイープのはず');
    }
    // 並びが意味を持つ(経路は書かれた順につながっている前提)。
    expect(sweep.path.curveIds).toEqual(['line-1', 'arc-1', 'line-2']);
  });

  it('リブ(FR-420)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'rib-1',
      kind: 'rib',
      name: 'リブ1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      profile: { sketchId: 'sketch-1', curveIds: ['line-1'] },
      thickness: ev('3', 3),
      side: 'positive',
      extendToBody: false,
    });
    expect(roundTrip(document)).toEqual(document);
  });

  it('エンボス(FR-421)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'emboss-1',
      kind: 'emboss',
      name: 'エンボス1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      face: shouldFaceRef(),
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      height: ev('2', 2),
      raised: true,
    });
    expect(roundTrip(document)).toEqual(document);
  });

  it('外ねじ(FR-423)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'threadShaft-1',
      kind: 'threadShaft',
      name: '外ねじ1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      face: shouldFaceRef(),
      nominal: 'M10',
      series: 'fine',
      pitch: ev('1.25', 1.25),
      length: ev('20', 20),
      fromEnd: 'last',
      modeled: true,
    });
    expect(roundTrip(document)).toEqual(document);
  });

  it('曲面(FR-428)は 5 種の作り方すべてが往復で一致する', () => {
    const operations: readonly SurfaceOperation[] = [
      {
        kind: 'extrude',
        profile: { sketchId: 'sketch-1', curveIds: ['line-1'] },
        distance: ev('20', 20),
        reversed: false,
      },
      {
        kind: 'revolve',
        profile: { sketchId: 'sketch-1', curveIds: ['arc-1'] },
        axis: { kind: 'line', line: { sketchId: 'sketch-1', lineFeatureId: 'line-1' } },
        angle: ev('360', 360),
        reversed: true,
      },
      { kind: 'planar', profile: { sketchId: 'sketch-1', curveIds: ['line-1', 'line-2'] } },
      {
        kind: 'loft',
        sections: [
          { sketchId: 'sketch-1', curveIds: ['line-1'] },
          { sketchId: 'sketch-1', curveIds: ['line-2'] },
        ],
        ruled: true,
      },
      { kind: 'face', targetFeatureId: 'extrude-1', face: shouldFaceRef() },
    ];
    for (const operation of operations) {
      const document = documentWithSolid({
        id: 'surface-1',
        kind: 'surface',
        name: '曲面1',
        suppressed: false,
        operation,
      });
      expect(roundTrip(document)).toEqual(document);
    }
  });

  it('点の集まりへ複製(FR-425)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'pointPattern-1',
      kind: 'pattern',
      name: '点パターン1',
      suppressed: false,
      sourceFeatureId: 'hole-1',
      placement: {
        kind: 'points',
        points: [
          { kind: 'point', pointId: 'point-1' },
          { kind: 'subShape', ref: shouldFaceRef() },
          {
            kind: 'sphereGrid',
            sphereFeatureId: 'sphere-1',
            latitude: ev('30', 30),
            longitude: ev('60', 60),
          },
        ],
      },
    });
    const parsed = roundTrip(document);
    expect(parsed).toEqual(document);
    const pattern = parsed.solids[0];
    if (pattern.kind !== 'pattern' || pattern.placement.kind !== 'points') {
      throw new Error('点集合パターンのはず');
    }
    expect(pattern.placement.points).toHaveLength(3);
  });
});

describe('押し出しの終端・傾き・薄板と穴の入口の読み書き(FR-415、FR-401、FR-416、FR-422)', () => {
  it('5 欄すべてを持つ押し出しが往復で一致する', () => {
    const document = documentWithSolid({
      id: 'extrude-1',
      kind: 'extrude',
      name: '押し出し1',
      suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      distance: ev('10', 10),
      reversed: false,
      symmetric: false,
      end: { kind: 'toFace', face: shouldFaceRef('sew-1') },
      taperAngle: ev('5', 5),
      taperOutward: true,
      thickness: ev('2', 2),
      thicknessSide: 'both',
    });
    expect(roundTrip(document)).toEqual(document);
  });

  it('終端の 4 種すべてが往復で一致する', () => {
    const ends: readonly ExtrudeEnd[] = [
      { kind: 'distance' },
      { kind: 'symmetric' },
      { kind: 'toFace', face: shouldFaceRef('sew-1') },
      { kind: 'toNext' },
    ];
    for (const end of ends) {
      const document = documentWithSolid({
        id: 'extrude-1',
        kind: 'extrude',
        name: '押し出し1',
        suppressed: false,
        profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
        distance: ev('10', 10),
        reversed: false,
        symmetric: false,
        end,
      });
      expect(roundTrip(document)).toEqual(document);
    }
  });

  it('欄の無い古い押し出しは欄の無いまま読め、既定は extrudeShapingOf が与える', () => {
    // 版 6 までのファイルはこの 5 欄を 1 つも持たない。**読んだあとも増やさない**
    // (増やすと同じファイルを開いて保存しただけで中身が変わってしまう)。
    const file = rawFile({
      document: rawDocument({
        solids: [
          {
            id: 'extrude-1',
            kind: 'extrude',
            name: '押し出し1',
            suppressed: false,
            profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
            distance: { source: '10', value: 10, display: '10' },
            reversed: false,
            symmetric: true,
          },
        ],
      }),
    });
    const extrude = expectOk(parseDocument(file)).solids[0];
    if (extrude.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(extrude.end).toBeUndefined();
    expect(extrude.taperAngle).toBeUndefined();
    expect(extrude.taperOutward).toBeUndefined();
    expect(extrude.thickness).toBeUndefined();
    expect(extrude.thicknessSide).toBeUndefined();
    // 両側へ出していた古い押し出しは、既定を通しても両側のまま(片側へ変わらない)。
    expect(extrudeShapingOf(extrude).end).toEqual({ kind: 'symmetric' });
    expect(extrudeShapingOf(extrude).thickness).toBeNull();
  });

  it('欄の無い古い押し出しは書き出しても欄が増えない(往復でファイルが太らない)', () => {
    const document = documentWithSolid({
      id: 'extrude-1',
      kind: 'extrude',
      name: '押し出し1',
      suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      distance: ev('10', 10),
      reversed: false,
      symmetric: false,
    });
    const text = serializeDocument(document, { savedAt: SAVED_AT });
    expect(text).not.toContain('taperAngle');
    expect(text).not.toContain('thicknessSide');
    expect(roundTrip(document)).toEqual(document);
  });

  it('穴の入口(ざぐり・皿もみ・広げない)の 3 種が往復で一致する', () => {
    const entries: readonly HoleEntry[] = [
      { kind: 'plain' },
      { kind: 'counterbore', diameter: ev('11', 11), depth: ev('4', 4) },
      { kind: 'countersink', diameter: ev('12', 12), angle: ev('90', 90) },
    ];
    for (const entry of entries) {
      const document = documentWithSolid({
        id: 'hole-1',
        kind: 'hole',
        name: '穴1',
        suppressed: false,
        targetFeatureId: 'extrude-1',
        face: shouldFaceRef(),
        centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
        diameter: ev('6', 6),
        depth: { kind: 'through' },
        entry,
        tiltAngle: ev('0', 0),
        tiltAzimuth: ev('0', 0),
      });
      expect(roundTrip(document)).toEqual(document);
    }
  });

  it('ねじ穴もざぐりを持てる(穴とまったく同じ扱い)', () => {
    const document = documentWithSolid({
      id: 'threadHole-1',
      kind: 'threadHole',
      name: 'ねじ穴1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      face: shouldFaceRef(),
      centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
      designation: 'M6',
      series: 'coarse',
      pitch: ev('1', 1),
      drillDiameter: ev('5', 5),
      depth: { kind: 'through' },
      entry: { kind: 'countersink', diameter: ev('12', 12), angle: ev('90', 90) },
      threadLength: ev('10', 10),
      representation: 'simplified',
      tiltAngle: ev('0', 0),
      tiltAzimuth: ev('0', 0),
    });
    expect(roundTrip(document)).toEqual(document);
  });

  it('入口の欄が無い古い穴は入口の無いまま読め、既定は holeEntryOf が「広げない」を返す', () => {
    const file = rawFile({
      document: rawDocument({
        solids: [
          {
            id: 'hole-1',
            kind: 'hole',
            name: '穴1',
            suppressed: false,
            targetFeatureId: 'extrude-1',
            face: shouldFaceRef(),
            centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
            diameter: { source: '6', value: 6, display: '6' },
            depth: { kind: 'through' },
            tiltAngle: { source: '0', value: 0, display: '0' },
            tiltAzimuth: { source: '0', value: 0, display: '0' },
          },
        ],
      }),
    });
    const hole = expectOk(parseDocument(file)).solids[0];
    if (hole.kind !== 'hole') {
      throw new Error('穴のはず');
    }
    expect(hole.entry).toBeUndefined();
    expect(holeEntryOf(hole)).toEqual({ kind: 'plain' });
  });

  it('知らない入口・終端・作り方の種類は断る(新しい欄の意味を推測しない)', () => {
    const withUnknownEntry = rawFile({
      document: rawDocument({
        solids: [
          {
            id: 'hole-1',
            kind: 'hole',
            name: '穴1',
            suppressed: false,
            targetFeatureId: 'extrude-1',
            face: shouldFaceRef(),
            centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
            diameter: { source: '6', value: 6, display: '6' },
            depth: { kind: 'through' },
            entry: { kind: 'spotface' },
            tiltAngle: { source: '0', value: 0, display: '0' },
            tiltAzimuth: { source: '0', value: 0, display: '0' },
          },
        ],
      }),
    });
    expect(expectError(parseDocument(withUnknownEntry)).code).toBe('invalidField');
    const withUnknownKind = rawFile({
      document: rawDocument({
        // 上と同じ理由で、まだ無い「厚み付け」を知らない種類の見本にする(タスク46)。
        solids: [{ id: 'x-1', kind: 'thicken', name: '厚み付け1', suppressed: false }],
      }),
    });
    expect(expectError(parseDocument(withUnknownKind)).code).toBe('invalidField');
  });
});

describe('くり抜き・可変半径・面のオフセットの読み書き(FR-418、FR-426、FR-428。P5 タスク46)', () => {
  it('くり抜き(FR-418)は開ける面が 1 枚でも 0 枚でも往復で一致する', () => {
    const opened = documentWithSolid({
      id: 'shell-1',
      kind: 'shell',
      name: 'くり抜き1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      openFaces: [shouldFaceRef('extrude-1', 1), shouldFaceRef('extrude-1', 2)],
      thickness: ev('2', 2),
      outward: false,
    });
    expect(roundTrip(opened)).toEqual(opened);
    const closed = documentWithSolid({
      id: 'shell-1',
      kind: 'shell',
      name: 'くり抜き1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      openFaces: [],
      thickness: ev('2', 2),
      outward: true,
    });
    expect(roundTrip(closed)).toEqual(closed);
  });

  it('くり抜きの厚さは式のまま往復する(FR-202)', () => {
    const document = documentWithSolid({
      id: 'shell-1',
      kind: 'shell',
      name: 'くり抜き1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      openFaces: [],
      thickness: { source: '板厚 / 2', value: 1.5, display: '1.5' },
      outward: false,
    });
    const parsed = roundTrip(document).solids[0];
    if (parsed.kind !== 'shell') {
      throw new Error('テストの前提が壊れている: くり抜きでない');
    }
    expect(parsed.thickness.source).toBe('板厚 / 2');
  });

  it('可変半径フィレット(FR-426)は終点側の半径が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'fillet-1',
      kind: 'fillet',
      name: 'R面取り1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      targets: [shouldFaceRef()],
      radius: ev('2', 2),
      radiusEnd: ev('5', 5),
    });
    const parsed = roundTrip(document).solids[0];
    if (parsed.kind !== 'fillet') {
      throw new Error('テストの前提が壊れている: R面取りでない');
    }
    expect(parsed.radiusEnd).toEqual(ev('5', 5));
    expect(roundTrip(document)).toEqual(document);
  });

  it('終点側の半径が無い古い R 面取りは、欄が無いまま読める(一定半径)', () => {
    const document = documentWithSolid({
      id: 'fillet-1',
      kind: 'fillet',
      name: 'R面取り1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      targets: [shouldFaceRef()],
      radius: ev('2', 2),
    });
    const parsed = roundTrip(document).solids[0];
    if (parsed.kind !== 'fillet') {
      throw new Error('テストの前提が壊れている: R面取りでない');
    }
    expect(parsed.radiusEnd).toBeUndefined();
    expect(filletRadiusOf(parsed)).toEqual({ kind: 'constant', radius: ev('2', 2) });
  });

  it(
    'radiusEnd に null が書かれた R 面取りも、欄が無いのと同じ一定半径として読める' +
      '(書き手が undefined も null も欄ごと落とすのと対称にする。' +
      'docs/報告記録.md 2026-09-05 23:08 の t47 指摘①)',
    () => {
      const document = expectOk(
        parseDocument(
          rawFile({
            document: rawDocument({
              solids: [
                {
                  id: 'fillet-1',
                  kind: 'fillet',
                  name: 'R面取り1',
                  suppressed: false,
                  targetFeatureId: 'extrude-1',
                  targets: [edgeRef('extrude-1', 0)],
                  radius: ev('2', 2),
                  radiusEnd: null,
                },
              ],
            }),
          }),
        ),
      );
      const fillet = document.solids[0];
      if (fillet.kind !== 'fillet') {
        throw new Error('テストの前提が壊れている: R面取りでない');
      }
      expect(fillet.radiusEnd).toBeUndefined();
      expect(filletRadiusOf(fillet)).toEqual({ kind: 'constant', radius: ev('2', 2) });
    },
  );

  it('一定半径の R 面取りは書き出しにも `radiusEnd` を出さない(版 5 前半と同じ字面)', () => {
    const document = documentWithSolid({
      id: 'fillet-1',
      kind: 'fillet',
      name: 'R面取り1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      targets: [shouldFaceRef()],
      radius: ev('2', 2),
    });
    const text = JSON.stringify(serializeDocument(document, { savedAt: SAVED_AT }));
    expect(text).not.toContain('radiusEnd');
  });

  it('面のオフセット(FR-428 の 6 種目)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'surface-1',
      kind: 'surface',
      name: '曲面1',
      suppressed: false,
      operation: {
        kind: 'offset',
        targetFeatureId: 'extrude-1',
        face: shouldFaceRef(),
        distance: ev('5', 5),
      },
    });
    expect(roundTrip(document)).toEqual(document);
  });

  it('くり抜きの欄が足りなければ断る(欄の意味を推測しない)', () => {
    const missing = rawFile({
      document: rawDocument({
        solids: [
          {
            id: 'shell-1',
            kind: 'shell',
            name: 'くり抜き1',
            suppressed: false,
            targetFeatureId: 'extrude-1',
            openFaces: [],
          },
        ],
      }),
    });
    expect(expectError(parseDocument(missing)).message).toContain('thickness');
  });
});

describe('平面による切断の読み書き(FR-432、§2.9b。P5 タスク27c)', () => {
  it('単独の切断(pairedWith が null)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'cut-1',
      kind: 'cut',
      name: '切断1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      plane: { kind: 'workPlane', planeId: 'xy', offset: ev('5', 5) },
      keep: 'positive',
      pairedWith: null,
    });
    expect(roundTrip(document)).toEqual(document);
  });

  it('対になった切断(pairedWith が相手の id、残す側が反対)が往復で一致する', () => {
    const document = documentWithSolid({
      id: 'cut-2',
      kind: 'cut',
      name: '切断2',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      plane: { kind: 'workPlane', planeId: 'xy', offset: ev('5', 5) },
      keep: 'negative',
      pairedWith: 'cut-1',
    });
    expect(roundTrip(document)).toEqual(document);
  });

  it('切断面は 7 種のどれでも往復する(作業平面と同じ読み書きを共有する)', () => {
    const planes: readonly PlaneSpec[] = [
      {
        kind: 'threePoints',
        p1: { kind: 'point', pointId: 'point-1' },
        p2: { kind: 'point', pointId: 'point-2' },
        p3: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
      },
      {
        kind: 'pointAndEdge',
        point: { kind: 'origin' },
        edge: shouldFaceRef('extrude-1', 4),
        mode: 'containing',
      },
      {
        kind: 'pointAndAxis',
        point: { kind: 'origin' },
        axis: { kind: 'world', axis: 'z' },
        tilt: ev('30', 30),
        azimuth: ev('0', 0),
      },
      {
        kind: 'pointAndParallelFace',
        point: { kind: 'origin' },
        face: shouldFaceRef(),
      },
      { kind: 'face', face: shouldFaceRef(), offset: ev('0', 0) },
      { kind: 'workPlane', planeId: 'referencePlane-1', offset: ev('2', 2) },
      {
        kind: 'tilted',
        base: 'xy',
        axis: { kind: 'reference', referenceFeatureId: 'referenceAxis-1' },
        angle: ev('15', 15),
      },
    ];
    for (const plane of planes) {
      const document = documentWithSolid({
        id: 'cut-1',
        kind: 'cut',
        name: '切断1',
        suppressed: false,
        targetFeatureId: 'extrude-1',
        plane,
        keep: 'positive',
        pairedWith: null,
      });
      expect(roundTrip(document)).toEqual(document);
    }
  });

  it('切断面の中の式は式のまま往復する(FR-202)', () => {
    const document = documentWithSolid({
      id: 'cut-1',
      kind: 'cut',
      name: '切断1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      plane: {
        kind: 'workPlane',
        planeId: 'xy',
        offset: { source: '板厚 * 2', value: 6, display: '6' },
      },
      keep: 'positive',
      pairedWith: null,
    });
    const parsed = roundTrip(document).solids[0];
    if (parsed.kind !== 'cut') {
      throw new Error('テストの前提が壊れている: 切断でない');
    }
    if (parsed.plane.kind !== 'workPlane') {
      throw new Error('テストの前提が壊れている: 作業平面でない');
    }
    expect(parsed.plane.offset.source).toBe('板厚 * 2');
  });

  it('知らない残す側の値は断る(エラーコードは増やさない)', () => {
    const file = rawFile({
      document: rawDocument({
        solids: [
          {
            id: 'cut-1',
            kind: 'cut',
            name: '切断1',
            suppressed: false,
            targetFeatureId: 'extrude-1',
            plane: { kind: 'workPlane', planeId: 'xy', offset: ev('5', 5) },
            keep: 'both',
            pairedWith: null,
          },
        ],
      }),
    });
    expect(expectError(parseDocument(file)).code).toBe('invalidField');
  });

  it('pairedWith が文字列でも null でもなければ断る', () => {
    const file = rawFile({
      document: rawDocument({
        solids: [
          {
            id: 'cut-1',
            kind: 'cut',
            name: '切断1',
            suppressed: false,
            targetFeatureId: 'extrude-1',
            plane: { kind: 'workPlane', planeId: 'xy', offset: ev('5', 5) },
            keep: 'positive',
            pairedWith: 3,
          },
        ],
      }),
    });
    expect(expectError(parseDocument(file)).message).toContain('pairedWith');
  });

  it('切断面が欠けていれば断る(欄の意味を推測しない)', () => {
    const file = rawFile({
      document: rawDocument({
        solids: [
          {
            id: 'cut-1',
            kind: 'cut',
            name: '切断1',
            suppressed: false,
            targetFeatureId: 'extrude-1',
            keep: 'positive',
            pairedWith: null,
          },
        ],
      }),
    });
    expect(expectError(parseDocument(file)).message).toContain('plane');
  });
});

// ---------------------------------------------------------------------------
// P5 タスク47: io の読み書きの本実装(FR-801、FR-202、NFR-RE-3)。
//
// タスク43・46・27c が置いたのは「型が通るだけの最小の枝」(種類ごとに往復 1 件)だった。
// ここでは **24 種の全欄の往復・古い版の読み込み・断りの網羅・書き出しの字面** まで広げる。
// スキーマ版は 6 のままで、移行(SCHEMA_MIGRATIONS)は 1 つも増やさない(欄の追加だけ)。
// ---------------------------------------------------------------------------

/**
 * 種類ごとのソリッドフィーチャー 1 件ずつの表。**鍵が `SolidFeatureKind` そのもの**なので、
 * model が種類を 1 つ足すとこの表が型エラーになる(検査が黙って古びないための仕掛け)。
 */
type SolidFeatureByKind = {
  readonly [K in SolidFeatureKind]: Extract<SolidFeature, { readonly kind: K }>;
};

/** 点の指定 6 種(FR-330、FR-431 を含む)。点集合パターンに入れて往復を確かめる。 */
function allPointReferences(): readonly PointReference[] {
  return [
    { kind: 'origin' },
    { kind: 'previous' },
    { kind: 'point', pointId: 'point-1' },
    { kind: 'vertex', featureId: 'line-1', vertex: 'center' },
    { kind: 'subShape', ref: edgeRef('extrude-1', 9) },
    {
      kind: 'sphereGrid',
      sphereFeatureId: 'primitive-1',
      latitude: ev('30', 30),
      longitude: ev('60', 60),
    },
  ];
}

/**
 * 26 種すべてを、**省略できる欄も含めて全部埋めた**見本。参照(部分形状の指紋・
 * スケッチの面/点/曲線)と式は種類をまたいで一通り出てくるようにしてある。
 */
function allSolidFeatures(): SolidFeatureByKind {
  return {
    extrude: {
      id: 'extrude-1',
      kind: 'extrude',
      name: '押し出し1',
      suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      distance: ev('板厚 * 2', 6),
      reversed: true,
      symmetric: false,
      end: { kind: 'toFace', face: faceRef('sew-1', 2) },
      taperAngle: ev('3', 3),
      taperOutward: true,
      thickness: ev('1.5', 1.5),
      thicknessSide: 'outer',
    },
    revolve: {
      id: 'revolve-1',
      kind: 'revolve',
      name: '回転1',
      suppressed: true,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-2' },
      axis: { kind: 'reference', referenceFeatureId: 'referenceAxis-1' },
      angle: ev('360', 360),
      reversed: false,
    },
    sew: {
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
    boolean: {
      id: 'boolean-1',
      kind: 'boolean',
      name: '差1',
      suppressed: false,
      operation: 'subtract',
      targetFeatureId: 'extrude-1',
      toolFeatureId: 'sew-1',
    },
    hole: {
      id: 'hole-1',
      kind: 'hole',
      name: '穴1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      face: faceRef('extrude-1', 3),
      centers: [
        { sketchId: 'sketch-1', pointFeatureId: 'point-1' },
        { sketchId: 'sketch-1', pointFeatureId: 'pointArray-1' },
      ],
      diameter: ev('6', 6),
      depth: { kind: 'blind', depth: ev('10', 10) },
      entry: { kind: 'counterbore', diameter: ev('11', 11), depth: ev('4', 4) },
      tiltAngle: ev('5', 5),
      tiltAzimuth: ev('45', 45),
    },
    threadHole: {
      id: 'threadHole-1',
      kind: 'threadHole',
      name: 'ねじ穴1',
      suppressed: false,
      targetFeatureId: 'hole-1',
      face: faceRef('hole-1', 5),
      centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
      designation: 'M6',
      series: 'coarse',
      pitch: ev('1', 1),
      drillDiameter: ev('5.16', 5.16),
      depth: { kind: 'through' },
      entry: { kind: 'countersink', diameter: ev('12', 12), angle: ev('90', 90) },
      threadLength: ev('10', 10),
      representation: 'modeled',
      tiltAngle: ev('0', 0),
      tiltAzimuth: ev('0', 0),
    },
    fillet: {
      id: 'fillet-1',
      kind: 'fillet',
      name: 'R面取り1',
      suppressed: false,
      targetFeatureId: 'threadHole-1',
      targets: [
        edgeRef('threadHole-1', 2),
        { bodyFeatureId: 'threadHole-1', index: 7, fingerprint: { kind: 'vertex', position: [4, 5, 6] } },
      ],
      radius: ev('2', 2),
      radiusEnd: ev('5', 5),
    },
    chamfer: {
      id: 'chamfer-1',
      kind: 'chamfer',
      name: 'C面取り1',
      suppressed: false,
      targetFeatureId: 'fillet-1',
      targets: [edgeRef('fillet-1', 0)],
      size: { kind: 'distanceAngle', distance: ev('1', 1), angle: ev('45', 45) },
      swapReferenceFace: true,
    },
    pattern: {
      id: 'pattern-1',
      kind: 'pattern',
      name: '点パターン1',
      suppressed: false,
      sourceFeatureId: 'hole-1',
      placement: { kind: 'points', points: allPointReferences() },
    },
    spring: {
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
      derived: 'turns',
      coilDiameter: ev('20', 20),
      wireDiameter: ev('2', 2),
      handedness: 'left',
    },
    primitive: {
      id: 'primitive-1',
      kind: 'primitive',
      name: '基本形状1',
      suppressed: false,
      origin: {
        kind: 'vertex',
        ref: { bodyFeatureId: 'extrude-1', index: 3, fingerprint: { kind: 'vertex', position: [1.5, 2.5, 3.5] } },
      },
      axis: { kind: 'world', axis: 'y' },
      shape: { kind: 'torus', majorRadius: ev('20', 20), minorRadius: ev('5', 5) },
    },
    ruled: {
      id: 'ruled-1',
      kind: 'ruled',
      name: '面をつなぐ1',
      suppressed: false,
      first: { kind: 'solidFace', ref: faceRef('extrude-1', 4) },
      second: { kind: 'sphere', sphereFeatureId: 'primitive-1' },
      twist: ev('1+1', 2),
      sphereSegments: 72,
    },
    loft: {
      id: 'loft-1',
      kind: 'loft',
      name: 'ロフト1',
      suppressed: false,
      sections: [
        { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-1' } },
        { kind: 'solidFace', ref: faceRef('extrude-1', 5) },
        { kind: 'sphere', sphereFeatureId: 'primitive-1' },
      ],
      twist: ev('0', 0),
    },
    draft: {
      id: 'draft-1',
      kind: 'draft',
      name: '抜き勾配1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      faces: [faceRef('extrude-1', 1), faceRef('extrude-1', 2)],
      neutralFace: faceRef('extrude-1', 0),
      angle: ev('1', 1),
      reversed: true,
    },
    mirror: {
      id: 'mirror-1',
      kind: 'mirror',
      name: 'ミラー1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      plane: { kind: 'face', face: faceRef('extrude-1', 6) },
    },
    transform: {
      id: 'transform-1',
      kind: 'transform',
      name: '移動・回転1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      translation: [ev('10', 10), ev('0', 0), ev('2.5', 2.5)],
      rotationAxis: { kind: 'reference', referenceFeatureId: 'referenceAxis-1' },
      rotationAngle: ev('45', 45),
    },
    scale: {
      id: 'scale-1',
      kind: 'scale',
      name: '拡大縮小1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      origin: { kind: 'previous' },
      factor: { kind: 'perAxis', x: ev('2', 2), y: ev('1', 1), z: ev('0.5', 0.5) },
    },
    sweep: {
      id: 'sweep-1',
      kind: 'sweep',
      name: 'スイープ1',
      suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      path: { sketchId: 'sketch-1', curveIds: ['line-1', 'arc-1', 'line-2'] },
      frenet: true,
    },
    rib: {
      id: 'rib-1',
      kind: 'rib',
      name: 'リブ1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      profile: { sketchId: 'sketch-1', curveIds: ['line-1'] },
      thickness: ev('3', 3),
      side: 'negative',
      extendToBody: true,
    },
    emboss: {
      id: 'emboss-1',
      kind: 'emboss',
      name: 'エンボス1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      face: faceRef('extrude-1', 7),
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-2' },
      height: ev('2', 2),
      raised: false,
    },
    threadShaft: {
      id: 'threadShaft-1',
      kind: 'threadShaft',
      name: '外ねじ1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      face: faceRef('extrude-1', 8),
      nominal: 'M10',
      series: 'fine',
      pitch: ev('1.25', 1.25),
      length: ev('20', 20),
      fromEnd: 'last',
      modeled: true,
    },
    surface: {
      id: 'surface-1',
      kind: 'surface',
      name: '曲面1',
      suppressed: false,
      operation: {
        kind: 'loft',
        sections: [
          { sketchId: 'sketch-1', curveIds: ['line-1'] },
          { sketchId: 'sketch-1', curveIds: ['line-2', 'arc-1'] },
        ],
        ruled: false,
      },
    },
    shell: {
      id: 'shell-1',
      kind: 'shell',
      name: 'くり抜き1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      openFaces: [faceRef('extrude-1', 1)],
      thickness: ev('2', 2),
      outward: true,
    },
    cut: {
      id: 'cut-1',
      kind: 'cut',
      name: '切断1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      plane: {
        kind: 'pointAndEdge',
        point: { kind: 'point', pointId: 'point-1' },
        edge: edgeRef('extrude-1', 3),
        mode: 'perpendicular',
      },
      keep: 'negative',
      pairedWith: 'cut-2',
    },
    // 読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8、タスク20)。
    // 形そのもの(B-rep / 三角形)は ZIP の別エントリなので、ここには名前と素性だけが入る。
    importedSolid: {
      id: 'importedSolid-1',
      kind: 'importedSolid',
      name: '読み込んだ形1',
      suppressed: false,
      shapeRef: 'shape-1',
      source: {
        format: 'step',
        fileName: 'bracket.step',
        unit: 'inch',
        byteLength: 20480,
        importedAt: '2026-09-06T00:00:00.000Z',
      },
      bodyKind: 'shell',
    },
    importedMesh: {
      id: 'importedMesh-1',
      kind: 'importedMesh',
      name: '読み込んだ三角形の形1',
      suppressed: true,
      meshRef: 'mesh-1',
      source: {
        format: 'stl',
        fileName: 'cover.stl',
        unit: 'mm',
        byteLength: 1284,
        importedAt: '2026-09-06T01:02:03.000Z',
      },
      triangleCount: 12,
      volume: 8000,
    },
  };
}

/** いくつかのソリッドフィーチャーだけを持つ最小の文書(`documentWithSolid` の複数版)。 */
function documentWithSolids(features: readonly SolidFeature[]): PartDocument {
  return { ...createEmptyPartDocument(), solids: features };
}

/** 26 種を並べた部品文書(順序は `allSolidFeatures` の欄の順)。 */
function documentWithAllSolids(): PartDocument {
  return documentWithSolids(Object.values(allSolidFeatures()));
}

describe('26 種すべての読み書き(P5 タスク47・P6 タスク20、FR-801、FR-202)', () => {
  it('26 種のソリッドフィーチャーが 1 つの文書で往復しても一致する', () => {
    const document = documentWithAllSolids();
    expect(document.solids).toHaveLength(26);
    expect(roundTrip(document)).toEqual(document);
  });

  it('26 種すべての kind が書き出しに現れる(種類を取りこぼしていない)', () => {
    const text = serializeDocument(documentWithAllSolids(), { savedAt: SAVED_AT });
    for (const kind of Object.keys(allSolidFeatures())) {
      expect(text).toContain(`"kind": "${kind}"`);
    }
  });

  it('26 種の文書は何度書き出しても同じ文字列になる(欄の順が決まっている)', () => {
    const document = documentWithAllSolids();
    const first = serializeDocument(document, { savedAt: SAVED_AT });
    const second = serializeDocument(document, { savedAt: SAVED_AT });
    expect(second).toBe(first);
    // 往復してから書き出しても同じ(読みが欄を並べ替えたり足したりしない)。
    expect(serializeDocument(roundTrip(document), { savedAt: SAVED_AT })).toBe(first);
  });

  it('部分形状の参照(指紋)は種類をまたいで数値まで一致する', () => {
    const restored = roundTrip(documentWithAllSolids());
    const draft = restored.solids.find((solid) => solid.kind === 'draft');
    if (draft === undefined || draft.kind !== 'draft') {
      throw new Error('抜き勾配のはず');
    }
    expect(draft.faces).toEqual([faceRef('extrude-1', 1), faceRef('extrude-1', 2)]);
    expect(draft.neutralFace.fingerprint).toEqual(faceRef('extrude-1', 0).fingerprint);
    const fillet = restored.solids.find((solid) => solid.kind === 'fillet');
    if (fillet === undefined || fillet.kind !== 'fillet') {
      throw new Error('R 面取りのはず');
    }
    // 辺・頂点の指紋も種類ごと(kind)保たれる。
    expect(fillet.targets[0].fingerprint.kind).toBe('edge');
    expect(fillet.targets[1].fingerprint).toEqual({ kind: 'vertex', position: [4, 5, 6] });
  });

  it('点の指定 6 種が往復で一致する(点集合パターンの中)', () => {
    const restored = roundTrip(documentWithAllSolids());
    const pattern = restored.solids.find((solid) => solid.kind === 'pattern');
    if (pattern === undefined || pattern.kind !== 'pattern' || pattern.placement.kind !== 'points') {
      throw new Error('点集合パターンのはず');
    }
    expect(pattern.placement.points).toEqual(allPointReferences());
    expect(pattern.placement.points).toHaveLength(6);
  });

  it('スケッチの面・点・曲線の並びへの参照が往復で一致する', () => {
    const restored = roundTrip(documentWithAllSolids());
    const sweep = restored.solids.find((solid) => solid.kind === 'sweep');
    if (sweep === undefined || sweep.kind !== 'sweep') {
      throw new Error('スイープのはず');
    }
    expect(sweep.profile).toEqual({ sketchId: 'sketch-1', faceFeatureId: 'face-1' });
    // 曲線の並びは順序が意味を持つので、並べ替えずにそのまま返る。
    expect(sweep.path.curveIds).toEqual(['line-1', 'arc-1', 'line-2']);
    const spring = restored.solids.find((solid) => solid.kind === 'spring');
    if (spring === undefined || spring.kind !== 'spring') {
      throw new Error('ばねのはず');
    }
    expect(spring.origin).toEqual({ sketchId: 'sketch-1', pointFeatureId: 'point-1' });
  });

  it('式は評価値ではなく式文字列のまま往復する(FR-202、押し出しの距離)', () => {
    const restored = roundTrip(documentWithAllSolids());
    const extrude = restored.solids.find((solid) => solid.kind === 'extrude');
    if (extrude === undefined || extrude.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(extrude.distance.source).toBe('板厚 * 2');
    expect(extrude.distance.value).toBe(6);
  });

  it('薄板の向き 3 種(inner / outer / both)がすべて往復で一致する', () => {
    const sides: readonly ThicknessSide[] = ['inner', 'outer', 'both'];
    for (const thicknessSide of sides) {
      const document = documentWithSolid({
        id: 'extrude-1',
        kind: 'extrude',
        name: '押し出し1',
        suppressed: false,
        profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
        distance: ev('10', 10),
        reversed: false,
        symmetric: false,
        thickness: ev('2', 2),
        thicknessSide,
      });
      expect(roundTrip(document)).toEqual(document);
    }
  });

  it('薄板の厚みの null(中実)は null のまま往復する(欄ごと省略にならない)', () => {
    const document = documentWithSolid({
      id: 'extrude-1',
      kind: 'extrude',
      name: '押し出し1',
      suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      distance: ev('10', 10),
      reversed: false,
      symmetric: false,
      thickness: null,
    });
    const parsed = roundTrip(document);
    expect(parsed).toEqual(document);
    const extrude = parsed.solids[0];
    if (extrude.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(extrude.thickness).toBeNull();
  });

  it('ねじ穴の入口 3 種すべてが往復で一致する(穴とまったく同じ扱い)', () => {
    const entries: readonly HoleEntry[] = [
      { kind: 'plain' },
      { kind: 'counterbore', diameter: ev('11', 11), depth: ev('4', 4) },
      { kind: 'countersink', diameter: ev('12', 12), angle: ev('90', 90) },
    ];
    for (const entry of entries) {
      const document = documentWithSolid({
        id: 'threadHole-1',
        kind: 'threadHole',
        name: 'ねじ穴1',
        suppressed: false,
        targetFeatureId: 'extrude-1',
        face: faceRef('extrude-1', 0),
        centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
        designation: 'M6',
        series: 'coarse',
        pitch: ev('1', 1),
        drillDiameter: ev('5', 5),
        depth: { kind: 'through' },
        entry,
        threadLength: ev('10', 10),
        representation: 'simplified',
        tiltAngle: ev('0', 0),
        tiltAzimuth: ev('0', 0),
      });
      expect(roundTrip(document)).toEqual(document);
    }
  });

  it('球へつなぐ点の数 3 値(24 / 48 / 72)がすべて往復で一致する', () => {
    for (const sphereSegments of RULED_SPHERE_SEGMENT_CHOICES) {
      const document = documentWithSolid({
        id: 'ruled-1',
        kind: 'ruled',
        name: '面をつなぐ1',
        suppressed: false,
        first: { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-1' } },
        second: { kind: 'sphere', sphereFeatureId: 'primitive-1' },
        twist: ev('0', 0),
        sphereSegments,
      });
      expect(roundTrip(document)).toEqual(document);
    }
  });

  it('曲面の作り方 6 種すべてが往復で一致する(FR-428)', () => {
    const operations: readonly SurfaceOperation[] = [
      {
        kind: 'extrude',
        profile: { sketchId: 'sketch-1', curveIds: ['line-1'] },
        distance: ev('20', 20),
        reversed: false,
      },
      {
        kind: 'revolve',
        profile: { sketchId: 'sketch-1', curveIds: ['arc-1'] },
        axis: { kind: 'reference', referenceFeatureId: 'referenceAxis-1' },
        angle: ev('360', 360),
        reversed: true,
      },
      { kind: 'planar', profile: { sketchId: 'sketch-1', curveIds: ['line-1', 'line-2'] } },
      {
        kind: 'loft',
        sections: [
          { sketchId: 'sketch-1', curveIds: ['line-1'] },
          { sketchId: 'sketch-1', curveIds: ['line-2'] },
        ],
        ruled: true,
      },
      { kind: 'face', targetFeatureId: 'extrude-1', face: faceRef('extrude-1', 0) },
      {
        kind: 'offset',
        targetFeatureId: 'extrude-1',
        face: faceRef('extrude-1', 1),
        distance: ev('5', 5),
      },
    ];
    expect(operations).toHaveLength(6);
    for (const operation of operations) {
      const document = documentWithSolid({
        id: 'surface-1',
        kind: 'surface',
        name: '曲面1',
        suppressed: false,
        operation,
      });
      expect(roundTrip(document)).toEqual(document);
    }
  });
});

describe('古いファイルの読み込み(NFR-RE-3、P5 タスク47)', () => {
  /** P5 が足した欄(end / taperAngle / thickness / entry / radiusEnd)を 1 つも持たない立体 3 件。 */
  function legacySolids(): readonly Record<string, unknown>[] {
    return [
      {
        id: 'extrude-1',
        kind: 'extrude',
        name: '押し出し1',
        suppressed: false,
        profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
        distance: ev('10', 10),
        reversed: false,
        symmetric: true,
      },
      {
        id: 'hole-1',
        kind: 'hole',
        name: '穴1',
        suppressed: false,
        targetFeatureId: 'extrude-1',
        face: faceRef('extrude-1', 0),
        centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
        diameter: ev('6', 6),
        depth: { kind: 'through' },
        tiltAngle: ev('0', 0),
        tiltAzimuth: ev('0', 0),
      },
      {
        id: 'fillet-1',
        kind: 'fillet',
        name: 'R面取り1',
        suppressed: false,
        targetFeatureId: 'hole-1',
        targets: [edgeRef('hole-1', 1)],
        radius: ev('2', 2),
      },
    ];
  }

  /** 版 4 として保存された生の文書(parameters も appearance も持たない)。 */
  function legacyRawFile(): string {
    return rawFile({
      schema: 4,
      document: withoutParameters(
        withoutAppearance(rawDocument({ schemaVersion: 4, solids: legacySolids() })),
      ),
    });
  }

  it('版 4 のファイル(P5 の欄を 1 つも持たない)がそのまま開ける', () => {
    const document = expectOk(parseDocument(legacyRawFile()));
    expect(document.solids).toHaveLength(3);
    expect(document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    expect(document.parameters).toEqual([]);
    expect(document.appearance.entries).toEqual([]);
  });

  it('版 4 の押し出しは欄が無いまま読め、既定は extrudeShapingOf が与える(両側・傾き 0・中実)', () => {
    const extrude = expectOk(parseDocument(legacyRawFile())).solids[0];
    if (extrude.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(extrude.end).toBeUndefined();
    expect(extrude.taperAngle).toBeUndefined();
    expect(extrude.thickness).toBeUndefined();
    const shaping = extrudeShapingOf(extrude);
    expect(shaping.end).toEqual({ kind: 'symmetric' });
    expect(shaping.taperAngle.value).toBe(0);
    expect(shaping.taperOutward).toBe(false);
    expect(shaping.thickness).toBeNull();
  });

  it('版 4 の穴は入口を持たず、R 面取りは終点側の半径を持たない(既定は model が与える)', () => {
    const solids = expectOk(parseDocument(legacyRawFile())).solids;
    const hole = solids[1];
    const fillet = solids[2];
    if (hole.kind !== 'hole' || fillet.kind !== 'fillet') {
      throw new Error('穴と R 面取りのはず');
    }
    expect(hole.entry).toBeUndefined();
    expect(holeEntryOf(hole)).toEqual({ kind: 'plain' });
    expect(fillet.radiusEnd).toBeUndefined();
    expect(filletRadiusOf(fillet)).toEqual({ kind: 'constant', radius: ev('2', 2) });
  });

  it('版 4 のファイルを開いて書き戻しても、P5 の欄は 1 つも増えない(往復でファイルが太らない)', () => {
    const document = expectOk(parseDocument(legacyRawFile()));
    const text = serializeDocument(document, { savedAt: SAVED_AT });
    for (const added of ['"end"', 'taperAngle', 'taperOutward', 'thicknessSide', '"entry"', 'radiusEnd']) {
      expect(text).not.toContain(added);
    }
    // 版だけが今の版へ正規化され、以後は自分自身との往復で字面が変わらない。
    expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
    expect(serializeDocument(expectOk(parseDocument(text)), { savedAt: SAVED_AT })).toBe(text);
  });

  it('省略できる欄を持たない文書は、版 5 前半と同じ字面のまま往復する(1 バイトも変わらない)', () => {
    const document = expectOk(parseDocument(legacyRawFile()));
    const before = serializeDocument(document, { savedAt: SAVED_AT });
    const after = serializeDocument(roundTrip(document), { savedAt: SAVED_AT });
    expect(after).toBe(before);
  });

  it('移行表は版 2〜6 の 5 つで、版は 7 である(P6 タスク21・§0.a-0.55 で 1 つ増えた)', () => {
    expect(Object.keys(SCHEMA_MIGRATIONS).sort()).toEqual(['2', '3', '4', '5', '6']);
    expect(PCAD_SCHEMA_VERSION).toBe(7);
    expect(PART_SCHEMA_VERSION).toBe(PCAD_SCHEMA_VERSION);
  });
});

describe('断りの網羅(P5 タスク47、FR-504、NFR-UX-5)', () => {
  /** 立体 1 件だけの生ファイルを読ませて、断りの中身を返す。 */
  function rejectSolid(solid: Record<string, unknown>): ParseError {
    return expectError(parseDocument(rawFile({ document: rawDocument({ solids: [solid] }) })));
  }

  /** 全欄を埋めた押し出しの生の形(欄を 1 つずつ壊すための土台)。 */
  function rawExtrude(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'extrude-1',
      kind: 'extrude',
      name: '押し出し1',
      suppressed: false,
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      distance: ev('10', 10),
      reversed: false,
      symmetric: false,
      ...overrides,
    };
  }

  it('薄板の向きに知らない値があれば、その場所を添えて断る', () => {
    const error = rejectSolid(rawExtrude({ thickness: ev('2', 2), thicknessSide: 'middle' }));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].thicknessSide');
  });

  it('押し出しの終端に知らない種類があれば断る', () => {
    const error = rejectSolid(rawExtrude({ end: { kind: 'toBody' } }));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].end.kind');
  });

  it('終端が toFace なのに面が無ければ、どこが無いかを添えて断る', () => {
    const error = rejectSolid(rawExtrude({ end: { kind: 'toFace' } }));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.solids[0].end.face');
  });

  it('ミラーの鏡にする平面に知らない種類があれば断る', () => {
    const error = rejectSolid({
      id: 'mirror-1',
      kind: 'mirror',
      name: 'ミラー1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      plane: { kind: 'edge', planeId: 'xy' },
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].plane.kind');
  });

  it('拡大縮小の倍率に知らない種類があれば断る', () => {
    const error = rejectSolid({
      id: 'scale-1',
      kind: 'scale',
      name: '拡大縮小1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      origin: { kind: 'origin' },
      factor: { kind: 'perFace', value: ev('2', 2) },
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].factor.kind');
  });

  it('移動/回転の移動量が 3 つでなければ断る(欄の数を推測で補わない)', () => {
    const error = rejectSolid({
      id: 'transform-1',
      kind: 'transform',
      name: '移動・回転1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      translation: [ev('1', 1), ev('2', 2)],
      rotationAxis: null,
      rotationAngle: ev('0', 0),
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].translation');
  });

  it('移動/回転の回転軸に知らない種類があれば断る(null は許すが、知らない形は許さない)', () => {
    const error = rejectSolid({
      id: 'transform-1',
      kind: 'transform',
      name: '移動・回転1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      translation: [ev('1', 1), ev('2', 2), ev('3', 3)],
      rotationAxis: { kind: 'screw' },
      rotationAngle: ev('0', 0),
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].rotationAxis.kind');
  });

  it('リブの厚みを付ける側に知らない値があれば断る', () => {
    const error = rejectSolid({
      id: 'rib-1',
      kind: 'rib',
      name: 'リブ1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      profile: { sketchId: 'sketch-1', curveIds: ['line-1'] },
      thickness: ev('3', 3),
      side: 'left',
      extendToBody: false,
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].side');
  });

  it('外ねじを切り始める端に知らない値があれば断る', () => {
    const error = rejectSolid({
      id: 'threadShaft-1',
      kind: 'threadShaft',
      name: '外ねじ1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      face: faceRef('extrude-1', 0),
      nominal: 'M10',
      series: 'coarse',
      pitch: ev('1.5', 1.5),
      length: ev('20', 20),
      fromEnd: 'middle',
      modeled: false,
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].fromEnd');
  });

  it('曲面の作り方に知らない種類があれば断る', () => {
    const error = rejectSolid({
      id: 'surface-1',
      kind: 'surface',
      name: '曲面1',
      suppressed: false,
      operation: { kind: 'sweep', profile: { sketchId: 'sketch-1', curveIds: ['line-1'] } },
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].operation.kind');
  });

  it('抜き勾配の中立面が欠けていれば、どこが無いかを添えて断る', () => {
    const error = rejectSolid({
      id: 'draft-1',
      kind: 'draft',
      name: '抜き勾配1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      faces: [faceRef('extrude-1', 1)],
      angle: ev('1', 1),
      reversed: false,
    });
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.solids[0].neutralFace');
  });

  it('数のところに文字列があれば断る(球へつなぐ点の数)', () => {
    const error = rejectSolid({
      id: 'ruled-1',
      kind: 'ruled',
      name: '面をつなぐ1',
      suppressed: false,
      first: { kind: 'sketchFace', ref: { sketchId: 'sketch-1', faceFeatureId: 'face-1' } },
      second: { kind: 'sphere', sphereFeatureId: 'primitive-1' },
      twist: ev('0', 0),
      sphereSegments: '48',
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].sphereSegments');
  });

  it('数のところに文字列があれば断る(部分形状の参照の index)', () => {
    const error = rejectSolid({
      id: 'shell-1',
      kind: 'shell',
      name: 'くり抜き1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      openFaces: [{ ...faceRef('extrude-1', 0), index: '0' }],
      thickness: ev('2', 2),
      outward: false,
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].openFaces[0].index');
  });

  it('曲線の並びに文字列でない id が混ざれば、その位置を添えて断る', () => {
    const error = rejectSolid({
      id: 'rib-1',
      kind: 'rib',
      name: 'リブ1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      profile: { sketchId: 'sketch-1', curveIds: ['line-1', 3] },
      thickness: ev('3', 3),
      side: 'both',
      extendToBody: false,
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].profile.curveIds[1]');
  });

  it('真偽のところに文字列があれば断る(エンボスの向き)', () => {
    const error = rejectSolid({
      id: 'emboss-1',
      kind: 'emboss',
      name: 'エンボス1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      face: faceRef('extrude-1', 0),
      profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
      height: ev('2', 2),
      raised: 'true',
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].raised');
  });

  it('くり抜きの開ける面が配列でなければ断る', () => {
    const error = rejectSolid({
      id: 'shell-1',
      kind: 'shell',
      name: 'くり抜き1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      openFaces: faceRef('extrude-1', 0),
      thickness: ev('2', 2),
      outward: false,
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].openFaces');
  });

  it('切断面に知らない決め方があれば断る(作業平面と同じ一覧で絞る)', () => {
    const error = rejectSolid({
      id: 'cut-1',
      kind: 'cut',
      name: '切断1',
      suppressed: false,
      targetFeatureId: 'extrude-1',
      plane: { kind: 'twoEdges', planeId: 'xy', offset: ev('0', 0) },
      keep: 'positive',
      pairedWith: null,
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].plane.kind');
  });

  it('点集合パターンの点に知らない種類があれば、その位置を添えて断る', () => {
    const error = rejectSolid({
      id: 'pattern-1',
      kind: 'pattern',
      name: '点パターン1',
      suppressed: false,
      sourceFeatureId: 'hole-1',
      placement: { kind: 'points', points: [{ kind: 'origin' }, { kind: 'faceCenter' }] },
    });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].placement.points[1].kind');
  });

  it('知らない種類のフィーチャーはコードを増やさずに断る(24 種の外は読まない)', () => {
    const error = rejectSolid({ id: 'x-1', kind: 'thicken', name: '厚み付け1', suppressed: false });
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.solids[0].kind');
  });

  it('寸法が範囲外でも io は断らない(範囲の判定は model の解決側)', () => {
    // io は「形」だけを見る。負の厚み・0 個・360 度を超える角度は、
    // 解決の段(model)が invalidValue として利用者へ知らせる担当なので、
    // ここで断ると古いファイルが開けなくなる。
    const document = documentWithSolids([
      {
        id: 'shell-1',
        kind: 'shell',
        name: 'くり抜き1',
        suppressed: false,
        targetFeatureId: 'extrude-1',
        openFaces: [],
        thickness: ev('-2', -2),
        outward: false,
      },
      {
        id: 'pattern-1',
        kind: 'pattern',
        name: '直線パターン1',
        suppressed: false,
        sourceFeatureId: 'hole-1',
        placement: {
          kind: 'linear',
          direction: { kind: 'world', axis: 'x' },
          spacing: ev('0', 0),
          count: ev('0', 0),
          symmetric: false,
        },
      },
      {
        id: 'revolve-1',
        kind: 'revolve',
        name: '回転1',
        suppressed: false,
        profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
        axis: { kind: 'world', axis: 'z' },
        angle: ev('720', 720),
        reversed: false,
      },
    ]);
    expect(roundTrip(document)).toEqual(document);
  });
});

describe('読み込んだ形のベースボディ 2 種の読み書き(FR-802、P6 §2.8、タスク20)', () => {
  it('読み込んだ形は入れ物の名前と素性だけを書き、形そのものは書かない(§0.a-0.9)', () => {
    const document = documentWithSolid(allSolidFeatures().importedSolid);
    const text = serializeDocument(document, { savedAt: SAVED_AT });
    expect(text).toContain('"shapeRef": "shape-1"');
    expect(text).toContain('"fileName": "bracket.step"');
    expect(text).toContain('"unit": "inch"');
    expect(text).toContain('"bodyKind": "shell"');
    // B-rep のバイト列は ZIP の別エントリ(shapes/<shapeRef>.brep)なので JSON に出ない。
    expect(text).not.toContain('brep');
    expect(roundTrip(document)).toEqual(document);
  });

  it('読み込んだ三角形の形は三角形の数と体積を持ち、三角形そのものは書かない(§0.a-0.24)', () => {
    const document = documentWithSolid(allSolidFeatures().importedMesh);
    const text = serializeDocument(document, { savedAt: SAVED_AT });
    expect(text).toContain('"meshRef": "mesh-1"');
    expect(text).toContain('"triangleCount": 12');
    expect(text).toContain('"volume": 8000');
    expect(roundTrip(document)).toEqual(document);
  });

  it('省略できる欄(importedAt / volume)は省いたまま往復する', () => {
    const document = documentWithSolids([
      {
        id: 'importedSolid-1',
        kind: 'importedSolid',
        name: '読み込んだ形1',
        suppressed: false,
        shapeRef: 'shape-9',
        source: { format: 'obj', fileName: 'part.obj', unit: 'mm', byteLength: 10 },
        bodyKind: 'solid',
      },
      {
        id: 'importedMesh-1',
        kind: 'importedMesh',
        name: '読み込んだ三角形の形1',
        suppressed: false,
        meshRef: 'mesh-9',
        source: { format: 'gltf', fileName: 'part.glb', unit: 'mm', byteLength: 20 },
        triangleCount: 4,
      },
    ]);
    const text = serializeDocument(document, { savedAt: SAVED_AT });
    expect(text).not.toContain('importedAt');
    expect(text).not.toContain('volume');
    expect(roundTrip(document)).toEqual(document);
  });

  it('知らない形式・単位は既存の invalidField で断る(エラーコードを増やさない)', () => {
    /** 素性の欄を 1 つだけ壊した読み込んだ形を持つファイル。 */
    function brokenSource(overrides: Record<string, unknown>): string {
      return rawFile({
        document: rawDocument({
          solids: [
            {
              id: 'importedSolid-1',
              kind: 'importedSolid',
              name: '読み込んだ形1',
              suppressed: false,
              shapeRef: 'shape-1',
              source: {
                format: 'step',
                fileName: 'bracket.step',
                unit: 'mm',
                byteLength: 10,
                ...overrides,
              },
              bodyKind: 'solid',
            },
          ],
        }),
      });
    }
    const badFormat = expectError(parseDocument(brokenSource({ format: 'iges' })));
    expect(badFormat.code).toBe('invalidField');
    expect(badFormat.message).toContain('format');
    const badUnit = expectError(parseDocument(brokenSource({ unit: 'cm' })));
    expect(badUnit.code).toBe('invalidField');
    expect(badUnit.message).toContain('unit');
  });

  it('三角形の形に bodyKind の欄は無い(mesh は別のフィーチャー。§0.a-0.24)', () => {
    const text = serializeDocument(documentWithSolid(allSolidFeatures().importedMesh), {
      savedAt: SAVED_AT,
    });
    expect(text).not.toContain('bodyKind');
  });
});

describe('版 6 → 版 7 の移行と封筒の種別(P6 タスク21、§0.a-0.55・§0.a-0.35)', () => {
  /** 版 6 として妥当な生の文書(選択セットも下絵も持たない)。 */
  function v6Document(): Record<string, unknown> {
    return withoutCanvases(withoutSelectionSets({ ...rawDocument(), schemaVersion: 6 }));
  }

  /** 版 6 の生のファイル。 */
  function v6File(): string {
    return rawFile({ schema: 6, document: v6Document() });
  }

  it('移行表は版 6 → 版 7 の変換を持つ', () => {
    expect(SCHEMA_MIGRATIONS[6]).toBeDefined();
  });

  it('版 6 の封筒を持ち上げると schema と schemaVersion がどちらも 7 になる', () => {
    const migrate = SCHEMA_MIGRATIONS[6];
    if (migrate === undefined) {
      throw new Error('版 6 の移行があるはず');
    }
    const lifted: unknown = migrate({ schema: 6, document: v6Document() });
    expect(lifted).toMatchObject({
      schema: 7,
      document: { schemaVersion: 7, selectionSets: [], canvases: [] },
    });
  });

  it('選択セットと下絵をすでに持つ文書は、その中身を上書きしない', () => {
    const migrate = SCHEMA_MIGRATIONS[6];
    if (migrate === undefined) {
      throw new Error('版 6 の移行があるはず');
    }
    const lifted: unknown = migrate({
      schema: 6,
      document: { ...v6Document(), selectionSets: [{ id: 'set-1' }], canvases: [{ id: 'canvas-1' }] },
    });
    expect(lifted).toMatchObject({
      document: { selectionSets: [{ id: 'set-1' }], canvases: [{ id: 'canvas-1' }] },
    });
  });

  it('版 6 のファイルはそのまま開け、版 7 として読み込まれる(前方互換、要件§8)', () => {
    const document = expectOk(parseDocument(v6File()));
    expect(document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    expect(document.appearance.entries).toEqual([]);
  });

  it('版 2・3・4・5・6 のファイルがすべて開ける(移行を順に通す)', () => {
    // それぞれの版が「その版として妥当な最小の文書」になるよう、後から必須になった欄を外す。
    /** 版6 以前は選択セットも下絵も持たない(P6 タスク37・38 で足した欄)。 */
    function withoutV7Fields(document: Record<string, unknown>): Record<string, unknown> {
      return withoutCanvases(withoutSelectionSets(document));
    }
    const files: readonly string[] = [
      rawFile({
        schema: 2,
        document: withoutV7Fields(
          withoutAppearance(
            withoutParameters(withoutReferences({ ...rawDocument(), schemaVersion: 2 })),
          ),
        ),
      }),
      rawFile({
        schema: 3,
        document: withoutV7Fields(
          withoutAppearance(
            withoutParameters(withoutReferences({ ...rawDocument(), schemaVersion: 3 })),
          ),
        ),
      }),
      rawFile({
        schema: 4,
        document: withoutV7Fields(
          withoutAppearance(withoutParameters({ ...rawDocument(), schemaVersion: 4 })),
        ),
      }),
      rawFile({
        schema: 5,
        document: withoutV7Fields(withoutAppearance({ ...rawDocument(), schemaVersion: 5 })),
      }),
      v6File(),
    ];
    for (const file of files) {
      expect(expectOk(parseDocument(file)).schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    }
  });

  it('ひな形の種別は partTemplate で、部品と同じ中身として読める(§0.a-0.35)', () => {
    expect(PCAD_TEMPLATE_KIND).toBe('partTemplate');
    const result = parseDocument(rawFile({ kind: PCAD_TEMPLATE_KIND }));
    if (!result.ok) {
      throw new Error(`ひな形は読めるはず: ${result.error.code}`);
    }
    expect(result.kind).toBe(PCAD_TEMPLATE_KIND);
    expect(result.document.id).toBe('part-1');
  });

  it('部品のファイルを読むと種別は part になる', () => {
    const result = parseDocument(rawFile());
    if (!result.ok) {
      throw new Error('部品は読めるはず');
    }
    expect(result.kind).toBe(PCAD_DOCUMENT_KIND);
  });

  it('種別を partTemplate にして書き出すと封筒だけが変わる(中身は 1 文字も変わらない)', () => {
    const document = createEmptyPartDocument();
    const part = serializeDocument(document, { savedAt: SAVED_AT });
    const template = serializeDocument(document, { savedAt: SAVED_AT, kind: PCAD_TEMPLATE_KIND });
    expect(template).toContain(`"kind": "${PCAD_TEMPLATE_KIND}"`);
    expect(template.replace(`"kind": "${PCAD_TEMPLATE_KIND}"`, `"kind": "${PCAD_DOCUMENT_KIND}"`)).toBe(
      part,
    );
  });

  it('種別 assembly / drawing は今までどおり unsupportedKind で断る(コードを増やさない)', () => {
    for (const kind of ['assembly', 'drawing']) {
      const error = expectError(parseDocument(rawFile({ kind })));
      expect(error.code).toBe('unsupportedKind');
      expect(error.message).toContain(kind);
    }
  });
});

// ---------------------------------------------------------------------------
// ひな形の封筒の 2 欄(FR-814、§2.10、P6 タスク27)
// ---------------------------------------------------------------------------

describe('ひな形の封筒の任意の欄(FR-814、§2.10)', () => {
  /** 検査で使う道具の既定値(既定からずらして、持ち運ばれたことを見分ける)。 */
  const TOOL_DEFAULTS: PcadToolDefaults = {
    extrudeDistance: '25',
    holeDiameter: '8.5',
    filletRadius: '板厚',
    chamferDistance: '0.5',
    circleRadius: '12',
  };

  it('道具の既定値の欄はちょうど 5 つ(§2.10)', () => {
    expect(PCAD_TOOL_DEFAULT_KEYS).toEqual([
      'extrudeDistance',
      'holeDiameter',
      'filletRadius',
      'chamferDistance',
      'circleRadius',
    ]);
    expect(PCAD_TOOL_DEFAULT_KEYS).toHaveLength(5);
  });

  it('渡さなければ封筒に欄が出ない(部品の .pcad は 1 バイトも変わらない)', () => {
    const text = serializeDocument(createEmptyPartDocument(), { savedAt: SAVED_AT });
    expect(text).not.toContain('lengthUnit');
    expect(text).not.toContain('toolDefaults');
  });

  it('ひな形として書き出すと 2 欄が封筒に出て、往復で戻る', () => {
    const text = serializeDocument(createEmptyPartDocument(), {
      savedAt: SAVED_AT,
      kind: PCAD_TEMPLATE_KIND,
      lengthUnit: 'inch',
      toolDefaults: TOOL_DEFAULTS,
    });
    expect(text).toContain('"lengthUnit": "inch"');
    const result = parseDocument(text);
    if (!result.ok) {
      throw new Error(`ひな形は読めるはず: ${result.error.code}`);
    }
    expect(result.kind).toBe(PCAD_TEMPLATE_KIND);
    expect(result.lengthUnit).toBe('inch');
    expect(result.toolDefaults).toEqual(TOOL_DEFAULTS);
  });

  it('道具の欄の並びは呼び出し側の順に左右されない(決定性)', () => {
    // 欄を逆の順で組み立てても、書き出される字面は同じになる。
    const reversed: PcadToolDefaults = {
      circleRadius: TOOL_DEFAULTS.circleRadius,
      chamferDistance: TOOL_DEFAULTS.chamferDistance,
      filletRadius: TOOL_DEFAULTS.filletRadius,
      holeDiameter: TOOL_DEFAULTS.holeDiameter,
      extrudeDistance: TOOL_DEFAULTS.extrudeDistance,
    };
    const options = { savedAt: SAVED_AT, kind: PCAD_TEMPLATE_KIND, lengthUnit: 'mm' } as const;
    expect(
      serializeDocument(createEmptyPartDocument(), { ...options, toolDefaults: reversed }),
    ).toBe(serializeDocument(createEmptyPartDocument(), { ...options, toolDefaults: TOOL_DEFAULTS }));
  });

  it('lengthUnit が無いひな形は欄が無いまま読める(既定は上の層が埋める)', () => {
    const result = parseDocument(rawFile({ kind: PCAD_TEMPLATE_KIND }));
    if (!result.ok) {
      throw new Error('欄が無くても読めるはず');
    }
    expect(result.lengthUnit).toBeUndefined();
    expect(result.toolDefaults).toBeUndefined();
  });

  it('知らない単位は invalidField で断る(コードを増やさない)', () => {
    const error = expectError(
      parseDocument(rawFile({ kind: PCAD_TEMPLATE_KIND, lengthUnit: 'shaku' })),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('lengthUnit');
  });

  it('道具の既定値の欄が足りなければ missingField で断る(場所つき)', () => {
    const partial: Record<string, string> = { ...TOOL_DEFAULTS };
    delete partial['holeDiameter'];
    const error = expectError(
      parseDocument(rawFile({ kind: PCAD_TEMPLATE_KIND, toolDefaults: partial })),
    );
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('toolDefaults.holeDiameter');
  });

  it('道具の既定値が数値で書かれていれば invalidField で断る(式の文字列で持つ)', () => {
    const error = expectError(
      parseDocument(
        rawFile({
          kind: PCAD_TEMPLATE_KIND,
          toolDefaults: { ...TOOL_DEFAULTS, extrudeDistance: 25 },
        }),
      ),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('toolDefaults.extrudeDistance');
  });

  it('道具の既定値が表でなければ invalidField で断る', () => {
    const error = expectError(
      parseDocument(rawFile({ kind: PCAD_TEMPLATE_KIND, toolDefaults: '25' })),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('toolDefaults');
  });

  it('知らない欄が混ざっていても読め、保存し直すと落ちる(前方互換)', () => {
    const result = parseDocument(
      rawFile({
        kind: PCAD_TEMPLATE_KIND,
        toolDefaults: { ...TOOL_DEFAULTS, 未知の道具: '99' },
      }),
    );
    if (!result.ok) {
      throw new Error('知らない欄で断らないはず');
    }
    expect(result.toolDefaults).toEqual(TOOL_DEFAULTS);
  });

  it('欄を足しても書式の版は上げない(版 7 のまま)', () => {
    const text = serializeDocument(createEmptyPartDocument(), {
      savedAt: SAVED_AT,
      kind: PCAD_TEMPLATE_KIND,
      lengthUnit: 'inch',
      toolDefaults: TOOL_DEFAULTS,
    });
    expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
    expect(PCAD_SCHEMA_VERSION).toBe(7);
  });
});

describe('選択セットの読み書き(FR-112、P6 §0.a-0.44・§2.13、タスク37)', () => {
  it('立体・部分形状・空のセット・同じ名前の 2 つが往復しても変わらない', () => {
    const document = richDocument();
    const parsed = roundTrip(document);
    expect(parsed.selectionSets).toEqual(document.selectionSets);
    expect(parsed.selectionSets).toHaveLength(3);
    // 空のセット(§2.13「空のセット ── 作れる」)がそのまま残る。
    expect(parsed.selectionSets[2].members).toEqual([]);
    // 同じ名前の 2 つ(§2.13「同じ名前を 2 つ ── 許す」)が id で区別されたまま残る。
    expect(parsed.selectionSets[0].name).toBe(parsed.selectionSets[1].name);
    expect(parsed.selectionSets[0].id).not.toBe(parsed.selectionSets[1].id);
  });

  it('要素は外観の割り当て先とまったく同じ形で書かれる(型を 2 つ作っていない)', () => {
    const text = serializeDocument(richDocument(), { savedAt: SAVED_AT });
    const file: unknown = JSON.parse(text);
    if (
      typeof file !== 'object' ||
      file === null ||
      !('document' in file) ||
      typeof file.document !== 'object' ||
      file.document === null ||
      !('selectionSets' in file.document)
    ) {
      throw new Error('選択セットが書き出されているはず');
    }
    expect(file.document.selectionSets).toEqual([
      {
        id: 'selectionSet-1',
        name: '上面',
        members: [
          { kind: 'body', bodyFeatureId: 'extrude-1' },
          { kind: 'face', ref: richAppearanceFaceRef() },
        ],
      },
      {
        id: 'selectionSet-2',
        name: '上面',
        members: [{ kind: 'face', ref: richAppearanceFaceRef() }],
      },
      { id: 'selectionSet-3', name: '後で足す', members: [] },
    ]);
  });

  it('版 6 のファイルを開くと selectionSets が空配列で補われる(SCHEMA_MIGRATIONS[6])', () => {
    const v6 = withoutCanvases(withoutSelectionSets({ ...rawDocument(), schemaVersion: 6 }));
    const document = expectOk(parseDocument(rawFile({ schema: 6, document: v6 })));
    expect(document.selectionSets).toEqual([]);
  });

  it('版 7 なのに selectionSets の欄が無ければ missingField で断る', () => {
    const error = expectError(
      parseDocument(rawFile({ document: withoutSelectionSets(rawDocument()) })),
    );
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.selectionSets');
  });

  it('セットの id が重なっていれば invalidField で断る(コードは増やさない)', () => {
    const error = expectError(
      parseDocument(
        rawFile({
          document: rawDocument({
            selectionSets: [
              { id: 'selectionSet-1', name: 'A', members: [] },
              { id: 'selectionSet-1', name: 'B', members: [] },
            ],
          }),
        }),
      ),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('selectionSet-1');
  });

  it('知らない要素の種類・欠けた欄は場所を添えて断る', () => {
    const badKind = expectError(
      parseDocument(
        rawFile({
          document: rawDocument({
            selectionSets: [{ id: 'selectionSet-1', name: 'A', members: [{ kind: 'edgeLoop' }] }],
          }),
        }),
      ),
    );
    expect(badKind.code).toBe('invalidField');
    expect(badKind.message).toContain('document.selectionSets[0].members[0]');
    const missingName = expectError(
      parseDocument(
        rawFile({
          document: rawDocument({ selectionSets: [{ id: 'selectionSet-1', members: [] }] }),
        }),
      ),
    );
    expect(missingName.code).toBe('missingField');
    expect(missingName.message).toContain('name');
  });

  it('名前が空のセットは読める(壊れたファイルではない。断るのは model の作る口)', () => {
    const document = expectOk(
      parseDocument(
        rawFile({
          document: rawDocument({ selectionSets: [{ id: 'selectionSet-1', name: '', members: [] }] }),
        }),
      ),
    );
    expect(document.selectionSets[0].name).toBe('');
  });
});

describe('下絵の読み書き(FR-332、P6 §0.a-0.45・§2.14、タスク38)', () => {
  /** 生の下絵 1 枚(欄を自由に壊せる形)。 */
  function rawCanvas(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'canvas-1',
      name: '下絵1',
      plane: 'xy',
      imageId: 'canvas-1',
      width: ev('400', 400),
      height: ev('300', 300),
      origin: { mode: 'absolute', x: ev('0', 0), y: ev('0', 0), z: ev('0', 0) },
      rotation: ev('0', 0),
      opacity: ev('0.5', 0.5),
      visible: true,
      ...overrides,
    };
  }

  it('画像・寸法・不透明度・向き・入切が往復しても変わらない(§2.14 の表)', () => {
    const document = richDocument();
    const parsed = roundTrip(document);
    expect(parsed.canvases).toEqual(document.canvases);
    expect(parsed.canvases).toHaveLength(2);
    expect(parsed.canvases[0].width.source).toBe('800*0.5');
    expect(parsed.canvases[0].rotation.value).toBe(30);
    expect(parsed.canvases[0].opacity.value).toBe(0.5);
    expect(parsed.canvases[1].visible).toBe(false);
    expect(parsed.canvases[1].plane).toBe('referencePlane-1');
  });

  it('document.json には id と寸法だけが入り、画像のバイト列は 1 バイトも入らない(§2.8)', () => {
    const text = serializeDocument(richDocument(), { savedAt: SAVED_AT });
    expect(text).toContain('"imageId": "canvas-1"');
    // 画像そのものを表す欄(バイト列・データ URL)は書き出さない。
    expect(text).not.toContain('bytes');
    expect(text).not.toContain('data:image');
  });

  it('版 6 のファイルを開くと canvases が空配列で補われる(SCHEMA_MIGRATIONS[6])', () => {
    const v6 = withoutCanvases(withoutSelectionSets({ ...rawDocument(), schemaVersion: 6 }));
    const document = expectOk(parseDocument(rawFile({ schema: 6, document: v6 })));
    expect(document.canvases).toEqual([]);
  });

  it('版 7 なのに canvases の欄が無ければ missingField で断る', () => {
    const error = expectError(parseDocument(rawFile({ document: withoutCanvases(rawDocument()) })));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.canvases');
  });

  it('不透明度は 0 と 1 を含む 0〜1 で読める', () => {
    for (const value of [0, 0.25, 1]) {
      const document = expectOk(
        parseDocument(
          rawFile({
            document: rawDocument({
              canvases: [rawCanvas({ opacity: ev(String(value), value) })],
            }),
          }),
        ),
      );
      expect(document.canvases[0].opacity.value).toBe(value);
    }
  });

  it('不透明度が 0〜1 の外なら invalidField で断る(外観の 0〜100% とは尺度が違う)', () => {
    for (const value of [-0.1, 1.5, 50]) {
      const error = expectError(
        parseDocument(
          rawFile({
            document: rawDocument({
              canvases: [rawCanvas({ opacity: ev(String(value), value) })],
            }),
          }),
        ),
      );
      expect(error.code).toBe('invalidField');
      expect(error.message).toContain('document.canvases[0].opacity');
    }
  });

  it('下絵の id が重なっていれば invalidField で断る(コードは増やさない)', () => {
    const error = expectError(
      parseDocument(
        rawFile({ document: rawDocument({ canvases: [rawCanvas(), rawCanvas({ name: '下絵2' })] }) }),
      ),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('canvas-1');
  });

  it('欄が欠けている・型が違う下絵は場所を添えて断る', () => {
    const withoutImageId = { ...rawCanvas() };
    delete withoutImageId['imageId'];
    const missing = expectError(
      parseDocument(rawFile({ document: rawDocument({ canvases: [withoutImageId] }) })),
    );
    expect(missing.code).toBe('missingField');
    expect(missing.message).toContain('document.canvases[0].imageId');
    const wrongType = expectError(
      parseDocument(
        rawFile({ document: rawDocument({ canvases: [rawCanvas({ visible: 'yes' })] }) }),
      ),
    );
    expect(wrongType.code).toBe('invalidField');
    expect(wrongType.message).toContain('document.canvases[0].visible');
  });

  it('知らない欄を足した下絵は読めて、保存し直すと落ちる(前方互換)', () => {
    const document = expectOk(
      parseDocument(rawFile({ document: rawDocument({ canvases: [rawCanvas({ 未知: 1 })] }) })),
    );
    expect(serializeDocument(document, { savedAt: SAVED_AT })).not.toContain('未知');
  });
});
