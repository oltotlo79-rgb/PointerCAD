/**
 * 部品文書の全ての式を、変数表つきで評価し直す
 * (要件 FR-207・FR-502・FR-202、計画書 docs/plans/P4b-スケッチの仕上げ.md §2.6・タスク3)。
 *
 * パラメータ表(名前を付けた数値)の値を1か所変えると、その名前を使っている**すべての欄**が
 * 追従する。追従の実体がここで、流れは §2.6 の①〜⑤である。
 *   ①〜④ パラメータ表を解いて変数表を作る … `parameters/parameterTable.ts` の `analyzeParameters`
 *   ⑤ その変数表で文書の全式を評価し直す … このファイルの `reevaluatePartDocument`
 *
 * **式文字列は変えない。** 変わるのは評価値(`value`)と表示用の文字列(`display`)だけで、
 * 利用者が書いた式はそのまま保存され、そのまま再編集できる(FR-202)。
 *
 * **評価できない式は元の値を残す**(未知の名前、ゼロ除算など)。0 や NaN を入れると、
 * 名前を打ち間違えた瞬間に形がつぶれてしまう。失敗は一覧にして返し、画面が赤く出せるようにする
 * (FR-504、NFR-RE-1「止めずに警告する」)。
 *
 * 歩き方は `part/shiftOrigin.ts`(原点の再設定)と同じで、対象が「絶対座標だけ」か
 * 「全ての `ExpressionValue`」かだけが違う。スケッチの中は `sketch/mapExpressions.ts` が歩き、
 * ここは立体・基準ジオメトリ・パラメータ表を歩く。どちらも `switch` に `default` を書かないので、
 * フィーチャーの種類が増えたら型検査で落ちる(「値を変えても追従しない欄」を作らないため)。
 */

import { evaluateExpression, renameVariable, type ExpressionValue, type EvaluateOptions } from '@pointercad/expression';

import type { PlaneSpec } from '../geometry/planeSpec.js';
import { analyzeParameters } from '../parameters/parameterTable.js';
import type { Parameter, ParameterAnalysis } from '../parameters/types.js';
import {
  mapCoordinateExpressions,
  mapKeepingIdentity,
  mapPointReferenceExpressions,
  mapSketchExpressions,
  type ExpressionMapper,
  type ValueMapper,
} from '../sketch/mapExpressions.js';
import type {
  ChamferSize,
  HoleDepth,
  HoleEntry,
  PartDocument,
  PatternPlacement,
  PrimitiveShape,
  ReferenceFeature,
  ScaleFactor,
  SolidFeature,
  SolidOrigin,
  SurfaceOperation,
} from './types.js';

/** 評価し直せなかった式1つ(FR-504)。画面はこれを見て欄を赤く出す。 */
export interface ReevaluationFailure {
  /**
   * その式を持っているもの の id。スケッチの要素・立体・基準ジオメトリはフィーチャーの id、
   * 拘束は拘束の id、パラメータ表は名前。
   */
  readonly ownerId: string;
  /** 評価できなかった式そのもの(利用者が書いた文字列のまま)。 */
  readonly source: string;
  /** 理由(日本語)。`evaluateExpression` が返したものをそのまま渡す。 */
  readonly message: string;
}

/** 評価し直した結果。 */
export interface PartReevaluation {
  /** 値が変わった式だけを差し替えた文書。**1つも変わらなければ元の文書そのもの**。 */
  readonly document: PartDocument;
  /** 評価できなかった式(値は据え置いてある)。 */
  readonly failures: readonly ReevaluationFailure[];
}

/** パラメータ表を解いて文書へ配った結果(画面が呼ぶ入口 `applyParameters` の戻り値)。 */
export interface AppliedParameters {
  readonly document: PartDocument;
  /** パラメータ表そのものの解析(循環・未使用・評価できなかった名前)。 */
  readonly analysis: ParameterAnalysis;
  /** 文書の側の式のうち評価し直せなかったもの(パラメータ表の失敗は `analysis.failures`)。 */
  readonly failures: readonly ReevaluationFailure[];
}

