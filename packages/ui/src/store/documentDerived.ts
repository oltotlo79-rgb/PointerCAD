/**
 * 文書から導ける控えを作り直す純関数(P6 タスク52 で `useAppStore.ts` から切り出した)。
 *
 * **`document` を書き換える経路は必ずここの `documentPatch` を通る。** 経路ごとに同じ
 * 判定を書かないため(rules/04「導出できるものは保存しない」)。
 */
import {
  analyzeParameters,
  baseWorkPlane,
  canRedo as stackCanRedo,
  canUndo as stackCanUndo,
  collectExpressionSources,
  type ConstraintDiagnosis,
  type ConstraintTarget,
  DEFAULT_WORK_PLANE_ID,
  dotVec3,
  findFeature,
  findSketch,
  isFreeWorkPlaneId,
  type ParameterAnalysis,
  type PartDocument,
  type PartRecomputeError,
  type PartSketchResult,
  type ResolvedReferences,
  type ResolvedSketch,
  sketchConstraints,
  type SketchDocument,
  type SketchError,
  type SketchFeatureKind,
  type UndoStack,
  WORK_PLANE_IDS,
  WORK_PLANES,
  type WorkPlaneId,
} from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import { shouldShowTimelineHint } from '../shell/timelineHint.js';
import { type ConstraintSummary, summarizeConstraints } from '../sketch/constraintSummary.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import { resolveReferencesOf, resolveWorkPlaneOf } from '../sketch/referenceCommands.js';
import { type OrbitState, viewDirection } from '../viewport/cameraMath.js';
import type { AppState } from './appState.js';

/**
 * 同点とみなす傾きの差。等角のホーム視点では 3 面が等しく傾くが、三角関数の丸めで
 * 最下位桁だけが違う値になる。その 1 桁で選ばれる面が変わると、同じ見え方から
 * 違う結果が出て説明できない(NFR-UX-1)。差がこれ以下なら同点として先頭を採る。
 */
const ALIGNMENT_EPSILON = 1e-9;

/**
 * 今の視点に最も近い作図面を選ぶ(§0.a-0.3)。
 *
 * 画面に正対して見えている面ほど、その法線が視線と平行になる。だから法線と視線の
 * 内積の絶対値が最大の面を採る(手前から見ているか奥から見ているかは問わない)。
 * 等角のように 3 面が並ぶときは XY → XZ → YZ の先頭、つまり既定の XY を採る。
 * ビューキューブは視点だけを変え、作図面は変えない。作図面が変わるのはこの関数を
 * 呼ぶ「視点に合わせる」を押したときだけ(NFR-UX-1 操作文法の一貫性)。
 */
export function workPlaneForOrbit(orbit: OrbitState): WorkPlaneId {
  const direction = viewDirection(orbit);
  let best: WorkPlaneId = DEFAULT_WORK_PLANE_ID;
  let bestAlignment = -1;
  for (const id of WORK_PLANE_IDS) {
    const alignment = Math.abs(dotVec3(direction, WORK_PLANES[id].normal));
    if (alignment > bestAlignment + ALIGNMENT_EPSILON) {
      bestAlignment = alignment;
      best = id;
    }
  }
  return best;
}

/** いま編集しているスケッチ(§0.a-0.4)。指し先が消えていたら先頭を使う。 */
export function activeSketchOf(document: PartDocument): SketchDocument {
  return findSketch(document, document.activeSketchId) ?? document.sketches[0];
}

/**
 * そのスケッチが使っている作図面(P4 仕上げ (g)、FR-328、FR-501)。
 *
 * スケッチ文書そのものは作図面を持たない(持つのは要素 1 つ 1 つの `planeId`)。
 * だからスケッチを切り替えたときに札とビューポートを合わせる先は、**最後に置いた要素の
 * 作図面**から引く。文書から導ける値なので新しい控えを持たずに済み(rules/04「導出できる
 * ものは保存しない」)、ファイルを開き直しても同じ面へ戻る。
 *
 * まだ 1 つも要素が無いスケッチは面を決めようがないので null を返し、呼び出し側は
 * いまの作図面のままにする(新しく足した直後のスケッチがこれにあたる)。
 */
