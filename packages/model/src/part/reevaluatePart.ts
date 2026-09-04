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

import { evaluateExpression, renameVariable, type ExpressionValue } from '@pointercad/expression';

import type { PlaneSpec } from '../geometry/planeSpec.js';
import { analyzeParameters } from '../parameters/parameterTable.js';
import type { Parameter, ParameterAnalysis } from '../parameters/types.js';
import {
  mapCoordinateExpressions,
  mapKeepingIdentity,
  mapSketchExpressions,
  type ExpressionMapper,
  type ValueMapper,
} from '../sketch/mapExpressions.js';
import type {
  ChamferSize,
  HoleDepth,
  PartDocument,
  PatternPlacement,
  ReferenceFeature,
  SolidFeature,
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

/** パターンの並べ方(FR-411 直線、FR-412 円形)。向き・軸は参照だけで式を持たない。 */
function rebuildPatternPlacement(placement: PatternPlacement, map: ValueMapper): PatternPlacement {
  switch (placement.kind) {
    case 'linear':
      return { ...placement, spacing: map(placement.spacing), count: map(placement.count) };
    case 'circular':
      return { ...placement, angle: map(placement.angle), count: map(placement.count) };
  }
}

/** 立体フィーチャー10種の式の欄を写す。 */
function rebuildSolidFeature(feature: SolidFeature, map: ValueMapper): SolidFeature {
  switch (feature.kind) {
    case 'extrude':
      return { ...feature, distance: map(feature.distance) };
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
        tiltAngle: map(feature.tiltAngle),
        tiltAzimuth: map(feature.tiltAzimuth),
      };
    case 'threadHole':
      return {
        ...feature,
        pitch: map(feature.pitch),
        drillDiameter: map(feature.drillDiameter),
        depth: rebuildHoleDepth(feature.depth, map),
        threadLength: map(feature.threadLength),
        tiltAngle: map(feature.tiltAngle),
        tiltAzimuth: map(feature.tiltAzimuth),
      };
    case 'fillet':
      return { ...feature, radius: map(feature.radius) };
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
  }
}

/**
 * 平面の決め方7種(FR-328)の式の欄を写す。3点・点+辺・点+平行な面は、点・辺・面の
 * 参照だけで位置が決まるので式を持たない。
 */
function rebuildPlaneSpec(spec: PlaneSpec, map: ValueMapper): PlaneSpec {
  switch (spec.kind) {
    case 'threePoints':
    case 'pointAndEdge':
    case 'pointAndParallelFace':
      return spec;
    case 'pointAndAxis':
      return { ...spec, tilt: map(spec.tilt), azimuth: map(spec.azimuth) };
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
    case 'referenceCoordinateSystem':
      // 軸も座標系も点・軸の参照だけで決まる(式を直接持たない)。
      return feature;
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
): ExpressionValue {
  const result = evaluateExpression(value.source, { variables });
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
): PartReevaluation {
  const failures: ReevaluationFailure[] = [];
  const next = mapDocumentExpressions(document, (value, ownerId) =>
    reevaluateValue(value, variables, (message) => {
      failures.push({ ownerId, source: value.source, message });
    }),
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
  const reevaluated = reevaluatePartDocument(document, analysis.variables);
  const parameters = mapKeepingIdentity(reevaluated.document.parameters, (parameter) =>
    mapParameter(parameter, (value) =>
      // 表の側の失敗は `analysis.failures` がすでに持っているので、ここでは数えない。
      reevaluateValue(value, analysis.variables, () => undefined),
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
