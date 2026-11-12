import { unitDirectionCaptured as normalizeDirection } from './normalizeDirection.js';
import type { FaceOrigin, CurrentOriginIndex } from '../subShapeOrigin.js';
import { surfacePrismSubShapeOrigins, type NativeSurfaceLine } from './subShapeOrigins.js';
import { surfaceArcAnchorValid, surfaceArcPrismOrigins } from './surfaceArcOrigins.js';
import { makeTrackedPlanarFace, planarSurfaceAnchorRefusal, planarSurfaceSubShapeOrigins } from './planarSurfaceOrigins.js';
/**
 * 曲面(面だけの形、FR-428)。
 *
 * **立体にならない形をあえて作る、この 1 ファイルだけの例外。** これまで、
 * 段の結果は必ず `hasSolid` と体積で「閉じた立体になったか」を確かめてきた。空のブーリアンの
 * 結果は `IsDone()` も `HasErrors()` も嘘をつくので、**体積でしか捕まえられない**ためである。
 * 曲面はその検査を通らないので、
 * そこで「面のボディを許す。ただし `bodyKind: 'shell'` という印を明示的に持つ」と決めた。
 *
 * **緩めるのではなく、逆向きに厳しくする。** この関数は「立体ができたら失敗」とし
 * (`hasSolid` が真なら断る)、代わりに**面積 > 0** を確かめる。ソリッドの段
 * (押し出し・回転・ブーリアン・穴・面取り…)の検査は 1 つも触らない。分岐は
 * このファイルの中だけで閉じており、「体積 0 は失敗」の規律に穴を開けない。
 *
 * ## 作れる面の種類(「曲面の段の種類」)
 *
 * | 種類 | 作り方 | 結果の形 |
 * |---|---|---|
 * | `extrude` | 輪郭の**ワイヤ**(面ではない)を `BRepPrimAPI_MakePrism_1` で掃く | 殻 |
 * | `revolve` | 輪郭の**ワイヤ**を `BRepPrimAPI_MakeRevol_1` で回す | 殻 |
 * | `planar` | 閉じた輪郭から平らな面を 1 枚張る(`makePlanarFace`) | 面 |
 * | `loft` | `BRepOffsetAPI_ThruSections` を `isSolid = false` で回す | 殻 |
 * | `face` | すでにある立体の面を指紋で選び直して取り出す(`pickSubShape`) | 面 |
 * | `offset` | 選び直した面を `BRepOffsetAPI_MakeOffsetShape.PerformBySimple` で距離だけ離す | 殻 |
 *
 * **押し出しと回転が立体の版(`makeSolidSweep.ts`)と違うのは 1 か所だけ**である。
 * あちらは `makePlanarFace` で張った**面**を掃き、こちらは輪郭の**ワイヤ**をそのまま掃く。
 * 掃く相手が面なら中身の詰まった立体に、ワイヤなら厚みのない殻になる(OCCT の
 * `BRepPrimAPI_MakePrism` / `MakeRevol` は掃く相手の次元をそのまま 1 つ上げる)。
 * だから輪郭が閉じている必要が無く、線分 1 本からでも面が作れる。
 *
 * ## 曲面の段の種類
 *
 * 当初の案の `SurfaceOperation` は `extrude` / `revolve` / `offset` / `sew` /
 * `thicken` の 5 つだったが、採ったのは「曲面の段の種類」(開いた輪郭の
 * 押し出し・回転の面版、既存の面の複製、ロフトの面版)に沿った 5 つである。
 * 後から**面のオフセット(`offset`)を 6 つ目として足した**ので、
 * いまは 6 種ある。
 * **厚み付け(`MakeThickSolidBySimple`)はここには無い。** 結果が立体になるので、
 * そもそもこの関数の「立体ができたら失敗」と噛み合わないためである
 * (くり抜き(FR-418)として `makeShell.ts` が受け持つ)。
 *
 * ## 曲面に対する加工を断る場所
 *
 * フィレット・面取り・穴のような加工は面だけの形には掛けられない。その断りを既存の
 * `make*.ts` の側で出すので、ここでは判定の関数
 * (`isShellShape`)と文言(`SHELL_NOT_SUPPORTED_MESSAGE`)だけを用意する。
 */

