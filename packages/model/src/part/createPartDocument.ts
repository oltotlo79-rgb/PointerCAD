/**
 * 部品(パート)文書の生成と履歴操作(計画書 docs/plans/P2-ソリッド基礎.md タスク9b、
 * docs/plans/P3-加工フィーチャー.md タスク13)。
 *
 * 履歴を書き換えず、変更のたびに新しい配列を作る。Undo / Redo(FR-505)はこの不変性の上に乗る。
 * 参照は id で持ち、座標や形を複製しない(FR-311、FR-502)。
 * ここに置くのは文書そのものの操作だけで、解決(座標・向き・キャッシュの鍵の計算)は
 * part/resolvePart.ts の担当にする。
 */

import { expressionValueFromNumber } from '@pointercad/expression';

import { emptyAppearanceTable } from '../appearance/appearanceTable.js';
import type { AxisSpec } from '../geometry/planeSpec.js';
import {
  createEmptySketchDocument,
  nextSerialId,
  nextSerialName,
} from '../sketch/createSketchDocument.js';
import type { SketchDocument } from '../sketch/types.js';
import type {
  BooleanOperation,
  PartDocument,
  PrimitiveFeature,
  PrimitiveShape,
  PrimitiveShapeKind,
  ReferenceFeature,
  ReferenceFeatureKind,
  RuledSphereSegments,
  SolidFeature,
  SolidOrigin,
} from './types.js';

/**
 * 部品文書の保存形式の版(§0.a-0.3)。P3 で 3 になり(P3 計画書 §0.a-0.22、タスク19)、
 * P4 タスク31(§0.a-0.24)で 4 になり、P4b タスク21(§0.a-0.17、案 A)で 5 になった。
 *
 * P4 が足したのは新しいスケッチの種類(矩形・正多角形・長穴・楕円・スプライン・オフセット・
 * 複製・投影/交差)と基準ジオメトリ・任意平面・3D スケッチ・構築線フラグで、版 3 まで
 * 一部のファイルで省略できていた欄(`construction`・点列の `layout`・`references`)を
 * 版 4 からは必須にした。P4b が足したのはパラメータ表(`parameters`、FR-207)とスケッチの
 * 拘束(`SketchDocument.constraints`、FR-313)で、`parameters` は版 5 から必須の欄にする
 * (拘束は型自体が恒常的に省略可能なままなので、版を理由に必須化はしない。
 * `packages/io/src/pcad/documentJson.ts` の `readSketch` を参照)。
 * この値は io 側の `PCAD_SCHEMA_VERSION`
 * (`packages/io/src/pcad/schema.ts`)と必ず同じにする(`documentJson.test.ts` が検査する)。
 * 版 4 以前のファイルは `SCHEMA_MIGRATIONS[4]` が `parameters` の省略を明示的に補って読み込む。
 *
 * P5 タスク2 で足した外観の割り当て(`PartDocument.appearance`、FR-1106〜1110)は、
 * P5 タスク5(§0.a-0.15、P4b が版 5 を使ったための読み替えで版 6)で `packages/io` が
 * 読み書きと移行(`SCHEMA_MIGRATIONS[5]`)を実装したので版 6 から必須の欄にした。
 * 版 5 以前のファイルは `SCHEMA_MIGRATIONS[5]` が `appearance` の省略を空の表で補って読み込む。
 */
export const PART_SCHEMA_VERSION = 6;

/** 縫合のつなぎ目の既定の許容量(mm、§0.a-0.7)。 */
export const DEFAULT_SEW_TOLERANCE_MM = 0.01;

/** 穴の直径の既定(mm、P3 §タスク13)。 */
export const DEFAULT_HOLE_DIAMETER_MM = 6;

/** 止まり穴の深さの既定(mm)。 */
export const DEFAULT_HOLE_DEPTH_MM = 10;

/** R 面取りの半径の既定(mm)。 */
export const DEFAULT_FILLET_RADIUS_MM = 2;

/** C 面取りの距離の既定(mm)。 */
export const DEFAULT_CHAMFER_DISTANCE_MM = 1;

/** C 面取りの角度の既定(度)。 */
export const DEFAULT_CHAMFER_ANGLE_DEGREES = 45;