// ---------------------------------------------------------------------------
// 立体・基準ジオメトリの歩き方(網羅。`default` を書かない)
// ---------------------------------------------------------------------------

/** 穴の深さ(FR-405)。貫通は式を持たない。 */
function rebuildHoleDepth(depth: HoleDepth, map: ValueMapper): HoleDepth {
  switch (depth.kind) {
    case 'through':
      return depth;
    case 'blind':
      return { kind: 'blind', depth: map(depth.depth) };
  }
}

/**
 * 穴の入口(ざぐり・皿もみ。FR-422、P5 タスク43)。
 * **省略されている(= 広げない)ときは省略のまま返す**(既定を書き込まない)。
 */
function rebuildHoleEntry(
  entry: HoleEntry | undefined,
  map: ValueMapper,
): HoleEntry | undefined {
  if (entry === undefined) {
    return undefined;
  }
  switch (entry.kind) {
    case 'plain':
      return entry;
    case 'counterbore':
      return { kind: 'counterbore', diameter: map(entry.diameter), depth: map(entry.depth) };
    case 'countersink':
      return { kind: 'countersink', diameter: map(entry.diameter), angle: map(entry.angle) };
  }
}

/** C 面取りの大きさ(FR-408 の①②③)。 */
function rebuildChamferSize(size: ChamferSize, map: ValueMapper): ChamferSize {
  switch (size.kind) {
    case 'equal':
      return { kind: 'equal', distance: map(size.distance) };
    case 'twoDistances':
      return {
        kind: 'twoDistances',
        distance1: map(size.distance1),
        distance2: map(size.distance2),
      };
    case 'distanceAngle':
      return { kind: 'distanceAngle', distance: map(size.distance), angle: map(size.angle) };
  }
}

/**
 * パターンの並べ方(FR-411 直線、FR-412 円形、FR-425 点集合)。向き・軸は参照だけで
 * 式を持たない。**点集合(P5 タスク43)は間隔・個数の欄を持たず、点そのものが式を持つ**
 * (球面上の点の緯度・経度。FR-431)ので、平面の指定と同じく点を写す。
 */
function rebuildPatternPlacement(placement: PatternPlacement, map: ValueMapper): PatternPlacement {
  switch (placement.kind) {
    case 'linear':
      return { ...placement, spacing: map(placement.spacing), count: map(placement.count) };
    case 'circular':
      return { ...placement, angle: map(placement.angle), count: map(placement.count) };
    case 'points':
      return {
        ...placement,
        points: placement.points.map((point) => mapPointReferenceExpressions(point, map)),
      };
  }
}

/** 基本形状5種の寸法(FR-429、P5 タスク15)。種類ごとに欄が違う。 */
function rebuildPrimitiveShape(shape: PrimitiveShape, map: ValueMapper): PrimitiveShape {
  switch (shape.kind) {
    case 'sphere':
      return { kind: 'sphere', radius: map(shape.radius) };
    case 'box':
      return {
        kind: 'box',
        sizeX: map(shape.sizeX),
        sizeY: map(shape.sizeY),
        sizeZ: map(shape.sizeZ),
      };
    case 'cylinder':
      return { kind: 'cylinder', radius: map(shape.radius), height: map(shape.height) };
    case 'cone':
      return {
        kind: 'cone',
        bottomRadius: map(shape.bottomRadius),
        topRadius: map(shape.topRadius),
        height: map(shape.height),
      };
    case 'torus':
      return {
        kind: 'torus',
        majorRadius: map(shape.majorRadius),
        minorRadius: map(shape.minorRadius),
      };
  }
}

/**
 * 基本形状の基準点(FR-429、P5 タスク15)。式を持つのは座標の指定のときだけで、
 * スケッチの点・立体の頂点は参照だけ(位置は解決のときに引く)。
 */
function rebuildSolidOrigin(origin: SolidOrigin, map: ValueMapper): SolidOrigin {
  switch (origin.kind) {
    case 'coordinate':
      return { kind: 'coordinate', value: mapCoordinateExpressions(origin.value, map) };
    case 'sketchPoint':
    case 'vertex':
      return origin;
  }
}