export function workPlaneOfSketch(sketch: SketchDocument | undefined): WorkPlaneId | null {
  if (sketch === undefined || sketch.features.length === 0) {
    return null;
  }
  return sketch.features[sketch.features.length - 1].planeId;
}

/**
 * 面の境界に使える要素の種類(§0.a-0.23 ⑨)。
 * `packages/ui/src/sketch/sketchCommands.ts` の `commitFace`(実体は `boundaryElementKind`)が
 * 受け付ける種類にそろえる。面フィーチャー自身は境界に使えない。
 *
 * P4 タスク12 で新しい図形(矩形・正多角形・長穴・楕円・スプライン)を足した。いずれも
 * 曲線を生むので面の囲みに使える(矩形・正多角形・長穴は 1 フィーチャーが複数の曲線を生み、
 * `resolveFace` が全周を展開する。§0.a-0.8)。
 * P4 タスク21 でオフセット(複製の曲線列)を足した。結果は元と同じ曲線なので同様に使える
 * (§2「結果の曲線は…面の境界に使える」)。
 */
const FACE_BOUNDARY_KINDS: ReadonlySet<SketchFeatureKind> = new Set([
  'point',
  'line',
  'arc',
  'pointArray',
  'rectangle',
  'polygon',
  'slot',
  'ellipse',
  'spline',
  'offset',
  // P4 タスク20 で複製(ミラー・複写・配列複写)を足した。複製の結果は元と同じ形の
  // 曲線・点なので、面の囲みにもそのまま使える(FR-324)。
  'copy',
  // P4 タスク25 で投影・交差を足した。取り込んだ輪郭は普通の線・円弧として扱えるので、
  // 面の囲みにも押し出しの材料にも使える(FR-325、計画書 §2「結果の曲線は…使える」)。
  'projectedCurve',
  'planeSection',
]);

/**
 * 面の道具を選んだときに、境界に使えない要素(面フィーチャー・立体・部分形状)を
 * 選択から外す(§0.a-0.23 ⑨)。計算中(幾何カーネルの初回読み込み中)に速い操作で
 * 面を張ろうとすると、選択に残った面や立体が境界へ混じって断られる不具合の対策。
 * 判定は `featureIdOf` で元の要素 id に戻し、いまのスケッチにその id の点・線・円弧・
 * 点列フィーチャーがあるかどうかで行う(立体の id はスケッチに無いのでここで外れる)。
 */
export function filterSelectionForFaceTool(
  sketch: SketchDocument,
  selection: readonly string[],
): readonly string[] {
  const kept = selection.filter((elementId) => {
    const feature = findFeature(sketch, featureIdOf(elementId));
    return feature !== undefined && FACE_BOUNDARY_KINDS.has(feature.kind);
  });
  return kept.length === selection.length ? selection : kept;
}

/** 文書を差し替えたときに一緒に作り直す控え(§0.a-0.4)。 */
export type DocumentPatch = Pick<
  AppState,
  | 'document'
  | 'undoStack'
  | 'canUndo'
  | 'canRedo'
  | 'sketch'
  | 'documentName'
  | 'featureNames'
  | 'selection'
  | 'hoveredElementId'
  | 'workPlaneId'
  | 'workPlane'
  | 'resolvedReferences'
  | 'parameterAnalysis'
  | 'nonLengthVariables'
>;