/** 直線パターンの間隔の既定(mm、§0.a-0.21)。 */
export const DEFAULT_PATTERN_SPACING_MM = 20;

/** 直線パターンの個数の既定(§0.a-0.21)。 */
export const DEFAULT_PATTERN_COUNT = 3;

/** 円形パターンの個数の既定(§0.a-0.21)。 */
export const DEFAULT_CIRCULAR_PATTERN_COUNT = 4;

/** パターンの個数の上限(P3 §2.7)。これを超える指定は解決のときに断る。 */
export const MAX_PATTERN_COUNT = 100;

/** ばねのコイル中心径の既定(mm、FR-414、§0.a-0.30)。 */
export const DEFAULT_SPRING_COIL_DIAMETER_MM = 20;

/** ばねの線径の既定(mm)。 */
export const DEFAULT_SPRING_WIRE_DIAMETER_MM = 2;

/** ばねのピッチの既定(mm)。 */
export const DEFAULT_SPRING_PITCH_MM = 5;

/** ばねの巻数の既定。既定の全長は ピッチ × 巻数 = 20mm になる(§0.a-0.30)。 */
export const DEFAULT_SPRING_TURNS = 4;

/** ばねの巻数の上限(§0.a-0.35)。これを超える指定は解決のときに断る。 */
export const MAX_SPRING_TURNS = 200;

/*
  基本形状5種の既定の寸法(mm。FR-429、P5 計画書 §2.7.1 の表と §0.a-0.16 の決定)。

  何も選ばずに道具を押して決めただけで意味のある形ができる大きさにしてある
  (NFR-UX-4「Enter 連打で意味のある結果」)。利用者は作ったあとに式で直せる(FR-202)。
*/

/** 球の半径の既定(mm)。 */
export const DEFAULT_SPHERE_RADIUS_MM = 10;

/** 箱の一辺の既定(mm)。X / Y / Z とも同じ。 */
export const DEFAULT_BOX_SIZE_MM = 20;

/** 円柱の半径の既定(mm)。 */
export const DEFAULT_CYLINDER_RADIUS_MM = 10;

/** 円柱の高さの既定(mm)。底面の中心から軸の向きへ伸びる(§0.a-0.17)。 */
export const DEFAULT_CYLINDER_HEIGHT_MM = 20;

/** 円錐の下半径の既定(mm)。 */
export const DEFAULT_CONE_BOTTOM_RADIUS_MM = 10;

/** 円錐の上半径の既定(mm)。0 なら尖った円錐、0 より大きければ円錐台(§0.a-0.16)。 */
export const DEFAULT_CONE_TOP_RADIUS_MM = 0;

/** 円錐の高さの既定(mm)。 */
export const DEFAULT_CONE_HEIGHT_MM = 20;

/** トーラスの主半径(中心から管の中心までの半径)の既定(mm)。 */
export const DEFAULT_TORUS_MAJOR_RADIUS_MM = 20;

/** トーラスの管の半径の既定(mm)。主半径より小さくする(同じ以上だと自己交差する)。 */
export const DEFAULT_TORUS_MINOR_RADIUS_MM = 5;

/**
 * 基本形状の向きの既定(§0.a-0.16)。世界の Z 軸。
 *
 * 球・トーラスは向きを変えても形が変わらないが、欄を種類ごとに出し分けないほうが
 * 作りが単純なので5種すべてが同じ欄を持つ(表示の出し分けは UI の仕事)。
 */
export const DEFAULT_PRIMITIVE_AXIS: AxisSpec = { kind: 'world', axis: 'z' };

/**
 * ねじれの補正の既定(§0.a-0.28)。0 なら `ThruSections` に任せたそのままの対応になる。
 * 整数の式で持ち、小数を書かれたら解決のときに断る(切り捨てない)。
 */
export const DEFAULT_RULED_TWIST = 0;

/**
 * 球へつなぐときの近似の点の数の既定(§0.a-0.74)。
 * 24 / 48 / 72 から選べるうちのいちばん軽いもの(タスク24 の実測で 72 点は 5〜6 秒)。
 */
export const DEFAULT_RULED_SPHERE_SEGMENTS: RuledSphereSegments = 24;