/** 立体フィーチャー11種の式の欄を写す。 */
function rebuildSolidFeature(feature: SolidFeature, map: ValueMapper): SolidFeature {
  switch (feature.kind) {
    case 'extrude':
      // 終端(FR-415)・傾き(FR-401)・薄板(FR-416)の欄は省略できる(P5 タスク43)。
      // 省略されている欄は `undefined` のまま残し、既定を書き込まない
      // (`createPartDocument.ts` の `extrudeShapingOf` が読むときに埋める)。
      return {
        ...feature,
        distance: map(feature.distance),
        taperAngle: feature.taperAngle === undefined ? undefined : map(feature.taperAngle),
        thickness:
          feature.thickness === undefined || feature.thickness === null
            ? feature.thickness
            : map(feature.thickness),
      };
    case 'revolve':
      return { ...feature, angle: map(feature.angle) };
    case 'sew':
      return { ...feature, tolerance: map(feature.tolerance) };
    case 'boolean':
      // ブーリアンは相手のフィーチャーの id だけを持ち、式は1つも無い。
      return feature;
    case 'hole':
      return {
        ...feature,
        diameter: map(feature.diameter),
        depth: rebuildHoleDepth(feature.depth, map),
        entry: rebuildHoleEntry(feature.entry, map),
        tiltAngle: map(feature.tiltAngle),
        tiltAzimuth: map(feature.tiltAzimuth),
      };
    case 'threadHole':
      return {
        ...feature,
        pitch: map(feature.pitch),
        drillDiameter: map(feature.drillDiameter),
        depth: rebuildHoleDepth(feature.depth, map),
        entry: rebuildHoleEntry(feature.entry, map),
        threadLength: map(feature.threadLength),
        tiltAngle: map(feature.tiltAngle),
        tiltAzimuth: map(feature.tiltAzimuth),
      };
    case 'fillet':
      // 可変半径(FR-426、タスク46)の終点側は**省略できる欄**なので、押し出しの
      // `taperAngle` と同じく「あるときだけ写す」(既定を各所へ写さない)。
      return {
        ...feature,
        radius: map(feature.radius),
        radiusEnd:
          feature.radiusEnd === undefined || feature.radiusEnd === null
            ? feature.radiusEnd
            : map(feature.radiusEnd),
      };
    case 'chamfer':
      return { ...feature, size: rebuildChamferSize(feature.size, map) };
    case 'pattern':
      return { ...feature, placement: rebuildPatternPlacement(feature.placement, map) };
    case 'spring':
      return {
        ...feature,
        tiltAngle: map(feature.tiltAngle),
        tiltAzimuth: map(feature.tiltAzimuth),
        length: map(feature.length),
        pitch: map(feature.pitch),
        turns: map(feature.turns),
        coilDiameter: map(feature.coilDiameter),
        wireDiameter: map(feature.wireDiameter),
      };
    case 'primitive':
      return {
        ...feature,
        origin: rebuildSolidOrigin(feature.origin, map),
        shape: rebuildPrimitiveShape(feature.shape, map),
      };
    case 'ruled':
    case 'loft':
      // 面をつなぐ・ロフト(FR-430、FR-410、P5 タスク25)。断面は参照だけで式を持たず、
      // 式の欄は「ねじれの補正」1 つだけ(§0.a-0.28)。
      return { ...feature, twist: map(feature.twist) };
    /*
      P5 の Should 群(§2.11、タスク43)。**式を持つ欄だけを写す。**
      面・辺の指紋、フィーチャーの id、真偽のつまみ、ねじの呼び・系列は式ではないので
      そのまま残る(`...feature` が持ち回る)。
    */
    case 'draft':
      return { ...feature, angle: map(feature.angle) };
    case 'mirror':
      // 鏡にする平面は作業平面の id か面の指紋だけで、式を 1 つも持たない。
      return feature;
    case 'transform':
      return {
        ...feature,
        translation: [
          map(feature.translation[0]),
          map(feature.translation[1]),
          map(feature.translation[2]),
        ],
        rotationAngle: map(feature.rotationAngle),
      };
    case 'scale':
      return {
        ...feature,
        origin: mapPointReferenceExpressions(feature.origin, map),
        factor: rebuildScaleFactor(feature.factor, map),
      };
    case 'sweep':
      // 断面と経路は参照だけで、式の欄を 1 つも持たない。
      return feature;
    case 'rib':
      return { ...feature, thickness: map(feature.thickness) };
    case 'emboss':
      return { ...feature, height: map(feature.height) };
    case 'threadShaft':
      return { ...feature, pitch: map(feature.pitch), length: map(feature.length) };
    case 'surface':
      return { ...feature, operation: rebuildSurfaceOperation(feature.operation, map) };
    case 'shell':
      // くり抜き(FR-418、§2.12、タスク46)。式の欄は壁の厚さ 1 つだけで、
      // 開ける面の指紋・向きのつまみは式ではない。
      return { ...feature, thickness: map(feature.thickness) };
    case 'cut':
      // 平面による切断(FR-432、§2.9b、タスク27c)。式は切断面の中(`pointAndAxis` の
      // 傾き角・方位角、`face` / `workPlane` のオフセット、点の座標)にある。
      return { ...feature, plane: rebuildPlaneSpec(feature.plane, map) };
    case 'importedSolid':
    case 'importedMesh':
      // 読み込んだ形の 2 種(FR-802、P6 §2.8、タスク20)。**式の欄を 1 つも持たない**
      // (履歴を持たない形なので、寸法を式で書き直す余地が無い)。素性(`source`)の
      // 単位・バイト数は読み込んだときの記録で、パラメータの値が変わっても動かない。
      return feature;
  }
}