import type {
  OpenCascadeInstance,
  TopoDS_Shape,
  TopoDS_Edge,
  TopoDS_Wire,
} from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec, SubShapeQuery, TessellationOptions, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makePlanarFace } from './makePlanarFace.js';
import { makeCurveEdge } from './makeSketchEdges.js';
import { continuousCurvePieces } from './continuousCurvePieces.js';
import { APPROXIMATION_TOLERANCE_MM } from './tolerances.js';
import { MISSING_SUB_SHAPE_MESSAGE, pickSubShape } from './pickSubShape.js';
import { measureArea } from './solidMesh.js';
import { shapeBodyKind } from './shapeBodyKind.js';
import type { SubShapeTables } from './subShapes.js';

/** つなぐには断面が 2 つ要る(`makeThruSections.ts` と同じ決め)。 */
const MINIMUM_SECTION_COUNT = 2;

/** これ以下(mm²)の面積は「面ができなかった」とみなす。体積の下限(1e-9)と桁を揃える。 */
const MIN_SURFACE_AREA_MM2 = 1e-9;


/** 回転角の上限(ラジアン)。`makeSolidSweep.ts` と同じく、丸めの揺れぶんだけ余裕を持たせる。 */
const MAX_REVOLVE_ANGLE = 2 * Math.PI + 1e-9;

/**
 * 面が作れなかったときの断り(FR-504、NFR-RE-1)。
 * 検証の表が「`面を作れませんでした。` を含む Error」を求めているので、
 * この文言で始める(呼び出し側の `recomputeSolids` がそのまま理由として拾う)。
 */
const SURFACE_FAILED_MESSAGE = '面を作れませんでした。輪郭と向きを見直してください。';

/** 掃いた結果が立体になってしまったとき。曲面の段は面だけの形しか返さない。 */
const NOT_A_SURFACE_MESSAGE = '面を作れませんでした。立体になったので、押し出しの段を使ってください。';

/** 曲線が 1 本も無いとき(`makePlanarFace.ts` と同じ文言)。 */
const NO_CURVE_MESSAGE = '面を作るには曲線が 1 本以上必要です。';

/** 曲線どうしが離れていてワイヤにならないとき(`makePlanarFace.ts` と同じ文言)。 */
const DISCONNECTED_MESSAGE = '選んだ線・円弧がつながっていないため、輪郭を作れませんでした。';

/** 押し出す長さが取れないとき(`makeSolidSweep.ts` と同じ文言)。 */
const DISTANCE_MESSAGE = '押し出す長さは 0 より大きい数にしてください。';

/** 回転の角度が取れないとき(`makeSolidSweep.ts` と同じ文言)。 */
const ANGLE_MESSAGE = '回転の角度は 0 より大きく 360 度以下にしてください。';

/** 押し出す向きが決まらないとき。 */
const DIRECTION_MESSAGE = '押し出す向きが決まりません。向きを選び直してください。';

/** 回転の軸が決まらないとき(`makeSolidSweep.ts` と同じ文言)。 */
const AXIS_MESSAGE = '回転の軸が決まりません。軸を選び直してください。';

/** つなぐ断面が足りないとき(`makeThruSections.ts` と同じ文言)。 */
const TOO_FEW_SECTIONS_MESSAGE = 'つなぐ面を 2 つ選んでください。';

/** 面を取り出す相手の立体が渡されていないとき(呼び出し側の組み立ての誤り)。 */
const NO_TARGET_MESSAGE = '面を取り出す立体が選ばれていません。立体を選び直してください。';

/** 面ではないもの(辺・頂点)の指紋が来たとき。 */
const NOT_A_FACE_QUERY_MESSAGE = '面を選んでください。線や点からは面を作れません。';

/** 面をずらす距離が 0、または数でないとき(FR-504)。 */
const OFFSET_DISTANCE_MESSAGE = '面をずらす距離は 0 以外の数にしてください。';

/** ずらした面が作れなかったとき(距離が大きすぎて面が潰れる等)。 */
const OFFSET_FAILED_MESSAGE = '面をずらせませんでした。距離を小さくしてください。';