/** 段ごとに選べる球の近似の点の数(§0.a-0.74)。UI の選択肢と io の妥当性検査が共有する。 */
export const RULED_SPHERE_SEGMENT_CHOICES: readonly RuledSphereSegments[] = [24, 48, 72];

/**
 * 連番を分ける単位。ブーリアンは演算ごとに別の連番にするので、
 * フィーチャーの種類そのもの(`boolean`)ではなく演算名を鍵にする(§2.3)。
 * パターンも同じ理由で配置ごと(直線 / 円形)に分ける。
 */
export type SolidLabelKey =
  | 'extrude'
  | 'revolve'
  | 'sew'
  | BooleanOperation
  | 'hole'
  | 'threadHole'
  | 'fillet'
  | 'chamfer'
  | 'linearPattern'
  | 'circularPattern'
  | 'spring'
  /*
    基本形状(FR-429)は5種を別々の連番にする(「球1」「箱1」…)。
    ブーリアンを演算ごとに分けているのと同じ理由で、利用者から見て別の道具だからである
    (「基本形状1」「基本形状2」では、木を見ても何を置いたのか分からない)。
  */
  | PrimitiveShapeKind
  /*
    面をつなぐ(FR-430)とロフト(FR-410)も別々の連番にする。カーネルの段は 1 種類だが、
    利用者から見て別の道具なので(§0.a-0.25)、木に「面をつなぐ1」「ロフト1」と出す。
  */
  | 'ruled'
  | 'loft';

/**
 * ソリッドの種類ごとの既定名。ドキュメントの既定データとしてここに置く
 * (UI 文字列 ja.json とは別扱い。スケッチの KIND_LABELS と同じ考え方)。
 */
export const SOLID_LABELS: Readonly<Record<SolidLabelKey, string>> = {
  extrude: '押し出し',
  revolve: '回転',
  sew: '縫合',
  union: '和',
  subtract: '差',
  intersect: '積',
  hole: '穴',
  threadHole: 'ねじ穴',
  fillet: 'R面取り',
  chamfer: 'C面取り',
  linearPattern: '直線パターン',
  circularPattern: '円形パターン',
  spring: 'ばね',
  sphere: '球',
  box: '箱',
  cylinder: '円柱',
  cone: '円錐',
  torus: 'トーラス',
  ruled: '面をつなぐ',
  loft: 'ロフト',
};

/**
 * 基準ジオメトリの種類ごとの既定名(FR-328、FR-329)。
 * `SOLID_LABELS` と同じくドキュメントの既定データとしてここに置く(UI 文字列とは別扱い)。
 */
export const REFERENCE_LABELS: Readonly<Record<ReferenceFeatureKind, string>> = {
  referencePlane: '作業平面',
  referenceAxis: '基準軸',
  referencePoint: '基準点',
  referenceCoordinateSystem: '座標系',
};

/**
 * スケッチの既定名の見出し(P4 仕上げ (g))。「スケッチ1」「スケッチ2」…と連番を付ける。
 * `createEmptySketchDocument` が起動時に付ける名前(「スケッチ1」)と必ず同じ言葉にする。
 * `SOLID_LABELS` / `REFERENCE_LABELS` と同じくドキュメントの既定データ(UI 文字列とは別扱い)。
 */
export const SKETCH_LABEL = 'スケッチ';

/** 起動時の部品。空のスケッチを1本だけ持ち、基準ジオメトリもソリッドも無い(NFR-UX-6)。 */
export function createEmptyPartDocument(): PartDocument {
  const sketch = createEmptySketchDocument();
  return {
    id: 'part-1',
    name: '部品1',
    schemaVersion: PART_SCHEMA_VERSION,
    sketches: [sketch],
    activeSketchId: sketch.id,
    references: [],
    solids: [],
    // パラメータ表(FR-207)の既定は空。名前を付けた数値は利用者が足す(P4b タスク2)。
    parameters: [],
    // 外観の割り当て(FR-1106〜1110)の既定は空の表。割り当てが1つも無い文書は
    // P2 からの単色(`DEFAULT_APPEARANCE`)で描かれ、見た目は変わらない(P5 §0.a-0.4)。
    appearance: emptyAppearanceTable(),
  };
}