/** 拡大縮小の倍率(FR-424、P5 タスク43)。全体は1つ、軸ごとは3つの式を持つ。 */
function rebuildScaleFactor(factor: ScaleFactor, map: ValueMapper): ScaleFactor {
  switch (factor.kind) {
    case 'uniform':
      return { kind: 'uniform', value: map(factor.value) };
    case 'perAxis':
      return { kind: 'perAxis', x: map(factor.x), y: map(factor.y), z: map(factor.z) };
  }
}

/** 曲面の作り方5種(FR-428、P5 タスク43)。輪郭・軸・面は参照だけで式を持たない。 */
function rebuildSurfaceOperation(
  operation: SurfaceOperation,
  map: ValueMapper,
): SurfaceOperation {
  switch (operation.kind) {
    case 'extrude':
      return { ...operation, distance: map(operation.distance) };
    case 'revolve':
      return { ...operation, angle: map(operation.angle) };
    case 'offset':
      // 面のオフセット(タスク42b が足した 6 種目)。式の欄は距離 1 つ。
      return { ...operation, distance: map(operation.distance) };
    case 'planar':
    case 'loft':
    case 'face':
      return operation;
  }
}

/**
 * 平面の決め方7種(FR-328)の式の欄を写す。
 *
 * 点そのものが式を持つようになった(球面上の点の緯度・経度。FR-431、P5 タスク19)ので、
 * 「点・辺・面の参照だけだから式は無い」とは言えなくなった。点を持つ 4 種は
 * `mapPointReferenceExpressions` を通す。
 */
function rebuildPlaneSpec(spec: PlaneSpec, map: ValueMapper): PlaneSpec {
  switch (spec.kind) {
    case 'threePoints':
      return {
        ...spec,
        p1: mapPointReferenceExpressions(spec.p1, map),
        p2: mapPointReferenceExpressions(spec.p2, map),
        p3: mapPointReferenceExpressions(spec.p3, map),
      };
    case 'pointAndEdge':
    case 'pointAndParallelFace':
      return { ...spec, point: mapPointReferenceExpressions(spec.point, map) };
    case 'pointAndAxis':
      return {
        ...spec,
        point: mapPointReferenceExpressions(spec.point, map),
        tilt: map(spec.tilt),
        azimuth: map(spec.azimuth),
      };
    case 'face':
      return { ...spec, offset: map(spec.offset) };
    case 'workPlane':
      return { ...spec, offset: map(spec.offset) };
    case 'tilted':
      return { ...spec, angle: map(spec.angle) };
  }
}