/**
 * 面だけの形か(= `SolidBodyMesh.bodyKind` が `'shell'` になるか)。
 *
 * 判定は表示と共通のshapeBodyKindで行い、開面と立体が混在する形も加工前に断る。
 * 判定を 2 か所に持つと、表示は面のボディなのに加工は通る、といった食い違いが起きるため。
 *
 * `oc` を取るのは、部分形状を数えるのに OCCT の実体が要るためである
 * (`hasSolid` は `TopExp.MapShapes_2` と `ShapeType()` の値比較でソリッドを探す)。
 */
export function isShellShape(oc: OpenCascadeInstance, shape: TopoDS_Shape): boolean {
  return shapeBodyKind(oc, shape) !== 'solid';
}

/**
 * 曲面の段の入力(FR-428)。**6 つのうち `face` と `offset` だけが相手の立体を要る**
 * (どちらも借りるだけで消費しない)。
 *
 * 角度はラジアンで受け取る(度からの換算は model 側の責務)。
 */
export type SurfaceInput =
  /** 輪郭を向きへ掃いた面。輪郭は閉じていなくてよい(線分 1 本からでも面になる)。 */
  | {
      readonly kind: 'extrude';
      readonly profile: readonly CurveSpec[];
      readonly curveProfileOrigin?: Extract<FaceOrigin, { readonly kind: 'surface-curve-side' }>['profile'];
      readonly profileOrigins?: readonly Extract<FaceOrigin, { readonly kind: 'surface-side' }>['profile'][];
      readonly direction: Vec3Tuple;
      readonly distance: number;
    }
  /** 輪郭を軸まわりに回した面。半円弧を全周回せば球面になる。 */
  | {
      readonly kind: 'revolve';
      readonly profile: readonly CurveSpec[];
      readonly axisOrigin: Vec3Tuple;
      readonly axisDirection: Vec3Tuple;
      readonly angle: number;
    }
  /**
   * 閉じた輪郭から張った平らな面 1 枚。`profileOrigins` は輪郭の各線の保存された持ち主(線分だけの輪郭のとき
   * だけ model が付ける)。あれば面・辺・頂点に追跡できる名前を付ける(`planarSurfaceOrigins.ts`)。
   */
  | {
      readonly kind: 'planar';
      readonly profile: readonly CurveSpec[];
      readonly profileOrigins?: readonly Extract<FaceOrigin, { readonly kind: 'surface-side' }>['profile'][];
    }
  /** 輪郭どうしをつないだ面(ロフトの面版)。ふたを張らないので殻のまま残る。 */
  | {
      readonly kind: 'loft';
      readonly sections: readonly (readonly CurveSpec[])[];
      /** true なら直線で結ぶ(罫線)、false ならなめらかに結ぶ(ロフト)。 */
      readonly ruled: boolean;
    }
  /** すでにある立体の面を指紋で選び直して取り出した面 1 枚。 */
  | { readonly kind: 'face'; readonly face: SubShapeQuery }
  /**
   * すでにある立体の面を指紋で選び直し、その面を距離だけ離した殻(FR-428)。
   *
   * `face` と同じく相手の立体を借りるだけで**消費しない**(材料にした立体は画面に残る)。
   * `distance` は面の向き(法線)の側を正とし、負にすれば逆へ離れる。0 と数でない値は断る。
   */
  | { readonly kind: 'offset'; readonly face: SubShapeQuery; readonly distance: number };

/**
 * 曲面の段の結果。**測り済みの面積を持ったまま返る。**
 *
 * 面積は「面ができたか」の判定のためにこの関数の中で必ず 1 回測っている。
 * 呼び出し側(`recomputeSolids`)は `bodyKind: 'shell'` のボディの
 * プロパティに面積を出すので、同じ形をもう一度測らずに済むよう添えて返す
 * (ブーリアンが体積を添えて返す `booleanOp.ts` の `BooleanResult` と同じ考え)。
 */
export interface SurfaceResult extends OcctShapeHandle {
  /** 面の合計面積(mm²)。必ず 0 より大きい。 */
  readonly area: number;
}


/** 3 つとも実数か(NaN と無限大を弾く)。 */
function isFinitePoint(point: Vec3Tuple): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);
}