export function findReference(
  document: PartDocument,
  featureId: string,
): ReferenceFeature | undefined {
  return document.references.find((feature) => feature.id === featureId);
}

/**
 * 基準ジオメトリを履歴の末尾へ足す(FR-328、FR-329)。
 * 作業平面の id はそのまま作図面の id になるので、すでに同じ id があれば足さずに返す。
 */
export function appendReference(
  document: PartDocument,
  feature: ReferenceFeature,
): PartDocument {
  if (findReference(document, feature.id) !== undefined) {
    return document;
  }
  return { ...document, references: [...document.references, feature] };
}

/** 1つを差し替える(名前の変更・表示の切替もこれで行う)。見つからなければそのまま返す。 */
export function replaceReference(
  document: PartDocument,
  featureId: string,
  next: ReferenceFeature,
): PartDocument {
  if (findReference(document, featureId) === undefined) {
    return document;
  }
  return {
    ...document,
    references: document.references.map((feature) =>
      feature.id === featureId ? next : feature,
    ),
  };
}

/**
 * 1つを取り除く。これを作図面にしていたスケッチや、これを軸にしていたフィーチャーは
 * 履歴に残し、解決のときに理由つきで断る(FR-504。止めずに警告する)。
 */
export function removeReference(document: PartDocument, featureId: string): PartDocument {
  if (findReference(document, featureId) === undefined) {
    return document;
  }
  return {
    ...document,
    references: document.references.filter((feature) => feature.id !== featureId),
  };
}

/** 同じ種類の既存の名前の最大連番 + 1(ソリッドと同じ方式、§0.a-0.19)。 */
export function nextReferenceName(document: PartDocument, kind: ReferenceFeatureKind): string {
  const usedNames = document.references
    .filter((feature) => feature.kind === kind)
    .map((feature) => feature.name);
  return nextSerialName(usedNames, REFERENCE_LABELS[kind]);
}

/** 同じ種類の既存の id の最大連番 + 1(ソリッドと同じ方式、§0.a-0.19)。 */
export function nextReferenceId(document: PartDocument, kind: ReferenceFeatureKind): string {
  const usedIds = document.references
    .filter((feature) => feature.kind === kind)
    .map((feature) => feature.id);
  return nextSerialId(usedIds, `${kind}-`);
}

export function findSketch(document: PartDocument, sketchId: string): SketchDocument | undefined {
  return document.sketches.find((sketch) => sketch.id === sketchId);
}

/**
 * スケッチを1本足す。編集中のスケッチは変えない(切り替えは setActiveSketch)。
 * 同じ id がすでにあれば、id の一意性を守るため元の文書をそのまま返す。
 */
export function addSketch(document: PartDocument, sketch: SketchDocument): PartDocument {
  if (findSketch(document, sketch.id) !== undefined) {
    return document;
  }
  return { ...document, sketches: [...document.sketches, sketch] };
}

/**
 * この文書へ足せる空のスケッチを1本作る(P4 仕上げ (g)、FR-501)。
 * まだ足してはいない(足すのは `addSketch`)。id と名前だけを採番して返す。
 */
export function createSketchFor(document: PartDocument): SketchDocument {
  return {
    ...createEmptySketchDocument(),
    id: nextSketchId(document),
    name: nextSketchName(document),
  };
}

/**
 * 新しいスケッチの id(ソリッド・基準ジオメトリと同じ連番方式、§0.a-0.19)。
 * 途中の 1 本を消しても残ったものと重ならない(「スケッチ1」を消しても次は「スケッチ3」)。
 */
export function nextSketchId(document: PartDocument): string {
  return nextSerialId(
    document.sketches.map((sketch) => sketch.id),
    'sketch-',
  );
}

/** 新しいスケッチの名前(id と同じ方式、§0.a-0.19)。利用者が改名した名前とも重ならない。 */
export function nextSketchName(document: PartDocument): string {
  return nextSerialName(
    document.sketches.map((sketch) => sketch.name),
    SKETCH_LABEL,
  );
}