/**
 * 作図面 id が、その文書でまだ有効か(統括の指示、2026-09-05。P4b タスク22a-(5)・22b-(i))。
 *
 * 基準の3面(xy / xz / yz)は常に有効。任意の作業平面は、文書の `references` にその id の
 * 作業平面フィーチャーがあるときだけ有効とする。
 *
 * **3D スケッチ(`free`)の扱いは経路で分ける**(P4b タスク22b-(i)、統括の指示 2026-09-05)。
 * ・`replacesDocument`(新規・開く・復元)… 無効とし、基準の XY へ戻す。**新しい部品を
 *   3D スケッチのまま始めると、次に描く矩形が「3D スケッチではこの形をかけません」で
 *   必ず失敗する**(Electron 台本の項目 10〜13 がすべてこれで落ちた実測)。前の部品の
 *   作図面を持ち越さないのは、作業平面のときと同じ扱いにそろえる。
 * ・Undo / Redo … 有効のまま保つ。同じ部品の中の時をまたぐ移動でしかなく、利用者が
 *   選んだ 3D スケッチを勝手に降ろすと操作が飛ぶ。
 *
 * 文書を丸ごと差し替える経路で `workPlaneId` だけが古いまま残ると、次に置く矩形・線分が
 * その存在しない作図面を指して作られ、面が張れず「作図面が見つかりません」になる
 * (再現: 作業平面を作図面に切り替える → 新規 → 矩形 → 面を張る)。
 */
export function isWorkPlaneIdValidFor(
  document: PartDocument,
  planeId: WorkPlaneId,
  replacesDocument = false,
): boolean {
  if (baseWorkPlane(planeId) !== null) {
    return true;
  }
  if (isFreeWorkPlaneId(planeId)) {
    return !replacesDocument;
  }
  return document.references.some(
    (reference) => reference.kind === 'referencePlane' && reference.id === planeId,
  );
}

/**
 * つまみの知らせ(FR-507)を選ぶ(P4b タスク19・22b-(a))。
 *
 * ①途中まで戻したまま作ったときは「差し込みました」(タスク19)。
 * ②そうでなく、**ソリッドが初めて 2 段以上になった**ときは、つまみの初回の案内を 1 度だけ
 *   出す(利用者の決定①(2026-09-05))。既読は端末に覚えるので同じ人に二度は出ない。
 * ③どちらでもなければ何も言わない。
 */
export function timelineNoticeFor(
  state: AppState,
  next: PartDocument,
  inserted: boolean,
): MessageKey | null {
  if (inserted) {
    return 'timeline.inserted';
  }
  const show = shouldShowTimelineHint(
    state.document.solids.length,
    next.solids.length,
    state.displaySettings.timelineHintSeen,
  );
  return show ? 'timeline.hint' : null;
}

/**
 * 文書を差し替え、派生の控えを作り直す。**`document` を書き換えるのはここだけ。**
 *
 * 文書から消えたフィーチャーは選択とホバーからも外す(消えたものを指したままだと、
 * プロパティ欄が空を出し、次に同じ id が採番されたとき別物を選んで見える)。
 *
 * **部分形状の id(`extrude-1#face:0` 等)もここで一緒に掃除される**(§0.a-0.8)。
 * `liveIds.has(featureIdOf(id))` は `#` の前(ボディの id)しか見ないため、`as`
 * を使わずに済み、タスク20 が決めた id の書式(`subShapeSelection.ts`)を 1 行も
 * 変えずにそのまま効く。**ただし「ボディ自体は残っているが、面・辺・頂点の番号が
 * 再計算で範囲外になった」場合はここでは掃除されない**(ボディの id はまだ `liveIds`
 * にあるため)。この限界は表示側(タスク22 の `buildSubShapeGeometry`)が範囲外の
 * 参照を黙って描かないことで見た目の破綻を防ぐ想定(§2.11)。
 *
 * **作図面 `workPlaneId` もここで一緒に確かめる**(P4b タスク22a-(5))。`resetDocument` /
 * `applyDocument`(開く・復元)/ `undo` / `redo` はすべてここを通るので、経路ごとに同じ
 * 判定を書かずに済む。新しい文書にその作業平面が無ければ既定の XY へ戻す
 * (`referencePatch` が作り直す `workPlane` の解決先も、このあとの XY に揃う)。
 */