/**
 * 輪郭の曲線からワイヤを 1 本作る。
 *
 * **閉じているかを確かめない**ところだけが `makePlanarFace.ts` /
 * `makeThruSections.ts` の `makeSectionWire` と違う。曲面は開いた輪郭からでも
 * 作れることが要点なので、ここで閉じ方を要求してはいけない。
 */
function makeProfileWire(
  oc: OpenCascadeInstance,
  curves: readonly CurveSpec[],
  keep: Allocations['keep'],
  lines?: NativeSurfaceLine[],
  anchors?: Extract<SurfaceInput, { kind: 'extrude' }>['profileOrigins'],
  arcEdges?: TopoDS_Edge[],
): TopoDS_Wire {
  if (curves.length === 0) {
    throw new Error(NO_CURVE_MESSAGE);
  }
  const wireMaker = keep(new oc.BRepBuilderAPI_MakeWire_1());
  let index = 0;
  for (const curve of continuousCurvePieces(curves)) {
    wireMaker.Add_1(keep(makeCurveEdge(oc, curve)).edge);
    if (lines !== undefined && anchors !== undefined && wireMaker.IsDone()) {
      lines.push({ edge: keep(wireMaker.Edge()), anchor: anchors[index] });
    }
    if (arcEdges !== undefined && wireMaker.IsDone()) arcEdges.push(keep(wireMaker.Edge()));
    index += 1;
  }
  if (!wireMaker.IsDone()) {
    throw new Error(DISCONNECTED_MESSAGE);
  }
  return keep(wireMaker.Wire());
}

/**
 * 輪郭のワイヤを向きへ掃いた面(「開いた輪郭の押し出しの面版」)。
 *
 * 第 3 引数 Copy = false、第 4 引数 Canonize = true は `makeSolidSweep.ts` と同じ理由による
 * (断面はこの中で作り捨てるので複製しない。平らな輪郭を掃いた面は平面として持っておく)。
 */
function extrudeProfile(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  input: Extract<SurfaceInput, { kind: 'extrude' }>,
  semantic?: { readonly featureId: string; origins?: CurrentOriginIndex },
): TopoDS_Shape {
  const direction = normalizeDirection(input.direction);
  if (direction === null) {
    throw new Error(DIRECTION_MESSAGE);
  }
  if (!Number.isFinite(input.distance) || input.distance <= 0) {
    throw new Error(DISTANCE_MESSAGE);
  }

  const lines: NativeSurfaceLine[] = [];
  const anchors = semantic !== undefined && input.profileOrigins?.length === input.profile.length
    && input.profile.every(curve => curve.kind === 'segment') ? input.profileOrigins : undefined;
  const arcEdges: TopoDS_Edge[] = [];
  const arcOrigin = semantic !== undefined && surfaceArcAnchorValid(input.profile, input.curveProfileOrigin)
    ? input.curveProfileOrigin : undefined;
  const wire = makeProfileWire(oc, input.profile, keep, anchors === undefined ? undefined : lines, anchors,
    arcOrigin === undefined ? undefined : arcEdges);
  const vector = keep(
    new oc.gp_Vec_4(
      direction[0] * input.distance,
      direction[1] * input.distance,
      direction[2] * input.distance,
    ),
  );
  const maker = keep(new oc.BRepPrimAPI_MakePrism_1(wire, vector, false, true));
  // 成否は IsDone() だけで見る(Error() の戻り値は空の型 `{}` で比較できない)。
  if (!maker.IsDone()) {
    throw new Error(SURFACE_FAILED_MESSAGE);
  }
  const shape = keep(maker.Shape());
  if (semantic !== undefined && anchors !== undefined) {
    semantic.origins = surfacePrismSubShapeOrigins(oc, maker, wire, shape, lines, semantic.featureId);
  }
  if (semantic !== undefined && input.curveProfileOrigin !== undefined) {
    const arc = input.profile[0];
    semantic.origins = arcOrigin !== undefined && arcEdges.length === 1 && arc.kind === 'arc'
      ? surfaceArcPrismOrigins(oc, maker, wire, shape, arcEdges[0], arc, arcOrigin, semantic.featureId)
      : { version: 1, state: 'untracked', reason: 'unsupported-profile-piece' };
  }
  return shape;
}