/** 基準ジオメトリ4種(FR-328、FR-329)の式の欄を写す。 */
function rebuildReferenceFeature(feature: ReferenceFeature, map: ValueMapper): ReferenceFeature {
  switch (feature.kind) {
    case 'referencePlane':
      return { ...feature, plane: rebuildPlaneSpec(feature.plane, map) };
    case 'referencePoint':
      // 座標の式で定義した基準点だけが式を持つ(頂点・辺の中点・面の中心は参照だけ)。
      return feature.definition.kind === 'coordinate'
        ? {
            ...feature,
            definition: {
              kind: 'coordinate',
              at: mapCoordinateExpressions(feature.definition.at, map),
            },
          }
        : feature;
    case 'referenceAxis':
      // 軸そのものは式を持たないが、2 点で決める軸の**点の側**が式を持ちうる
      // (球面上の点の緯度・経度。FR-431、P5 タスク19)。
      return feature.definition.kind === 'twoPoints'
        ? {
            ...feature,
            definition: {
              kind: 'twoPoints',
              from: mapPointReferenceExpressions(feature.definition.from, map),
              to: mapPointReferenceExpressions(feature.definition.to, map),
            },
          }
        : feature;
    case 'referenceCoordinateSystem':
      // 軸は参照だけ。原点は点なので、球面上の点なら緯度・経度の式を持つ。
      return { ...feature, origin: mapPointReferenceExpressions(feature.origin, map) };
  }
}

/** 式が1つも入れ替わらなければ元のフィーチャーを返す(下流の鍵を無駄に変えないため)。 */
function mapSolidFeature(feature: SolidFeature, map: ExpressionMapper): SolidFeature {
  let changed = false;
  const mapValue: ValueMapper = (value) => {
    const next = map(value, feature.id);
    if (next !== value) {
      changed = true;
    }
    return next;
  };
  const next = rebuildSolidFeature(feature, mapValue);
  return changed ? next : feature;
}

/** 同上(基準ジオメトリ)。 */
function mapReferenceFeature(feature: ReferenceFeature, map: ExpressionMapper): ReferenceFeature {
  let changed = false;
  const mapValue: ValueMapper = (value) => {
    const next = map(value, feature.id);
    if (next !== value) {
      changed = true;
    }
    return next;
  };
  const next = rebuildReferenceFeature(feature, mapValue);
  return changed ? next : feature;
}

/** 同上(パラメータ表の1行。`ownerId` は名前)。 */
function mapParameter(parameter: Parameter, map: ExpressionMapper): Parameter {
  const value = map(parameter.value, parameter.name);
  return value === parameter.value ? parameter : { ...parameter, value };
}

/**
 * 部品文書の中の式を1つずつ写す(**パラメータ表そのものは含まない**)。
 *
 * パラメータ表を外してあるのは、「未使用の名前」の判定
 * (`analyzeParameters` の `usedSources`)に自分自身の式を混ぜてはいけないため。
 * `A = 'A + 1'` の自己参照を「使われている」と数えると、誰も使っていない名前が消せなくなる。
 */
function mapDocumentExpressions(document: PartDocument, map: ExpressionMapper): PartDocument {
  const sketches = mapKeepingIdentity(document.sketches, (sketch) =>
    mapSketchExpressions(sketch, map),
  );
  const references = mapKeepingIdentity(document.references, (feature) =>
    mapReferenceFeature(feature, map),
  );
  const solids = mapKeepingIdentity(document.solids, (feature) => mapSolidFeature(feature, map));
  if (
    sketches === document.sketches &&
    references === document.references &&
    solids === document.solids
  ) {
    return document;
  }
  return { ...document, sketches, references, solids };
}

// ---------------------------------------------------------------------------
// 集める・評価し直す・名前を書き換える
// ---------------------------------------------------------------------------

