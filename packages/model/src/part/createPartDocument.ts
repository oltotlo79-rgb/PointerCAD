/**
 * 部品(パート)文書の生成と履歴操作(計画書 docs/plans/P2-ソリッド基礎.md タスク9b、
 * docs/plans/P3-加工フィーチャー.md タスク13)。
 *
 * 履歴を書き換えず、変更のたびに新しい配列を作る。Undo / Redo(FR-505)はこの不変性の上に乗る。
 * 参照は id で持ち、座標や形を複製しない(FR-311、FR-502)。
 * ここに置くのは文書そのものの操作だけで、解決(座標・向き・キャッシュの鍵の計算)は
 * part/resolvePart.ts の担当にする。
 */

import {
  createEmptySketchDocument,
  nextSerialId,
  nextSerialName,
} from '../sketch/createSketchDocument.js';
import type { SketchDocument } from '../sketch/types.js';
import type {
  BooleanOperation,
  PartDocument,
  ReferenceFeature,
  ReferenceFeatureKind,
  SolidFeature,
} from './types.js';

/**
 * 部品文書の保存形式の版(§0.a-0.3)。P3 で 3 になり(P3 計画書 §0.a-0.22、タスク19)、
 * P4 タスク31(§0.a-0.24)で 4 になった。
 *
 * P4 が足したのは新しいスケッチの種類(矩形・正多角形・長穴・楕円・スプライン・オフセット・
 * 複製・投影/交差)と基準ジオメトリ・任意平面・3D スケッチ・構築線フラグで、版 3 まで
 * 一部のファイルで省略できていた欄(`construction`・点列の `layout`・`references`)を
 * 版 4 からは必須にする。この値は io 側の `PCAD_SCHEMA_VERSION`
 * (`packages/io/src/pcad/schema.ts`)と必ず同じにする(`documentJson.test.ts` が検査する)。
 * 版 3 以前のファイルは `SCHEMA_MIGRATIONS[3]` が上記の省略を明示的に補って読み込む。
 */
export const PART_SCHEMA_VERSION = 4;

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
  | 'spring';

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
 * そのフィーチャーが対象として消費するボディの id(§0.a-0.5、P3 §2.6 / §2.7 / §2.7b)。
 *
 * - ブーリアンは対象と相手の2つ。
 * - 加工(穴・ねじ穴・R 面取り・C 面取り)は対象のボディ1つを消費して新しいボディを1つ作る。
 * - パターンは繰り返しのもとにした加工フィーチャーのボディ1つを消費する(§0.a-0.20)。
 * - 押し出し・回転・縫合・**ばね**は何も消費しない(ばねは §0.a-0.36 で「作る」フィーチャー)。
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
      return false;
  }
}

/**
 * パターン(FR-411、FR-412)の対象にできるか。穴・ねじ穴だけ(§0.a-0.20)。
 *
 * フィレット・面取りを外すのは「工具の形」が無く、変換した位置の辺を指紋で選び直す必要が
 * あって危ういため。ばねも対象にしない(§0.a-0.36)。
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