/**
 * 閉じた輪郭から平らな面を 1 枚張る(`planar`)。
 *
 * 保存された線の持ち主(`profileOrigins`)が付いていて、線分だけの閉じた輪郭(3〜32 本)のときだけ、
 * 線ごとに実際にワイヤへ入った辺を控えて面・辺・頂点へ名前を付ける(`planarSurfaceOrigins.ts`)。
 * 持ち主の無い輪郭、円・円弧・曲線を含む輪郭は従来どおり `makePlanarFace` で張り、名前を付けない
 * (同じ追跡性を装わない)。閉じていない・自己交差・非平面の断りの文言はどちらの道でも同じ。
 */
function planarProfile(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  input: Extract<SurfaceInput, { kind: 'planar' }>,
  options: TessellationOptions,
  semantic?: { readonly featureId: string; origins?: CurrentOriginIndex },
): TopoDS_Shape {
  const anchors = input.profileOrigins;
  if (semantic !== undefined && anchors !== undefined) {
    const refusal = planarSurfaceAnchorRefusal(input.profile, anchors, semantic.featureId);
    if (refusal === null) {
      const tracked = makeTrackedPlanarFace(oc, keep, input.profile);
      semantic.origins = planarSurfaceSubShapeOrigins(oc, tracked.face, tracked.insertedEdges, anchors,
        semantic.featureId);
      return tracked.face;
    }
    semantic.origins = { version: 1, state: 'untracked', reason: refusal };
  }
  // 閉じていない・自己交差・非平面は makePlanarFace が理由つきで断り、
  // その文言がそのまま呼び出し側へ伝わる(`makeSolidSweep.ts` と同じ)。
  return keep(makePlanarFace(oc, input.profile, options)).face;
}

/**
 * 輪郭のワイヤを軸まわりに回した面(「回転の面版」)。
 *
 * 輪郭の端が軸に乗っていてもよい(半円弧を全周回すと、両端が軸に乗った球面になる)。
 * `IsDone()` が false のまま `Shape()` を呼ぶと C++ の例外が飛ぶので、先に見る
 * (`makeSolidSweep.ts` の `makeRevolveSolid` と同じ扱い)。
 */
function revolveProfile(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  input: Extract<SurfaceInput, { kind: 'revolve' }>,
): TopoDS_Shape {
  if (!Number.isFinite(input.angle) || input.angle <= 0 || input.angle > MAX_REVOLVE_ANGLE) {
    throw new Error(ANGLE_MESSAGE);
  }
  const axisDirection = normalizeDirection(input.axisDirection);
  if (axisDirection === null || !isFinitePoint(input.axisOrigin)) {
    throw new Error(AXIS_MESSAGE);
  }

  const wire = makeProfileWire(oc, input.profile, keep);
  const origin = keep(
    new oc.gp_Pnt_3(input.axisOrigin[0], input.axisOrigin[1], input.axisOrigin[2]),
  );
  const towards = keep(new oc.gp_Dir_4(axisDirection[0], axisDirection[1], axisDirection[2]));
  const axis = keep(new oc.gp_Ax1_2(origin, towards));
  const maker = keep(new oc.BRepPrimAPI_MakeRevol_1(wire, axis, input.angle, false));
  if (!maker.IsDone()) {
    throw new Error(SURFACE_FAILED_MESSAGE);
  }
  return keep(maker.Shape());
}

/**
 * 輪郭どうしをつないだ面(「ロフトの面版」)。
 *
 * `BRepOffsetAPI_ThruSections` の第 1 引数 `isSolid` に **false** を渡すところだけが
 * `makeThruSections.ts` と違う(あちらは両端にふたを張って立体にする)。ふたが無いので
 * 結果は側面だけの殻になり、`hasSolid` は偽になる。
 * 列挙を取る `SetParType` / `SetContinuity` は呼ばない。
 */