/**
 * 文書の中の全ての式の文字列を集める(パラメータの「使われていない名前」の判定に使う)。
 *
 * 集める先は、スケッチの全要素の座標・寸法・角度と拘束の目標値、立体フィーチャーの寸法、
 * 基準ジオメトリと平面の指定のオフセット・角度・座標。**パラメータ表自身の式は含めない**
 * (`mapDocumentExpressions` の注釈)。同じ文字列が2度出ても取り除かない(欄の数を数えられる
 * ようにしておくと、歩き忘れの検出に使える)。
 */
export function collectExpressionSources(document: PartDocument): readonly string[] {
  const sources: string[] = [];
  mapDocumentExpressions(document, (value) => {
    sources.push(value.source);
    return value;
  });
  return sources;
}

/** 式1つと、それを持っているものの id・表示名(FR-207、P4b タスク22b)。 */
export interface ExpressionOwner {
  /** 利用者が書いた式の文字列。 */
  readonly source: string;
  /** その式を持っているもの の id(フィーチャー・拘束)。`ReevaluationFailure.ownerId` と同じ。 */
  readonly ownerId: string;
  /** フィーチャーツリーに出る表示名(FR-501)。名前を引けなければ id をそのまま。 */
  readonly ownerName: string;
}

/**
 * 部品文書の中の id → 表示名の対応表。スケッチの要素・拘束・基準ジオメトリ・立体を
 * すべて入れる(どれも `name` を持つ)。
 *
 * `switch` を使わず `name` の欄をそのまま読むので、フィーチャーの種類が増えても
 * ここを直さなくてよい(種類ごとの分岐は `mapDocumentExpressions` の側が受け持つ)。
 */
function displayNames(document: PartDocument): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const sketch of document.sketches) {
    names.set(sketch.id, sketch.name);
    for (const feature of sketch.features) {
      names.set(feature.id, feature.name);
    }
    for (const constraint of sketch.constraints ?? []) {
      names.set(constraint.id, constraint.name);
    }
  }
  for (const feature of document.references) {
    names.set(feature.id, feature.name);
  }
  for (const feature of document.solids) {
    names.set(feature.id, feature.name);
  }
  return names;
}

/**
 * 文書の中の全ての式を、**持ち主の名前つき**で集める(FR-207、P4b タスク22b)。
 *
 * `collectExpressionSources` は式の文字列しか返さないので、パラメータの削除を断るときに
 * 「3 か所から使われています」としか言えなかった(`docs/報告記録.md` 2026-09-05 実時計
 * 01:05・01:40 の申し送り)。利用者が直しに行けるよう、**どのフィーチャーから使われて
 * いるか**を名前で言えるようにする(NFR-UX-5「なぜできないか、どうすればできるか」)。
 *
 * 歩き方も並びも `collectExpressionSources` と同じ(同じ `mapDocumentExpressions` を通す)。
 * **既存の関数は変えない**ので、件数だけが要る呼び出しはそのままでよい。
 * パラメータ表自身の式は含まない(`mapDocumentExpressions` の注釈)。
 */
export function collectExpressionOwners(document: PartDocument): readonly ExpressionOwner[] {
  const names = displayNames(document);
  const owners: ExpressionOwner[] = [];
  mapDocumentExpressions(document, (value, ownerId) => {
    owners.push({ source: value.source, ownerId, ownerName: names.get(ownerId) ?? ownerId });
    return value;
  });
  return owners;
}

/**
 * 式1つを変数表つきで評価し直す。
 *
 * 評価できなくなったら**元の値を残し**、理由を `onFailure` へ渡す(FR-504)。
 * 値も表示も変わらなければ元のオブジェクトをそのまま返す(下流の鍵を無駄に変えないため)。
 */
function reevaluateValue(
  value: ExpressionValue,
  variables: ReadonlyMap<string, number>,
  onFailure: (message: string) => void,
  options: Omit<EvaluateOptions, 'variables'> = {},
): ExpressionValue {
  const result = evaluateExpression(value.source, { ...options, variables });
  if (!result.ok) {
    onFailure(result.error.message);
    return value;
  }
  const next = result.value;
  return next.value === value.value && next.display === value.display ? value : next;
}