export function documentPatch(
  state: AppState,
  next: PartDocument,
  stack: UndoStack<PartDocument>,
  /**
   * 文書を丸ごと差し替える経路(新規・開く・復元)か。3D スケッチの扱いだけが変わる
   * (`isWorkPlaneIdValidFor` の注釈)。Undo / Redo と、形を変えただけの差し替えは false。
   */
  replacesDocument = false,
): DocumentPatch {
  const sketch = activeSketchOf(next);
  const liveIds = new Set<string>(sketch.features.map((feature) => feature.id));
  for (const solid of next.solids) {
    liveIds.add(solid.id);
  }
  const hovered = state.hoveredElementId;
  // 作図面が指す作業平面が新しい文書に無ければ既定の XY へ戻す(P4b タスク22a-(5))。
  const workPlaneId = isWorkPlaneIdValidFor(next, state.workPlaneId, replacesDocument)
    ? state.workPlaneId
    : DEFAULT_WORK_PLANE_ID;
  return {
    document: next,
    undoStack: stack,
    canUndo: stackCanUndo(stack),
    canRedo: stackCanRedo(stack),
    sketch,
    documentName: sketch.name,
    featureNames: sketch.features.map((feature) => feature.name),
    selection: state.selection.filter((id) => liveIds.has(featureIdOf(id))),
    hoveredElementId: hovered !== null && !liveIds.has(featureIdOf(hovered)) ? null : hovered,
    workPlaneId,
    // 基準ジオメトリ(FR-328、FR-329)は文書から導ける控えなので、ここで作り直す。
    ...referencePatch(next, workPlaneId),
    // パラメータ表(FR-207)も同じく文書から導ける控え。
    ...parameterPatch(next),
  };
}

/**
 * パラメータ表の控えを作り直す(FR-207、タスク11)。
 *
 * **パラメータが 1 つも無い文書では解析そのものを省く**(`referencePatch` と同じ理由)。
 * 解析は文書の全ての式を集めて「使われていない名前」を数えるので、欄で 1 文字打つたびに
 * 文書を歩くことになる。名前を 1 つも付けていない部品(いまの既定)では要らない費用なので
 * 空の解析を使い回す(NFR-PF-1)。
 */
export function parameterPatch(
  document: PartDocument,
): Pick<AppState, 'parameterAnalysis' | 'nonLengthVariables'> {
  if (document.parameters.length === 0) {
    return {
      parameterAnalysis: EMPTY_PARAMETER_ANALYSIS,
      nonLengthVariables: EMPTY_NON_LENGTH_VARIABLES,
    };
  }
  const parameterAnalysis = analyzeParameters(document.parameters, collectExpressionSources(document));
  return { parameterAnalysis, nonLengthVariables: parameterAnalysis.nonLengthVariables };
}

/** 長さでないパラメータが 1 つも無いときの集合。作り直さずに使い回す(参照の同一性)。 */
export const EMPTY_NON_LENGTH_VARIABLES: ReadonlySet<string> = new Set<string>();

/** パラメータが 1 つも無いときの控え。作り直さずに使い回す(参照の同一性を保つ)。 */
export const EMPTY_PARAMETER_ANALYSIS: ParameterAnalysis = {
  exactVariables: new Map<string, string>(),
  nonLengthVariables: EMPTY_NON_LENGTH_VARIABLES,
  variables: new Map<string, number>(),
  circular: [],
  unused: [],
  failures: [],
};

/**
 * 作業平面と基準ジオメトリの控えを作り直す(タスク13)。
 *
 * 基準ジオメトリが 1 つも無い文書(P4 より前に作ったものを含む)では解決そのものを
 * 省く。プロパティ欄で 1 文字打つたびにここを通るので、要らない計算を積まないため
 * (NFR-PF-1)。
 */