function loftProfiles(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  input: Extract<SurfaceInput, { kind: 'loft' }>,
): TopoDS_Shape {
  if (input.sections.length < MINIMUM_SECTION_COUNT) {
    throw new Error(TOO_FEW_SECTIONS_MESSAGE);
  }
  const maker = keep(new oc.BRepOffsetAPI_ThruSections(false, input.ruled, APPROXIMATION_TOLERANCE_MM));
  // 辺の数と向きを揃える(`makeThruSections.ts` と同じ。輪郭ごとに稜線の数が違ってもよい)。
  maker.CheckCompatibility(true);
  for (const section of input.sections) {
    maker.AddWire(makeProfileWire(oc, section, keep));
  }
  maker.Build(keep(new oc.Message_ProgressRange_1()));
  // IsDone() を見る前に Shape() を呼ばない(`makeThruSections.ts` と同じ扱い)。
  if (!maker.IsDone()) {
    throw new Error(SURFACE_FAILED_MESSAGE);
  }
  return keep(maker.Shape());
}

/**
 * すでにある立体の面を指紋で選び直して取り出す(「既存の面の複製」)。
 *
 * 選び直しは `pickSubShape.ts` へ任せる。**加工フィーチャー(穴・フィレット・面取り)と
 * 同じ採点・同じしきい値**なので、同じ指紋からは必ず同じ面が選ばれる。
 * 取り出した面は新しく作られた形なので、この関数の控えへ積んで解放を引き受ける。
 *
 * **選び直した面は、そのまま返さずに必ず複製する(名前のとおり「複製」する)。**
 * `pickSubShape` が返す面は形状キャッシュが持つ立体の部分形状そのもので、下地の
 * `TopoDS_TShape` を共有している。共有したまま OCCT の builder(この段では
 * `offsetExistingFace` の `BRepOffsetAPI_MakeOffsetShape`)へ渡すと、組む途中の
 * 書き込み(稜線への pcurve の追加、許容誤差の広げ直し)がキャッシュ上の立体へ届き、
 * **面を貸した立体をあとから切る・くり抜く段が壊れる**。同じ事故を
 * `makeThruSections.ts` の `sectionWireFromFace` で実測した。
 * 第 2 引数 true は下地の幾何も複製する指定、第 3 引数 false は三角形分割を
 * 複製しない指定(`makeCut.ts` の `copyTarget` と同じ)。
 */
function copyExistingFace(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  input: Extract<SurfaceInput, { kind: 'face' }>,
  target: TopoDS_Shape | null,
  tables: SubShapeTables | null,
): TopoDS_Shape {
  if (target === null || tables === null) {
    throw new Error(NO_TARGET_MESSAGE);
  }
  if (input.face.kind !== 'face') {
    throw new Error(NOT_A_FACE_QUERY_MESSAGE);
  }
  const picked = pickSubShape(oc, target, tables, input.face);
  if (picked === null) {
    throw new Error(MISSING_SUB_SHAPE_MESSAGE);
  }
  keep(picked);
  const copier = keep(new oc.BRepBuilderAPI_Copy_2(picked, true, false));
  return keep(copier.Shape());
}

/**
 * 選び直した面を距離だけ離した殻(「面のオフセット」、FR-428)。
 *
 * **`BRepOffsetAPI_MakeOffsetShape.PerformBySimple(形, 距離)` を使う**。
 * この呼び方は**列挙引数を 1 つも取らない**ので、述語ガードを増やさずに済む
 * (列挙 2 個を取る `PerformByJoin` は `makeShell.ts` のくり抜きだけが使う)。
 * `MakeOffset()` は呼ばない——戻り型の `BRepOffset_MakeOffset` は型定義にクラス宣言が
 * 無く、参照すると型が壊れるためである。
 *
 * 距離 0 は「離さない」ので面がそのまま返り、オフセットの段として意味を持たない。
 * 数でない値も含めて入口で断る(FR-504、NFR-RE-1。止めずに理由を出す)。
 * 距離が負なら法線の逆側へ離れる(利用者が向きを選べるようにしてある)ので弾かない。
 *
 * 面を選び直す手順は `copyExistingFace` とまったく同じ(同じ指紋からは同じ面が選ばれる)。
 * 結果が立体になっていないこと・面積が出ていることの確認は、呼び出し元の `makeSurface` が
 * 他の 5 種とまとめて行う。
 */