/**
 * スケッチを1本取り除く(P4 仕上げ (g)、FR-503)。
 *
 * **最後の1本は消さない。** 消すと作図する場所が無くなり、`activeSketchId` の指し先も
 * 作れなくなるため(§0.a-0.4「activeSketchId は sketches のいずれかを指す」)。
 * 消したものを編集中だったときは、残りの先頭を編集中にする。
 * このスケッチの要素を参照していた立体は履歴に残し、解決のときに理由つきで断る
 * (FR-504。止めずに警告する。`removeSolid` / `removeReference` と同じ扱い)。
 */
export function removeSketch(document: PartDocument, sketchId: string): PartDocument {
  if (document.sketches.length <= 1 || findSketch(document, sketchId) === undefined) {
    return document;
  }
  const sketches = document.sketches.filter((sketch) => sketch.id !== sketchId);
  return {
    ...document,
    sketches,
    activeSketchId:
      document.activeSketchId === sketchId ? sketches[0].id : document.activeSketchId,
  };
}

/** スケッチを1本差し替える。同じ id が無ければ元の文書をそのまま返す。 */
export function replaceSketch(document: PartDocument, sketch: SketchDocument): PartDocument {
  if (findSketch(document, sketch.id) === undefined) {
    return document;
  }
  return {
    ...document,
    sketches: document.sketches.map((current) => (current.id === sketch.id ? sketch : current)),
  };
}

/** 編集中のスケッチを切り替える。実在しない id なら元の文書をそのまま返す(§0.a-0.4)。 */
export function setActiveSketch(document: PartDocument, sketchId: string): PartDocument {
  if (findSketch(document, sketchId) === undefined) {
    return document;
  }
  return { ...document, activeSketchId: sketchId };
}

export function findSolid(document: PartDocument, featureId: string): SolidFeature | undefined {
  return document.solids.find((feature) => feature.id === featureId);
}

/**
 * ソリッドフィーチャーを履歴の末尾へ足す。
 * id はボディの id でもあり他のフィーチャーから参照されるので、
 * すでに同じ id があれば足さずに元の文書をそのまま返す(§0.a-0.5)。
 */
export function appendSolid(document: PartDocument, feature: SolidFeature): PartDocument {
  if (findSolid(document, feature.id) !== undefined) {
    return document;
  }
  return { ...document, solids: [...document.solids, feature] };
}

/**
 * 1つを差し替える。抑制(FR-503)と名前の変更もこれで行う。
 * 見つからなければ元の文書をそのまま返す。id は変えない前提(id はボディの識別子)。
 */
export function replaceSolid(
  document: PartDocument,
  featureId: string,
  next: SolidFeature,
): PartDocument {
  if (findSolid(document, featureId) === undefined) {
    return document;
  }
  return {
    ...document,
    solids: document.solids.map((feature) => (feature.id === featureId ? next : feature)),
  };
}

/**
 * 1つを取り除く。これを参照していたブーリアンは履歴に残し、
 * 解決のときに理由つきで失敗させる(FR-504。止めずに警告する)。
 */
export function removeSolid(document: PartDocument, featureId: string): PartDocument {
  if (findSolid(document, featureId) === undefined) {
    return document;
  }
  return {
    ...document,
    solids: document.solids.filter((feature) => feature.id !== featureId),
  };
}

/**
 * 同じ種類の既存の名前の最大連番 + 1(§0.a-0.19)。削除しても重複しない。
 * 数えるのは履歴の全部の名前で、利用者が改名した名前とも重ならないようにする。
 */
export function nextSolidName(document: PartDocument, key: SolidLabelKey): string {
  const usedNames = document.solids.map((feature) => feature.name);
  return nextSerialName(usedNames, SOLID_LABELS[key]);
}

/** 同じ接頭辞の既存 id の最大連番 + 1(名前と同じ方式、§0.a-0.19)。 */
export function nextSolidId(document: PartDocument, key: SolidLabelKey): string {
  const usedIds = document.solids.map((feature) => feature.id);
  return nextSerialId(usedIds, `${key}-`);
}

/**
 * 基本形状の基準点の既定(FR-429、NFR-UX-4)。何も選ばずに置いたときの原点。
 *
 * 座標の式(絶対座標の 0, 0, 0)にするのは、点も頂点も選ばずに道具を押しただけで
 * 形ができ、あとからプロパティで式を書き直せるようにするためである(FR-202、FR-502)。
 */