/**
 * 部品文書の全ての式を、変数表つきで評価し直す(FR-207、FR-502)。
 * 式文字列は変えず、変わるのは `value` と `display` だけ(FR-202)。
 *
 * 値が1つも変わらなければ**元の文書そのもの**を返すので、呼び出し側は `===` で
 * 「何も変わっていない」ことを確かめられる(無駄な再計算・再描画を起こさない)。
 */
export function reevaluatePartDocument(
  document: PartDocument,
  variables: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): PartReevaluation {
  const failures: ReevaluationFailure[] = [];
  const next = mapDocumentExpressions(document, (value, ownerId) =>
    reevaluateValue(value, variables, (message) => {
      failures.push({ ownerId, source: value.source, message });
    }, options),
  );
  return { document: next, failures };
}

/**
 * 文書の中の全ての式で、変数 `from` を `to` へ書き換える(パラメータの改名の追従、FR-207)。
 *
 * 素朴な文字列置換だと「板厚」を改名したときに「板厚さ」の一部まで置き換わるので、
 * 字句に分けてから変数の字句だけを差し替える(`@pointercad/expression` の `renameVariable`)。
 * **パラメータ表の式もここで書き換える**(表の中の相互参照も追従させるため)。ただし
 * パラメータの**名前**そのものを変えるのは `renameParameter`(`parameters/parameterTable.ts`)で、
 * 両方を通しても二重に書き換わることはない(1度目で `from` の字句が残らないため)。
 *
 * 値は変えない。名前が変わっても数は変わらないので、`value` と `display` はそのまま持つ。
 */
export function renameVariableInPartDocument(
  document: PartDocument,
  from: string,
  to: string,
): PartDocument {
  const rename: ExpressionMapper = (value) => {
    const source = renameVariable(value.source, from, to);
    return source === value.source ? value : { ...value, source };
  };
  const next = mapDocumentExpressions(document, rename);
  const parameters = mapKeepingIdentity(document.parameters, (parameter) =>
    mapParameter(parameter, rename),
  );
  return parameters === document.parameters ? next : { ...next, parameters };
}

/** パラメータ表が空のときの解析結果。呼び出しのたびに作らないよう1つだけ持つ。 */
const EMPTY_ANALYSIS: ParameterAnalysis = {
  variables: new Map<string, number>(),
  exactVariables: new Map<string, string>(),
  nonLengthVariables: new Set<string>(),
  circular: [],
  unused: [],
  failures: [],
};

/**
 * パラメータ表を解析し、その変数表で文書全体を評価し直す(画面が呼ぶ入口、FR-207・FR-502)。
 *
 * **表が空なら何もしない。** パラメータを1つも使っていない部品(いまの既定)では、
 * 文書をそのまま返すので費用が増えない。
 *
 * 表があるときは、文書の式に加えて**パラメータ表自身の値**も新しい変数表で書き直す
 * (表の「値」の列が古い数を見せ続けないように)。循環に含まれる名前は変数表に入らないので、
 * その式は評価できず前回の値のまま据え置かれる(§2.6 の③)。
 */
export function applyParameters(document: PartDocument): AppliedParameters {
  if (document.parameters.length === 0) {
    return { document, analysis: EMPTY_ANALYSIS, failures: [] };
  }
  const analysis = analyzeParameters(document.parameters, collectExpressionSources(document));
  const reevaluated = reevaluatePartDocument(document, analysis.variables, analysis);
  const parameters = mapKeepingIdentity(reevaluated.document.parameters, (parameter) =>
    mapParameter(parameter, (value) =>
      // 表の側の失敗は `analysis.failures` がすでに持っているので、ここでは数えない。
      reevaluateValue(value, analysis.variables, () => undefined, analysis),
    ),
  );
  return {
    document:
      parameters === reevaluated.document.parameters
        ? reevaluated.document
        : { ...reevaluated.document, parameters },
    analysis,
    failures: reevaluated.failures,
  };
}