export function referencePatch(
  document: PartDocument,
  planeId: WorkPlaneId,
): Pick<AppState, 'workPlane' | 'resolvedReferences'> {
  if (document.references.length === 0) {
    return {
      workPlane: baseWorkPlane(planeId) ?? WORK_PLANES[DEFAULT_WORK_PLANE_ID],
      resolvedReferences: EMPTY_RESOLVED_REFERENCES,
    };
  }
  return {
    workPlane: resolveWorkPlaneOf(document, planeId),
    resolvedReferences: resolveReferencesOf(document),
  };
}

/** 基準ジオメトリが 1 つも無いときの控え。作り直さずに使い回す(参照の同一性を保つ)。 */
export const EMPTY_RESOLVED_REFERENCES: ResolvedReferences = {
  planes: [],
  axes: [],
  points: [],
  coordinateSystems: [],
  errors: [],
};

/**
 * いま編集しているスケッチの失敗だけを控えへ写す(§0.a-0.4、FR-504)。
 *
 * 解決の失敗はスケッチごとの結果にそのまま入っている。カーネルが面を作れなかった失敗は
 * 部品全体の `errors` に混ざって届き、型の上では PartError と見分けが付かないので、
 * そのスケッチの要素 id を持ち、かつ解決の失敗として出ていないものを拾い直す。
 * 付け直す code は `recomputePart` が付けるものと同じ `kernelFailed`(強制変換を使わずに
 * 型を狭めるため、拾ったものをそのまま入れずに作り直している)。
 */
export function activeSketchErrors(
  sketch: SketchDocument,
  result: PartSketchResult,
  errors: readonly PartRecomputeError[],
): readonly SketchError[] {
  const resolveErrors = result.resolved.errors;
  const reported = new Set(resolveErrors.map((error) => error.featureId));
  const featureIds = new Set(sketch.features.map((feature) => feature.id));
  const kernelErrors: SketchError[] = [];
  for (const error of errors) {
    if (featureIds.has(error.featureId) && !reported.has(error.featureId)) {
      kernelErrors.push({
        featureId: error.featureId,
        code: 'kernelFailed',
        message: error.message,
      });
    }
  }
  return kernelErrors.length === 0 ? resolveErrors : [...resolveErrors, ...kernelErrors];
}

/** 拘束の道具でまだ何も押していないときの並び。作り直さずに使い回す。 */
export const NO_CONSTRAINT_TARGETS: readonly ConstraintTarget[] = [];

/** 拘束が 1 つも無いときの一覧。作り直さずに使い回す(参照の同一性を保つ)。 */
export const NO_CONSTRAINT_SUMMARIES: readonly ConstraintSummary[] = [];

/**
 * 拘束の一覧の行を作り直す(FR-313、タスク13)。**拘束が 1 つも無い文書では歩き直さない**
 * (`parameterPatch` / `referencePatch` と同じ理由。いまの既定の部品は拘束を持たない)。
 *
 * 材料は「いま描いている解決結果」をそのまま使い回す。印に要るのは位置と名前だけで、
 * 動かせる数(`variableSet`)は診断(`diagnosis`)が持っているため、ここで解き直さない。
 */
export function constraintSummaryPatch(
  sketch: SketchDocument,
  resolved: ResolvedSketch,
  diagnosis: ConstraintDiagnosis | null,
): Pick<AppState, 'constraintSummaries'> {
  // `constraints` は版 5 で足した任意の欄なので、古い文書では持たないことがある
  // (model の `sketchConstraints` と同じ扱い)。
  if (sketchConstraints(sketch).length === 0) {
    return { constraintSummaries: NO_CONSTRAINT_SUMMARIES };
  }
  return {
    constraintSummaries: summarizeConstraints(sketch, diagnosis, {
      resolved,
      // 位置と名前しか読まないので、作図面と動かせる数は要らない(上の注釈のとおり)。
      plane: null,
      variableSet: null,
    }),
  };
}