export function defaultPrimitiveOrigin(): SolidOrigin {
  return {
    kind: 'coordinate',
    value: {
      mode: 'absolute',
      x: expressionValueFromNumber(0),
      y: expressionValueFromNumber(0),
      z: expressionValueFromNumber(0),
    },
  };
}

/**
 * 基本形状5種の既定の寸法(§2.7.1 の表)。式は既定値の数をそのまま書いた文字列になる
 * (`expressionValueFromNumber`)ので、プロパティ欄に「10」と出て、そのまま直せる。
 */
export function defaultPrimitiveShape(kind: PrimitiveShapeKind): PrimitiveShape {
  switch (kind) {
    case 'sphere':
      return { kind: 'sphere', radius: expressionValueFromNumber(DEFAULT_SPHERE_RADIUS_MM) };
    case 'box':
      return {
        kind: 'box',
        sizeX: expressionValueFromNumber(DEFAULT_BOX_SIZE_MM),
        sizeY: expressionValueFromNumber(DEFAULT_BOX_SIZE_MM),
        sizeZ: expressionValueFromNumber(DEFAULT_BOX_SIZE_MM),
      };
    case 'cylinder':
      return {
        kind: 'cylinder',
        radius: expressionValueFromNumber(DEFAULT_CYLINDER_RADIUS_MM),
        height: expressionValueFromNumber(DEFAULT_CYLINDER_HEIGHT_MM),
      };
    case 'cone':
      return {
        kind: 'cone',
        bottomRadius: expressionValueFromNumber(DEFAULT_CONE_BOTTOM_RADIUS_MM),
        topRadius: expressionValueFromNumber(DEFAULT_CONE_TOP_RADIUS_MM),
        height: expressionValueFromNumber(DEFAULT_CONE_HEIGHT_MM),
      };
    case 'torus':
      return {
        kind: 'torus',
        majorRadius: expressionValueFromNumber(DEFAULT_TORUS_MAJOR_RADIUS_MM),
        minorRadius: expressionValueFromNumber(DEFAULT_TORUS_MINOR_RADIUS_MM),
      };
  }
}

/**
 * 基本形状のフィーチャーを1つ作る(FR-429)。まだ履歴へは足していない(足すのは
 * `appendSolid`)。id と名前は形ごとの連番で採る(「球1」「箱1」…、§0.a-0.19)。
 *
 * 基準点と向きを省くと、原点に既定の向き(Z 軸)で置く(NFR-UX-4)。
 */
export function createPrimitiveFeature(
  document: PartDocument,
  kind: PrimitiveShapeKind,
  origin: SolidOrigin = defaultPrimitiveOrigin(),
  axis: AxisSpec = DEFAULT_PRIMITIVE_AXIS,
): PrimitiveFeature {
  return {
    id: nextSolidId(document, kind),
    name: nextSolidName(document, kind),
    suppressed: false,
    kind: 'primitive',
    origin,
    axis,
    shape: defaultPrimitiveShape(kind),
  };
}

/**
 * そのフィーチャーが対象として消費するボディの id(§0.a-0.5、P3 §2.6 / §2.7 / §2.7b)。
 *
 * - ブーリアンは対象と相手の2つ。
 * - 加工(穴・ねじ穴・R 面取り・C 面取り)は対象のボディ1つを消費して新しいボディを1つ作る。
 * - パターンは繰り返しのもとにした加工フィーチャーのボディ1つを消費する(§0.a-0.20)。
 * - 押し出し・回転・縫合・**ばね**は何も消費しない(ばねは §0.a-0.36 で「作る」フィーチャー)。
 * - **基本形状**も何も消費しない(P5 §0.a-0.19)。基準点に立体の頂点を指したときも
 *   消費しない: 頂点の座標を読むだけなので、貸した立体はそのまま画面に残る。
 * - **面をつなぐ(罫線面)・ロフト**も何も消費しない(P5 §0.a-0.27)。立体の面や球を
 *   輪郭に借りても、輪郭を読むだけなので元の立体はそのまま画面に残る。残しておかないと
 *   「球と柱を罫線でつないだあと和でまとめる」ができなくなる。
 *

 * 順序は文書に書かれた順のまま返す(重複の除去はしない。同じ id を2度指すブーリアンは
 * 解決のときに `consumedTwice` で断る)。
 */