function offsetExistingFace(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  input: Extract<SurfaceInput, { kind: 'offset' }>,
  target: TopoDS_Shape | null,
  tables: SubShapeTables | null,
): TopoDS_Shape {
  if (!Number.isFinite(input.distance) || input.distance === 0) {
    throw new Error(OFFSET_DISTANCE_MESSAGE);
  }
  const face = copyExistingFace(oc, keep, { kind: 'face', face: input.face }, target, tables);
  const maker = keep(new oc.BRepOffsetAPI_MakeOffsetShape());
  maker.PerformBySimple(face, input.distance);
  // IsDone() が偽のまま Shape() を呼ぶと C++ の例外が飛ぶので、先に見る
  // (`makeShell.ts` / `makeThruSections.ts` と同じ扱い)。
  if (!maker.IsDone()) {
    throw new Error(OFFSET_FAILED_MESSAGE);
  }
  return keep(maker.Shape());
}

/** 種類ごとの作り分け。`switch` の各節は必ず `return` で閉じる(`no-fallthrough`)。 */
function buildSurfaceShape(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  input: SurfaceInput,
  target: TopoDS_Shape | null,
  tables: SubShapeTables | null,
  options: TessellationOptions,
): TopoDS_Shape {
  switch (input.kind) {
    case 'extrude':
      return extrudeProfile(oc, keep, input);
    case 'revolve':
      return revolveProfile(oc, keep, input);
    case 'planar':
      return planarProfile(oc, keep, input, options);
    case 'loft':
      return loftProfiles(oc, keep, input);
    case 'face':
      return copyExistingFace(oc, keep, input, target, tables);
    case 'offset':
      return offsetExistingFace(oc, keep, input, target, tables);
  }
}

/**
 * 面だけの形(厚みのない面)を作る(FR-428)。
 *
 * **対象を消費しない「作る」段**(押し出し・回転・基本形状と同じ)。
 * `face`(既存の面の取り出し)で材料にした立体もそのまま画面に残る。
 *
 * `target` と `tables` は `input.kind` が `'face'` か `'offset'` のときだけ要る。**`target` は
 * 解放しない**(形状キャッシュの持ち物。`booleanOp.ts` / `makeEmboss.ts` と同じ約束)。
 * `tables` は `target` から作った部分形状の一覧で、別の形から作った一覧を渡すと
 * 「面が見つかりません」で断る。
 *
 * 断るときは利用者へそのまま見せられる日本語の Error を投げ、呼び出し側
 * (`recomputeSolids`)が理由として拾う(FR-504、NFR-RE-1。止めずに理由を出す)。
 */
export function makeSurface(
  oc: OpenCascadeInstance,
  input: SurfaceInput,
  target: TopoDS_Shape | null = null,
  tables: SubShapeTables | null = null,
  options: TessellationOptions = {},
  featureId?: string,
): SurfaceResult {
  const { keep, release } = createAllocations();
  try {
    const semantic: { readonly featureId: string; origins?: CurrentOriginIndex } | undefined =
      featureId === undefined ? undefined : { featureId };
    const shape = input.kind === 'extrude' ? extrudeProfile(oc, keep, input, semantic)
      : input.kind === 'planar' ? planarProfile(oc, keep, input, options, semantic)
      : buildSurfaceShape(oc, keep, input, target, tables, options);

    // ここが「体積 0 は失敗」の裏返しにあたる 2 つの検査。
    // ① 立体ができていたら断る。曲面の段はソリッドを作らないので、
    //    立体ができたということは入力か作り方が食い違っている合図である。
    if (!isShellShape(oc, shape)) {
      throw new Error(NOT_A_SURFACE_MESSAGE);
    }
    // ② 面積が出ていることを確かめる。潰れた輪郭・長さ 0 の掃引では、OCCT が
    //    成功を返しても面積 0 の形になる(立体の段が体積で捕まえているのと同じ性質)。
    const area = measureArea(oc, shape);
    if (!Number.isFinite(area) || Math.abs(area) <= MIN_SURFACE_AREA_MM2) {
      throw new Error(SURFACE_FAILED_MESSAGE);
    }

    return { shape, area: Math.abs(area), delete: release,
      ...(semantic?.origins === undefined ? {} : { origins: semantic.origins }) };
  } catch (error) {
    release();
    // OCCT の C++ 例外は数値で飛んでくる(`makeThruSections.ts` / `makeFillet.ts` と同じ)。
    throw error instanceof Error ? error : new Error(SURFACE_FAILED_MESSAGE);
  }
}