export function consumedTargetsOf(feature: SolidFeature): readonly string[] {
  switch (feature.kind) {
    case 'extrude':
    case 'revolve':
    case 'sew':
    case 'spring':
    case 'primitive':
    case 'ruled':
    case 'loft':
      return [];
    case 'boolean':
      return [feature.targetFeatureId, feature.toolFeatureId];
    case 'hole':
    case 'threadHole':
    case 'fillet':
    case 'chamfer':
      return [feature.targetFeatureId];
    case 'pattern':
      return [feature.sourceFeatureId];
  }
}

/**
 * そのフィーチャーが加工(対象のボディを1つだけ取る種類)か。
 * 穴・ねじ穴・R 面取り・C 面取り・パターンが該当する。
 * ブーリアンは対象を2つ取るので加工には数えない。ばねは対象を取らないので `false`(§0.a-0.36)。
 * 基本形状も対象を取らないので `false`(P5 §0.a-0.19)。
 * 面をつなぐ・ロフトも対象を取らない「作る」フィーチャーなので `false`(P5 §0.a-0.27)。
 */
export function isMachiningFeature(feature: SolidFeature): boolean {
  switch (feature.kind) {
    case 'hole':
    case 'threadHole':
    case 'fillet':
    case 'chamfer':
    case 'pattern':
      return true;
    case 'extrude':
    case 'revolve':
    case 'sew':
    case 'boolean':
    case 'spring':
    case 'primitive':
    case 'ruled':
    case 'loft':
      return false;
  }
}

/**
 * パターン(FR-411、FR-412)の対象にできるか。穴・ねじ穴だけ(§0.a-0.20)。
 *
 * フィレット・面取りを外すのは「工具の形」が無く、変換した位置の辺を指紋で選び直す必要が
 * あって危ういため。ばねも対象にしない(§0.a-0.36)。基本形状も同じく対象にしない
 * (工具ではなく「作る」フィーチャーだから。P5 §0.a-0.19)。
 *
 * **面をつなぐ・ロフトも対象にしない**(P5 §0.a-0.27)。押し出し・回転・縫合・ばね・
 * 基本形状と同じ「作る」フィーチャーで、差し引く工具の形を持たないためである。
 */
export function isPatternSource(feature: SolidFeature): boolean {
  return feature.kind === 'hole' || feature.kind === 'threadHole';
}

/**
 * ほかのフィーチャーに消費されたボディの id(§0.a-0.5)。
 *
 * 消費できるのは「履歴で自分より前にあり、抑制されていない」フィーチャーのボディだけ。
 * 抑制されたフィーチャーは再計算で飛ばされるので何も消費せず、ボディも作らない。
 * 参照先が消えている場合(FR-504 で失敗させる場合)は消費に数えない。
 * ここは文書だけを見る判定で、実際に形が作れたかどうかは resolvePart が決める。
 */
export function consumedBodyIds(document: PartDocument): ReadonlySet<string> {
  const consumed = new Set<string>();
  const available = new Set<string>();
  for (const feature of document.solids) {
    if (feature.suppressed) {
      continue;
    }
    for (const id of consumedTargetsOf(feature)) {
      if (available.has(id)) {
        consumed.add(id);
      }
    }
    // 自分の id は消費の判定を終えてから足す。自分自身や後ろのボディは参照できない。
    available.add(feature.id);
  }
  return consumed;
}

/**
 * いま画面に出るボディの id を履歴順に並べる(§0.a-0.5)。
 * 抑制されておらず、まだ消費されていないフィーチャーのボディ。
 * 作成に失敗したものを外すのは resolvePart の役目(文書だけでは分からない)。
 */
export function liveBodyIds(document: PartDocument): readonly string[] {
  const consumed = consumedBodyIds(document);
  return document.solids
    .filter((feature) => !feature.suppressed && !consumed.has(feature.id))
    .map((feature) => feature.id);
}
