/**
 * ソリッド履歴の解決と消費の判定(計画書 docs/plans/P2-ソリッド基礎.md タスク11、§2.2、§2.5)。
 *
 * 部品文書(保存する形)を、カーネルへ渡せる「1段ずつの作り方」(SolidStepPlan)へ直す。
 * ここで済ませるのは model 側で計算できることだけ:
 *   - 断面の座標の解決(P1 の resolveSketch)
 *   - 押し出しの向き・反転・両側の平行移動(§0.a-0.8。OCCT の gp_Trsf を使わない)
 *   - 回転軸の解決と角度の度→ラジアン(§0.a-0.9)
 *   - ボディの消費の判定(§0.a-0.5、§2.2)
 *   - 形状キャッシュの鍵(§0.a-0.20。part/cacheKey.ts へ材料を渡す)
 *
 * **例外を投げない。** 解決できない段はボディを作らず、理由を errors へ入れて次の段へ進む
 * (FR-504、NFR-RE-1「止めずに警告する」)。失敗した段のボディは下流から見えないので、
 * それを入力にするブーリアンは missingBody で失敗する(理由が連鎖して伝わる)。
 *
 * 解決結果は保存しない(rules/04-設計の規律.md「導出できるものは保存しない」)。
 * 型を part/types.ts ではなくこのファイルへ置くのは、part/types.ts が「保存する形」だけを
 * 集めた場所であり、解決結果(導出物)を混ぜると保存対象の見分けがつかなくなるため。
 * 鍵の材料の型を cacheKey.ts が自分で持つのと同じ方針(docs/報告記録.md 2026-09-03 07:35 の④)。
 *
 * P3(docs/plans/P3-加工フィーチャー.md タスク15)で穴(FR-405)とねじ穴(FR-406)を足した。
 * ここで済ませるのは model 側で計算できることだけで、次の3つは**カーネルの責務**である
 * (model は面の指紋しか持たず、面の平面も境界箱も知らないため。§2.4.2):
 *   - 面の指紋からの選び直し(見つからなければカーネルが断り、タスク17 が missingSubShape に詰める)
 *   - 中心点の面への投影と、掘る向き(面の法線と傾き角・方位角から作る)
 *   - 貫通穴の長さ(対象の境界箱の対角長から決める、§0.a-0.12)
 *
 * P3(タスク15b)でばね(FR-414、§2.7b)を足した。ばねは面でなく軸(RevolveAxis)を持つので、
 * 穴と違い掘る向きの計算(`resolveTiltedDirection`)まで model 側で完結する
 * (カーネルへは傾きを適用した後の向きベクトルをそのまま渡す)。全長・ピッチ・巻数のうち
 * `derived` が指す欄は保存値を無視して他の2つから計算し直す(`resolveSpringLength`、§0.a-0.30)。
 */

import type { ExpressionValue } from '@pointercad/expression';

import type { AxisFrame } from '../geometry/planeSpec.js';
import {
  degreesToRadians,
  tiltedDirection,
  WORLD_AXIS_DIRECTIONS,
  type WorkPlane,
  type WorkPlaneId,
} from '../sketch/planeMath.js';
import {
  arcPointAt,
  ellipsePointAt,
  fitPlaneNormal,
  resolveSketch,
} from '../sketch/resolveSketch.js';
import type { ResolvedCurve, ResolvedFace, ResolvedSketch } from '../sketch/types.js';
import {
  addVec3,
  lengthVec3,
  normalizeVec3,
  ORIGIN,
  scaleVec3,
  subVec3,
  type Vec3,
} from '../sketch/vec3.js';
import { findMetricThread } from '../thread/metricThread.js';
import {
  cacheKeyFor,
  type KeyCurve,
  type KeyTransform,
  type KeyVec3,
  type SolidStepKeyMaterial,
} from './cacheKey.js';
import { consumedTargetsOf, isPatternSource, MAX_PATTERN_COUNT, MAX_SPRING_TURNS } from './createPartDocument.js';
import {
  createReferenceResolver,
  type ReferenceError,
  type ReferenceErrorCode,
  type ResolvedReferences,
} from './resolveReferences.js';
import { dedupeSubShapeRefs, fingerprintKeyText, subShapeKindOf } from './subShapeRef.js';
import type {
  BooleanFeature,
  BooleanOperation,
  ChamferFeature,
  ChamferSize,
  ExtrudeFeature,
  FilletFeature,
  HoleDepth,
  HoleFeature,
  PartDocument,
  PatternFeature,
  PatternPlacement,
  RevolveAxis,
  RevolveFeature,
  SewFeature,
  SketchFaceRef,
  SketchPointRef,
  SolidFeature,
  SpringDerived,
  SpringFeature,
  SubShapeRef,
  ThreadHoleFeature,
} from './types.js';

/**
 * 工具全体にかける剛体変換(パターン、FR-411 / FR-412、§0.a-0.20)。
 * kernel の `RigidTransformSpec` と同じ形だが別の型にして、kernelBridge が詰め替える
 * (NFR-MA-1)。回転角はラジアン(度からの換算は model の責務)。
 *
 * P3 タスク15 の穴・ねじ穴では**必ず空配列**を渡す。並べるのはパターン(タスク16)だけで、
 * 「空」と「恒等変換を1つ」は鍵の文字列が違う(cacheKey.ts の `HoleKeyMaterial` の注釈)ため、
 * パターンでない穴は必ず空に揃える。
 */
export interface RigidTransform {
  readonly translation: Vec3;
  readonly rotationOrigin: Vec3;
  readonly rotationAxis: Vec3;
  /** 回転角(ラジアン)。0 なら平行移動だけ。 */
  readonly rotationAngle: number;
}

/**
 * 段が指す部分形状(面・辺・頂点)の指紋。
 *
 * 計画書 §タスク15 は `SubShapeFingerprint & { index: number }`(kernel の `SubShapeQuery` と
 * 同じ平らな形)としていたが、**保存形の `SubShapeRef` をそのまま持ち回る**形にした。理由は2つ:
 *   - 鍵の材料に混ぜる文字列は `subShapeRef.ts` の `fingerprintKeyText(ref)` が作り、
 *     これが `bodyFeatureId` を必要とする。平らに崩すと鍵を作れない。
 *   - 崩して詰め直すには指紋の種類ごとの分岐を2か所(ここと kernelBridge)に書くことになる。
 * 平らな `SubShapeQuery` へ崩すのは kernelBridge(タスク17)の1か所だけにする。
 */
export type SubShapeQueryPlan = SubShapeRef;

/**
 * model 側の「1段の作り方」。kernel の SolidStepSpec とは別の型にして、
 * kernelBridge(タスク12)が詰め替える(NFR-MA-1。model は kernel の型を再輸出しない)。
 * 向き・反転・両側の平行移動はここまでで済ませてあり、kernel へは断面・向き・長さだけが渡る。
 */
export type SolidStepPlan =
  | {
      readonly kind: 'extrude';
      /** 断面の閉ループ。両側(symmetric)のときは平行移動した後の座標。 */
      readonly profile: readonly ResolvedCurve[];
      /** 押し出す向き(単位ベクトル)。反転(reversed)を適用した後の向き。 */
      readonly direction: Vec3;
      /** 押し出す長さ(mm)。正の数。両側でも半分にしない(断面をずらして表す)。 */
      readonly distance: number;
    }
  | {
      readonly kind: 'revolve';
      readonly profile: readonly ResolvedCurve[];
      readonly axisOrigin: Vec3;
      /** 軸の向き(単位ベクトル)。反転(reversed)を適用した後の向き。 */
      readonly axisDirection: Vec3;
      /** 回転角(ラジアン)。0 より大きく 2π 以下。 */
      readonly angle: number;
    }
  | {
      readonly kind: 'sew';
      /** 殻を作る面。1枚ずつ閉ループで並べる。 */
      readonly profiles: readonly (readonly ResolvedCurve[])[];
      /** つなぎ目とみなす許容量(mm)。正の数。 */
      readonly tolerance: number;
    }
  | {
      readonly kind: 'boolean';
      readonly operation: BooleanOperation;
      /** 対象(残る側)のボディの鍵。上流の鍵をそのまま持つので鍵が連鎖する。 */
      readonly targetKey: string;
      /** 相手(消える側)のボディの鍵。 */
      readonly toolKey: string;
    }
  | {
      readonly kind: 'hole';
      /** 穴をあける対象のボディの鍵。この段が消費する(§0.a-0.5)。 */
      readonly targetKey: string;
      /** 穴をあける面。カーネルが指紋で選び直し、平面と法線を取り出す(§2.2)。 */
      readonly face: SubShapeQueryPlan;
      /** 面へ投影する前の中心点(mm)。投影はカーネルが行う。利用者が選んだ順のまま並べる。 */
      readonly centers: readonly Vec3[];
      readonly diameter: number;
      /** 貫通なら null(長さはカーネルが境界箱から決める、§0.a-0.12)。止まり穴なら深さ(mm)。 */
      readonly depth: number | null;
      /** 面の法線からの傾き(ラジアン)。0 以上 π/2 未満。 */
      readonly tiltAngle: number;
      /** 傾ける向き(面内の方位角、ラジアン)。基準は面の第1軸(§0.a-0.10)。 */
      readonly tiltAzimuth: number;
      readonly transforms: readonly RigidTransform[];
    }
  | {
      readonly kind: 'thread';
      readonly targetKey: string;
      readonly face: SubShapeQueryPlan;
      readonly centers: readonly Vec3[];
      /** 下穴の径(mm)。既定はめねじ内径 D1(§0.a-0.14)。 */
      readonly drillDiameter: number;
      /**
       * ピッチ(mm)。簡略表示では `thread` が null になり形には効かないが、
       * 鍵の材料(`ThreadKeyMaterial.pitch`)は常にこの値を混ぜるので段の欄として持つ。
       */
      readonly pitch: number;
      readonly depth: number | null;
      readonly tiltAngle: number;
      readonly tiltAzimuth: number;
      readonly transforms: readonly RigidTransform[];
      /** 実らせんを切るときだけ入る。簡略表示のときは null(§0.a-0.15、§0.a-0.16)。 */
      readonly thread: {
        readonly majorDiameter: number;
        readonly pitch: number;
        readonly length: number;
      } | null;
      /**
       * 3D の簡略表示に使うねじの印(B-rep には触らない)。
       * kernel 側は `ThreadMarkSpec | null` だが、**model は簡略表示でも実らせんでも必ず作る**
       * ので null を取らない(印は実形状のときも出す、§2.4.2)。
       */
      readonly mark: { readonly majorDiameter: number; readonly length: number };
    }
  | {
      readonly kind: 'spring';
      /** らせんの軸の始点(mm)。 */
      readonly origin: Vec3;
      /** 軸の向き(単位ベクトル)。傾きを適用した後(§0.a-0.29)。 */
      readonly direction: Vec3;
      /** コイルの中心径(mm)。 */
      readonly coilDiameter: number;
      /** 線径(mm)。 */
      readonly wireDiameter: number;
      /** 1巻きあたりの軸方向の進み(mm)。derived を解決した後の値。 */
      readonly pitch: number;
      /** 巻数。derived を解決した後の値。0 より大きく MAX_SPRING_TURNS 以下。 */
      readonly turns: number;
      readonly handedness: 'right' | 'left';
    }
  | {
      readonly kind: 'fillet';
      /** 丸める対象のボディの鍵。この段が消費する(§0.a-0.5)。 */
      readonly targetKey: string;
      /** 丸める辺・頂点の指紋。通し番号の昇順に並べる(鍵を安定させるため、タスク16)。 */
      readonly targets: readonly SubShapeQueryPlan[];
      /** 丸める半径(mm)。0 より大きい。 */
      readonly radius: number;
    }
  | {
      readonly kind: 'chamfer';
      /** 面を取る対象のボディの鍵。この段が消費する(§0.a-0.5)。 */
      readonly targetKey: string;
      /** 面を取る辺の指紋。通し番号の昇順に並べる(fillet と同じ理由)。 */
      readonly targets: readonly SubShapeQueryPlan[];
      readonly size:
        | { readonly kind: 'equal'; readonly distance: number }
        | { readonly kind: 'twoDistances'; readonly distance1: number; readonly distance2: number }
        | { readonly kind: 'distanceAngle'; readonly distance: number; readonly angle: number };
      /** 2距離・距離角度のときの基準面を、辺に接する2面のうち後の方にするか(§0.a-0.18)。 */
      readonly swapReferenceFace: boolean;
    };

/** カーネルへ渡す1段。順序が意味を持つ(要件§2「履歴パラメトリック」)。 */
export interface ResolvedSolidStep {
  /** この段を作ったフィーチャーの id。作られるボディの id でもある(§0.a-0.5)。 */
  readonly featureId: string;
  /** 進捗表示とツリーに出す名前(FR-501、NFR-PF-4)。鍵には混ぜない。 */
  readonly name: string;
  /** 形状キャッシュの鍵(§0.a-0.20)。同じ鍵なら作り直さない(NFR-PF-3)。 */
  readonly key: string;
  readonly plan: SolidStepPlan;
  /** 画面に出すか。ブーリアンに消費されたボディは false(§0.a-0.5)。 */
  readonly visible: boolean;
}

/** 解決できなかった理由の区別(FR-504)。利用者へは message をそのまま見せる。 */
export type PartErrorCode =
  /** 断面の面・回転軸の線分が見つからない(消された、またはスケッチ側で解決できなかった)。 */
  | 'missingProfile'
  /** ブーリアンの対象・相手のボディが無い(未作成・抑制中・上流が失敗)。 */
  | 'missingBody'
  /** 距離・角度・許容量が数でない、または範囲の外。対象と相手が同じ場合も含む。 */
  | 'invalidValue'
  /** 面の枚数が足りないなど、形として成り立たない。 */
  | 'degenerate'
  /** 断面から平面の向きが定まらない。 */
  | 'notPlanar'
  /** そのボディはすでに別のブーリアンが消費している。 */
  | 'consumedTwice'
  /**
   * 加工するもとの面・辺・頂点が見つからない(§0.a-0.5、FR-504)。
   * 指紋の照合はカーネルの中で行う(§2.2.4)ので、**この code を出すのは
   * 「面・辺を1つも指していない」場合(タスク16 の面取り)と、カーネルの失敗を詰め替える
   * kernelBridge / recomputePart(タスク17)**である。文言は
   * 「加工するもとの面(辺)が見つかりません。形が大きく変わったため、選び直してください。」
   */
  | 'missingSubShape'
  /**
   * 基準ジオメトリ(FR-328、FR-329)の指定が循環している(P4 タスク9)。
   * 作業平面 A がスケッチ S の点を使い、S が作業平面 A の上に描かれている、のような場合。
   */
  | 'circularReference'
  /** カーネルが形を作れなかった(このファイルでは使わない。タスク12 が使う)。 */
  | 'kernelFailed';

/** 解決できなかった理由。止めずに持ち回る(FR-504、NFR-RE-1)。 */
export interface PartError {
  readonly featureId: string;
  readonly code: PartErrorCode;
  readonly message: string;
}

/** スケッチ1本ぶんの解決結果。タスク12 がこれへメッシュを足す。 */
export interface ResolvedPartSketch {
  readonly sketchId: string;
  readonly resolved: ResolvedSketch;
}

export interface ResolvedPart {
  /**
   * スケッチ id ごとの解決結果(P1 の resolveSketch をそのまま呼ぶ)。文書の順を保つ。
   * スケッチ側の失敗は resolved.errors に入っており、下の errors へは写さない
   * (同じ失敗を2箇所に持つと、消したときの取りこぼしが起きるため)。
   */
  readonly sketches: readonly ResolvedPartSketch[];
  /**
   * 基準ジオメトリ(任意の作業平面・基準軸・基準点・座標系。FR-328、FR-329)の解決結果。
   * 失敗は `references.errors` と下の `errors` の両方ではなく、**`errors` へ写して 1 か所に
   * まとめる**(スケッチの失敗を写さないのと逆にしているのは、基準ジオメトリがツリーの
   * 独立した行になり、失敗をツリーの行へ出す必要があるため)。
   */
  readonly references: ResolvedReferences;
  /** カーネルへ渡す段の一覧。順序が意味を持つ。失敗した段と抑制された段は入らない。 */
  readonly steps: readonly ResolvedSolidStep[];
  /** ソリッドの解決の失敗(FR-504)。抑制は失敗ではないので入れない。 */
  readonly errors: readonly PartError[];
  /**
   * いま画面に出るボディの id(§0.a-0.5)。steps のうち visible なものを履歴順に並べたもの。
   * createPartDocument.ts の liveBodyIds は文書だけを見る近似で、こちらは
   * 「作成に成功したか」まで見た確定版(FR-502 の表示・選択はこちらを使う)。
   */
  readonly liveBodyIds: readonly string[];
}

/** 回転軸(FR-402)。原点と単位ベクトルの組。 */
export interface RevolveAxisFrame {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

/** 平面の当てはめに使う円弧の標本点の数(両端を含む)。resolveSketch の平面判定と揃える。 */
const ARC_PLANE_SAMPLES = 5;

/** 角度の上限(度)。全周を超える回転は受け付けない(§0.a-0.9)。 */
const MAX_REVOLVE_DEGREES = 360;

/**
 * 傾き角の上限(度、含まない)。90 度では掘る向きが面と平行になり材料へ入らない。
 * カーネル(タスク6 の `makeHole`)も許容を [0, π/2) にしてあるので、同じ境界で先に断る
 * (§2.9 の第1段「入力の妥当性は model と kernel の両方で見る」)。
 */
const MAX_TILT_DEGREES = 90;

/**
 * C 面取りの距離+角度の上限(度、含まない)。0 度・90 度では基準面と平行になり
 * 面取りにならない(§2.6.2 の断り方の一覧と同じ境界)。
 */
const MAX_CHAMFER_ANGLE_DEGREES = 90;

/**
 * 向きを逆にする。0 を掛けると -0 になる double の癖を吸収して +0 に揃える。
 * -0 は Object.is で +0 と区別されるため、揃えておかないと下流の比較
 * (表示の差分判定やテストの toEqual)が値の中身と関係なく食い違う。
 * 鍵は keyNumber が -0 を 0 として扱うので、鍵の値には影響しない。
 */
function negateVec3(vector: Vec3): Vec3 {
  return [
    vector[0] === 0 ? 0 : -vector[0],
    vector[1] === 0 ? 0 : -vector[1],
    vector[2] === 0 ? 0 : -vector[2],
  ];
}

/**
 * 平面の当てはめに使う標本点。円弧は中心と弧の上の数点まで見る。
 * 端点だけを見ると、端点だけが一致する別々の平面の円弧を同じ平面と誤判定する
 * (resolveSketch.ts の curveSamplePoints と同じ理由。あちらは非公開なのでここに置く)。
 */
function curveSamplePoints(curve: ResolvedCurve): readonly Vec3[] {
  switch (curve.kind) {
    case 'segment':
      return [curve.from, curve.to];
    case 'arc': {
      const span = curve.endAngle - curve.startAngle;
      const samples: Vec3[] = [curve.center];
      for (let index = 0; index < ARC_PLANE_SAMPLES; index += 1) {
        samples.push(
          arcPointAt(curve, curve.startAngle + (span * index) / (ARC_PLANE_SAMPLES - 1)),
        );
      }
      return samples;
    }
    case 'ellipse': {
      const span = curve.endAngle - curve.startAngle;
      const samples: Vec3[] = [curve.center];
      for (let index = 0; index < ARC_PLANE_SAMPLES; index += 1) {
        samples.push(
          ellipsePointAt(curve, curve.startAngle + (span * index) / (ARC_PLANE_SAMPLES - 1)),
        );
      }
      return samples;
    }
    case 'spline':
      // 極は点のアフィン結合なので、点が乗る平面に曲線も必ず乗る(resolveSketch と同じ理由)。
      return curve.points;
  }
}

/** 曲線をベクトルぶん平行移動する(押し出しの「両側へ」に使う、§0.a-0.8)。 */
export function translateCurve(curve: ResolvedCurve, offset: Vec3): ResolvedCurve {
  switch (curve.kind) {
    case 'segment':
      return { ...curve, from: addVec3(curve.from, offset), to: addVec3(curve.to, offset) };
    case 'arc':
      // 円弧は中心だけを動かす。法線・第1軸・半径・角度は平行移動で変わらない。
      return { ...curve, center: addVec3(curve.center, offset) };
    case 'ellipse':
      // 楕円も同じく中心だけ。長軸の向き・2 つの半径・角度は平行移動で変わらない。
      return { ...curve, center: addVec3(curve.center, offset) };
    case 'spline':
      // スプラインは形が点の並びで決まるので、点を全部動かす。
      return { ...curve, points: curve.points.map((point) => addVec3(point, offset)) };
  }
}

/**
 * 回転軸を解決する。world 軸は原点+単位ベクトル、スケッチの線分は始点+向き(§0.a-0.9)。
 *
 * P4(FR-329、タスク9)で基準軸フィーチャーへの参照 `reference` が増えた。基準軸は
 * 部品文書の履歴を見ないと解けないので、**解決済みの表を第 3 引数で受け取る**
 * (渡されなければ基準軸は解けず null。既存の呼び出しはそのまま動く)。
 */
export function resolveRevolveAxis(
  axis: RevolveAxis,
  sketches: readonly ResolvedPartSketch[],
  referenceAxes: ReadonlyMap<string, AxisFrame> = new Map<string, AxisFrame>(),
): RevolveAxisFrame | null {
  if (axis.kind === 'world') {
    return { origin: ORIGIN, direction: WORLD_AXIS_DIRECTIONS[axis.axis] };
  }
  if (axis.kind === 'reference') {
    return referenceAxes.get(axis.referenceFeatureId) ?? null;
  }
  const sketch = sketches.find((entry) => entry.sketchId === axis.line.sketchId);
  if (sketch === undefined) {
    return null;
  }
  const segment = sketch.resolved.segments.find(
    (candidate) => candidate.featureId === axis.line.lineFeatureId,
  );
  if (segment === undefined) {
    return null;
  }
  const direction = subVec3(segment.to, segment.from);
  const length = lengthVec3(direction);
  // 長さ 0 の線分は resolveSketch が degenerate で弾くので、ここへは来ない(念のための守り)。
  if (!Number.isFinite(length) || length === 0) {
    return null;
  }
  return { origin: segment.from, direction: normalizeVec3(direction) };
}

function findResolvedFace(
  sketches: readonly ResolvedPartSketch[],
  reference: SketchFaceRef,
): ResolvedFace | undefined {
  const sketch = sketches.find((entry) => entry.sketchId === reference.sketchId);
  return sketch?.resolved.faces.find((face) => face.featureId === reference.faceFeatureId);
}

type PlanOutcome =
  | { readonly ok: true; readonly plan: SolidStepPlan }
  | { readonly ok: false; readonly error: PartError };

function partError(featureId: string, code: PartErrorCode, message: string): PartError {
  return { featureId, code, message };
}

function fail(featureId: string, code: PartErrorCode, message: string): PlanOutcome {
  return { ok: false, error: partError(featureId, code, message) };
}

/** 0 より大きい有限の数か。式が評価できなかった欄は value が NaN で来る(FR-504)。 */
function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** 押し出し(FR-401、§0.a-0.8)。向き・反転・両側の平行移動をここで決める。 */
function planExtrude(feature: ExtrudeFeature, sketches: readonly ResolvedPartSketch[]): PlanOutcome {
  const face = findResolvedFace(sketches, feature.profile);
  if (face === undefined) {
    return fail(
      feature.id,
      'missingProfile',
      '押し出すもとの面が見つかりません。スケッチで面を張ってからやり直してください。',
    );
  }
  const distance = feature.distance.value;
  if (!Number.isFinite(distance) || distance <= 0) {
    return fail(feature.id, 'invalidValue', '押し出す長さは 0 より大きい数にしてください。');
  }
  const normal = fitPlaneNormal(face.curves.flatMap((curve) => curveSamplePoints(curve)));
  // resolveSketch が平面に乗らない面を断るので通常は起きない。断っても止めない(FR-504)。
  if (normal === null) {
    return fail(
      feature.id,
      'notPlanar',
      '押し出す向きが決まりません。面の形が平らになっているか確かめてください。',
    );
  }
  const direction = feature.reversed ? negateVec3(normal) : normal;
  if (!feature.symmetric) {
    return { ok: true, plan: { kind: 'extrude', profile: face.curves, direction, distance } };
  }
  // 「両側へ」は、断面を逆向きへ距離の半分だけ動かしてから距離ぶん押し出す(§0.a-0.8)。
  // 平行移動を model 側で行うので、カーネルへは断面・向き・長さだけを渡せる。
  const offset = scaleVec3(negateVec3(direction), distance / 2);
  const profile = face.curves.map((curve) => translateCurve(curve, offset));
  return { ok: true, plan: { kind: 'extrude', profile, direction, distance } };
}

/** 回転(FR-402、§0.a-0.9)。角度は度で持ち、ここでラジアンへ直す。 */
function planRevolve(
  feature: RevolveFeature,
  sketches: readonly ResolvedPartSketch[],
  axisFrames: ReadonlyMap<string, AxisFrame>,
): PlanOutcome {
  const face = findResolvedFace(sketches, feature.profile);
  if (face === undefined) {
    return fail(
      feature.id,
      'missingProfile',
      '回転させるもとの面が見つかりません。スケッチで面を張ってからやり直してください。',
    );
  }
  const degrees = feature.angle.value;
  if (!Number.isFinite(degrees) || degrees <= 0 || degrees > MAX_REVOLVE_DEGREES) {
    return fail(feature.id, 'invalidValue', '回転の角度は 0 より大きく 360 以下にしてください。');
  }
  const frame = resolveRevolveAxis(feature.axis, sketches, axisFrames);
  if (frame === null) {
    return fail(
      feature.id,
      'missingProfile',
      '回転の軸にする線分が見つかりません。スケッチで線分をかいてから選び直してください。',
    );
  }
  return {
    ok: true,
    plan: {
      kind: 'revolve',
      profile: face.curves,
      axisOrigin: frame.origin,
      axisDirection: feature.reversed ? negateVec3(frame.direction) : frame.direction,
      angle: degreesToRadians(degrees),
    },
  };
}

/** 縫合(FR-403、§0.a-0.7)。面を2枚以上並べ、許容量とともに渡す。 */
function planSew(feature: SewFeature, sketches: readonly ResolvedPartSketch[]): PlanOutcome {
  if (feature.faces.length < 2) {
    return fail(feature.id, 'degenerate', '立体にするには面が 2 枚以上必要です。');
  }
  const profiles: (readonly ResolvedCurve[])[] = [];
  for (const reference of feature.faces) {
    const face = findResolvedFace(sketches, reference);
    if (face === undefined) {
      return fail(
        feature.id,
        'missingProfile',
        '縫い合わせるもとの面が見つかりません。スケッチで面を張ってからやり直してください。',
      );
    }
    profiles.push(face.curves);
  }
  const tolerance = feature.tolerance.value;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    return fail(feature.id, 'invalidValue', 'つなぎ目の許容量は 0 より大きい数にしてください。');
  }
  return { ok: true, plan: { kind: 'sew', profiles, tolerance } };
}

/**
 * ブーリアン(FR-404、§0.a-0.5)。対象と相手のボディを消費して1つのボディを作る。
 * 参照できるのは「履歴で自分より前にあり、抑制されておらず、作成に成功し、
 * まだ消費されていない」ボディだけ。消費そのものは呼び出し側(resolvePart)が記録する。
 */
function planBoolean(
  feature: BooleanFeature,
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): PlanOutcome {
  if (feature.targetFeatureId === feature.toolFeatureId) {
    return fail(
      feature.id,
      'invalidValue',
      '同じ立体どうしは組み合わせられません。別の立体を選んでください。',
    );
  }
  const targetKey = bodyKeys.get(feature.targetFeatureId);
  if (targetKey === undefined) {
    return fail(feature.id, 'missingBody', '組み合わせるもとの立体が見つかりません。');
  }
  if (consumed.has(feature.targetFeatureId)) {
    return fail(feature.id, 'consumedTwice', 'その立体はすでに別のところで使われています。');
  }
  const toolKey = bodyKeys.get(feature.toolFeatureId);
  if (toolKey === undefined) {
    return fail(feature.id, 'missingBody', '組み合わせるもとの立体が見つかりません。');
  }
  if (consumed.has(feature.toolFeatureId)) {
    return fail(feature.id, 'consumedTwice', 'その立体はすでに別のところで使われています。');
  }
  return {
    ok: true,
    plan: { kind: 'boolean', operation: feature.operation, targetKey, toolKey },
  };
}

/** 加工の対象になるボディを引いた結果(FR-405〜FR-408、FR-411、FR-412)。 */
export type MachiningTargetOutcome =
  | { readonly ok: true; readonly targetKey: string }
  | { readonly ok: false; readonly error: PartError };

/**
 * 加工(穴・ねじ穴・R 面取り・C 面取り・パターン)の対象になるボディの鍵を引く(§0.a-0.5)。
 *
 * 参照できるのはブーリアンと同じく「履歴で自分より前にあり、抑制されておらず、作成に成功し、
 * まだ消費されていない」ボディだけ。消費そのものの記録は呼び出し側(resolvePart)が
 * `consumedTargetsOf` を使って行う(規則を2か所に書かない)。
 * 自分自身を指す場合は、まだ `bodyKeys` へ自分の鍵を入れていない時点で呼ばれるので
 * `missingBody` になる(前方参照と同じ扱い)。
 */
export function resolveMachiningTarget(
  featureId: string,
  targetFeatureId: string,
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): MachiningTargetOutcome {
  const targetKey = bodyKeys.get(targetFeatureId);
  if (targetKey === undefined) {
    return {
      ok: false,
      error: partError(featureId, 'missingBody', '加工するもとの立体が見つかりません。'),
    };
  }
  if (consumed.has(targetFeatureId)) {
    return {
      ok: false,
      error: partError(featureId, 'consumedTwice', 'その立体はすでに別のところで使われています。'),
    };
  }
  return { ok: true, targetKey };
}

/** 穴の中心点を展開した結果(FR-405、FR-308)。 */
export type HoleCentersOutcome =
  | { readonly ok: true; readonly centers: readonly Vec3[] }
  | { readonly ok: false; readonly error: PartError };

/**
 * スケッチの点・点列フィーチャーから穴の中心点を展開する(FR-405 の「複数点同時」、FR-308)。
 *
 * `resolveSketch` の `points` は点フィーチャーと点列フィーチャーの全点を平らに並べた配列で、
 * 各要素が作り手の `featureId` を持つ(P1 の実装。着手時に実測して確認した)。
 * 参照は要素 id(`point-1#3`)ではなく**フィーチャー id** を持つので、**点列を指すと必ず全点**が
 * 中心になる(点列の1点だけを指す書き方は持たない、types.ts の `SketchPointRef` の注釈)。
 * 並びは利用者が選んだ参照の順、点列の中では作られた順のままにする(並びは鍵に効く。
 * cacheKey.ts の `HoleKeyMaterial.centers` の注釈)。
 *
 * 参照の一部が見つからなくても、1点でも取れれば残りで続ける(消えた点のぶんだけ穴が減る)。
 * 1点も取れないときだけ断る(計画書 タスク15 の解決の規則3)。
 *
 * 計画書の署名には `featureId` が無いが、失敗を `PartError`(featureId を必ず持つ)で返すため
 * `resolveMachiningTarget` と同じく第1引数で受け取る形にした。
 */
export function resolveHoleCenters(
  featureId: string,
  references: readonly SketchPointRef[],
  sketches: readonly ResolvedPartSketch[],
): HoleCentersOutcome {
  const centers: Vec3[] = [];
  for (const reference of references) {
    const sketch = sketches.find((entry) => entry.sketchId === reference.sketchId);
    if (sketch === undefined) {
      continue;
    }
    for (const point of sketch.resolved.points) {
      if (point.featureId === reference.pointFeatureId) {
        centers.push(point.position);
      }
    }
  }
  if (centers.length === 0) {
    return {
      ok: false,
      error: partError(
        featureId,
        'missingProfile',
        '穴の中心にする点が見つかりません。スケッチで点を作ってからやり直してください。',
      ),
    };
  }
  return { ok: true, centers };
}

type DepthOutcome =
  | { readonly ok: true; readonly depth: number | null }
  | { readonly ok: false; readonly error: PartError };

/** 深さ(FR-405)。貫通は null(長さはカーネルが境界箱から決める、§0.a-0.12)。 */
function resolveHoleDepth(featureId: string, depth: HoleDepth): DepthOutcome {
  if (depth.kind === 'through') {
    return { ok: true, depth: null };
  }
  if (!isPositiveFinite(depth.depth.value)) {
    return {
      ok: false,
      error: partError(featureId, 'invalidValue', '穴の深さは 0 より大きい数にしてください。'),
    };
  }
  return { ok: true, depth: depth.depth.value };
}

/** 傾き角・方位角(ラジアン)。 */
interface TiltPlan {
  readonly tiltAngle: number;
  readonly tiltAzimuth: number;
}

type TiltOutcome =
  | { readonly ok: true; readonly tilt: TiltPlan }
  | { readonly ok: false; readonly error: PartError };

/**
 * 傾き角と方位角を度からラジアンへ直す(§0.a-0.10)。
 *
 * 傾き角は 0 以上 90 度未満(90 度では掘る向きが面と平行になり材料へ入らない)。
 * 方位角は面内の向きなので範囲を決めない(360 度を超えても、負でも、同じ向きを指すだけ)。
 */
function resolveTilt(
  featureId: string,
  tiltAngle: ExpressionValue,
  tiltAzimuth: ExpressionValue,
): TiltOutcome {
  const angleDegrees = tiltAngle.value;
  if (!Number.isFinite(angleDegrees) || angleDegrees < 0 || angleDegrees >= MAX_TILT_DEGREES) {
    return {
      ok: false,
      error: partError(featureId, 'invalidValue', '傾きの角度は 0 以上 90 度未満にしてください。'),
    };
  }
  const azimuthDegrees = tiltAzimuth.value;
  if (!Number.isFinite(azimuthDegrees)) {
    return {
      ok: false,
      error: partError(featureId, 'invalidValue', '傾ける向きの角度が数になっていません。'),
    };
  }
  return {
    ok: true,
    tilt: {
      tiltAngle: degreesToRadians(angleDegrees),
      tiltAzimuth: degreesToRadians(azimuthDegrees),
    },
  };
}

/** 穴とねじ穴に共通する欄。どちらも対象・面・中心・深さ・傾きを同じ意味で持つ。 */
type HoleLikeFeature = HoleFeature | ThreadHoleFeature;

/** 穴とねじ穴に共通する解決結果。 */
interface HoleBase {
  readonly targetKey: string;
  readonly face: SubShapeQueryPlan;
  readonly centers: readonly Vec3[];
  readonly depth: number | null;
  readonly tiltAngle: number;
  readonly tiltAzimuth: number;
}

type HoleBaseOutcome =
  | { readonly ok: true; readonly base: HoleBase }
  | { readonly ok: false; readonly error: PartError };

/**
 * 穴とねじ穴に共通する解決(対象・面・中心・深さ・傾き)。
 * 断る順は計画書 タスク15 の「解決の規則」のとおり(対象 → 面 → 中心 → 深さ → 傾き)。
 */
function resolveHoleBase(
  feature: HoleLikeFeature,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): HoleBaseOutcome {
  const target = resolveMachiningTarget(
    feature.id,
    feature.targetFeatureId,
    bodyKeys,
    consumed,
  );
  if (!target.ok) {
    return target;
  }
  // 面は「加工するもとの立体」のものでなければならない。別のボディの面を指していると
  // カーネルは対象の形の中から選び直すので、まったく違う面が当たってしまう。
  if (feature.face.bodyFeatureId !== feature.targetFeatureId) {
    return {
      ok: false,
      error: partError(
        feature.id,
        'invalidValue',
        '穴をあける面は、加工するもとの立体の面にしてください。',
      ),
    };
  }
  // 参照の型(SubShapeRef)は辺・頂点も表せるので、面であることをここで確かめる
  // (P3 の穴は平らな面にだけあけられる。面かどうかの判定は指紋の種類で足りる)。
  if (subShapeKindOf(feature.face) !== 'face') {
    return {
      ok: false,
      error: partError(
        feature.id,
        'invalidValue',
        '穴をあけられるのは面だけです。面を選び直してください。',
      ),
    };
  }
  const centers = resolveHoleCenters(feature.id, feature.centers, sketches);
  if (!centers.ok) {
    return centers;
  }
  const depth = resolveHoleDepth(feature.id, feature.depth);
  if (!depth.ok) {
    return depth;
  }
  const tilt = resolveTilt(feature.id, feature.tiltAngle, feature.tiltAzimuth);
  if (!tilt.ok) {
    return tilt;
  }
  return {
    ok: true,
    base: {
      targetKey: target.targetKey,
      face: feature.face,
      centers: centers.centers,
      depth: depth.depth,
      tiltAngle: tilt.tilt.tiltAngle,
      tiltAzimuth: tilt.tilt.tiltAzimuth,
    },
  };
}

/**
 * 穴(FR-405、§2.4)。対象のボディを消費して1つの新しいボディを作る。
 *
 * 中心点の面への投影・掘る向き・貫通穴の長さはカーネルが決める(model は面の指紋しか
 * 持たないため、§2.4.2)。ここで作るのは「どの面に、どの点を中心に、どの太さで、
 * どこまで掘るか」までである。`transforms` は必ず空配列(並べるのはパターン、タスク16)。
 */
function planHole(
  feature: HoleFeature,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): PlanOutcome {
  const outcome = resolveHoleBase(feature, sketches, bodyKeys, consumed);
  if (!outcome.ok) {
    return outcome;
  }
  const base = outcome.base;
  const diameter = feature.diameter.value;
  if (!isPositiveFinite(diameter)) {
    return fail(feature.id, 'invalidValue', '穴の直径は 0 より大きい数にしてください。');
  }
  return {
    ok: true,
    plan: {
      kind: 'hole',
      targetKey: base.targetKey,
      face: base.face,
      centers: base.centers,
      diameter,
      depth: base.depth,
      tiltAngle: base.tiltAngle,
      tiltAzimuth: base.tiltAzimuth,
      transforms: [],
    },
  };
}

/**
 * ねじ穴(FR-406、§2.4)。下穴は穴と同じ手順で掘り、ねじ山だけが追加になる。
 *
 * 呼び(`designation`)から規格表(thread/metricThread.ts)を引いておねじの外径 `d` を得る。
 * ピッチ・下穴径は規格表から入るが式で書き換えられる(FR-202)ので、**文書の値を正**とし、
 * 表からは外径だけを取る。`series`(並目/細目)は既定のピッチを決めるための欄で、
 * ピッチが文書に入っている以上ここでは使わない(UI が既定値を入れるときに使う)。
 */
function planThreadHole(
  feature: ThreadHoleFeature,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): PlanOutcome {
  const outcome = resolveHoleBase(feature, sketches, bodyKeys, consumed);
  if (!outcome.ok) {
    return outcome;
  }
  const base = outcome.base;
  const size = findMetricThread(feature.designation);
  if (size === undefined) {
    return fail(
      feature.id,
      'invalidValue',
      'そのねじの呼びは使えません。一覧から選び直してください。',
    );
  }
  const pitch = feature.pitch.value;
  if (!isPositiveFinite(pitch)) {
    return fail(feature.id, 'invalidValue', 'ねじのピッチは 0 より大きい数にしてください。');
  }
  const drillDiameter = feature.drillDiameter.value;
  if (!isPositiveFinite(drillDiameter)) {
    return fail(feature.id, 'invalidValue', '下穴の径は 0 より大きい数にしてください。');
  }
  if (drillDiameter >= size.diameter) {
    return fail(feature.id, 'invalidValue', '下穴の径はねじの外径より小さくしてください。');
  }
  const threadLength = feature.threadLength.value;
  if (!isPositiveFinite(threadLength)) {
    return fail(feature.id, 'invalidValue', 'ねじ部の長さは 0 より大きい数にしてください。');
  }
  // 止まり穴のときだけ深さと比べる。貫通穴は深さが無いので比べる相手がない。
  if (base.depth !== null && threadLength > base.depth) {
    return fail(feature.id, 'invalidValue', 'ねじ部の長さは、穴の深さ以下にしてください。');
  }
  const modeled = feature.representation === 'modeled';
  return {
    ok: true,
    plan: {
      kind: 'thread',
      targetKey: base.targetKey,
      face: base.face,
      centers: base.centers,
      drillDiameter,
      pitch,
      depth: base.depth,
      tiltAngle: base.tiltAngle,
      tiltAzimuth: base.tiltAzimuth,
      transforms: [],
      // 実らせんを切るのは representation が 'modeled' のときだけ(既定は簡略表示)。
      thread: modeled ? { majorDiameter: size.diameter, pitch, length: threadLength } : null,
      // 印は簡略表示でも実らせんでも作る(§2.4.2「実形状のときも返してよい」)。
      mark: { majorDiameter: size.diameter, length: threadLength },
    },
  };
}

/**
 * 丸める・面を取る辺(頂点は§0.a-0.17 追記によりコマンド確定時にすでに辺へ展開されている)の
 * 指紋を、重複を除いてから通し番号の昇順に並べ替える(タスク16、cacheKey.ts の
 * `FilletKeyMaterial` / `ChamferKeyMaterial` の注釈「並びが違えば違う鍵になる」)。
 * 同じ辺を2回選んでいても1回だけ渡す(§2.6.2 手順3)。
 */
function sortedUniqueTargets(targets: readonly SubShapeRef[]): readonly SubShapeQueryPlan[] {
  return [...dedupeSubShapeRefs(targets)].sort((a, b) => a.index - b.index);
}

/** 面取り・パターンで「面・辺を1つも指していない」ときの断り(PartErrorCode.missingSubShape の注釈)。 */
const MISSING_SUB_SHAPE_MESSAGE =
  '加工するもとの面(辺)が見つかりません。形が大きく変わったため、選び直してください。';

/**
 * R 面取り(FR-407、§2.6)。対象のボディを消費して1つの新しいボディを作る。
 * 辺・頂点の選び直しは指紋でカーネルが行う(model は指紋を渡すだけ、§2.2)。
 */
function planFillet(
  feature: FilletFeature,
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): PlanOutcome {
  const target = resolveMachiningTarget(feature.id, feature.targetFeatureId, bodyKeys, consumed);
  if (!target.ok) {
    return target;
  }
  const targets = sortedUniqueTargets(feature.targets);
  if (targets.length === 0) {
    return fail(feature.id, 'missingSubShape', MISSING_SUB_SHAPE_MESSAGE);
  }
  const radius = feature.radius.value;
  if (!isPositiveFinite(radius)) {
    return fail(feature.id, 'invalidValue', '丸める半径は 0 より大きい数にしてください。');
  }
  return {
    ok: true,
    plan: { kind: 'fillet', targetKey: target.targetKey, targets, radius },
  };
}

/** C 面取りの大きさ(解決済み)。SolidStepPlan の chamfer 節と同じ形をここから借りる。 */
type ChamferSizePlan = Extract<SolidStepPlan, { kind: 'chamfer' }>['size'];

type ChamferSizeOutcome =
  | { readonly ok: true; readonly size: ChamferSizePlan }
  | { readonly ok: false; readonly error: PartError };

type PositiveDistanceOutcome =
  | { readonly ok: true; readonly distance: number }
  | { readonly ok: false; readonly error: PartError };

/** 面取りの距離が 0 より大きい有限の数か検査し、だめなら理由つきで断る。 */
function resolvePositiveDistance(featureId: string, distance: number): PositiveDistanceOutcome {
  if (!isPositiveFinite(distance)) {
    return {
      ok: false,
      error: partError(featureId, 'invalidValue', '面取りの距離は 0 より大きい数にしてください。'),
    };
  }
  return { ok: true, distance };
}

/**
 * C 面取りの大きさ(FR-408 の①②③)を解決する。角度は度→ラジアンへ直し、
 * 0 度より大きく 90 度より小さいことを検査する(§2.6.2 の断り方の一覧)。
 */
function resolveChamferSize(featureId: string, size: ChamferSize): ChamferSizeOutcome {
  switch (size.kind) {
    case 'equal': {
      const distance = resolvePositiveDistance(featureId, size.distance.value);
      if (!distance.ok) {
        return distance;
      }
      return { ok: true, size: { kind: 'equal', distance: distance.distance } };
    }
    case 'twoDistances': {
      const distance1 = resolvePositiveDistance(featureId, size.distance1.value);
      if (!distance1.ok) {
        return distance1;
      }
      const distance2 = resolvePositiveDistance(featureId, size.distance2.value);
      if (!distance2.ok) {
        return distance2;
      }
      return {
        ok: true,
        size: { kind: 'twoDistances', distance1: distance1.distance, distance2: distance2.distance },
      };
    }
    case 'distanceAngle': {
      const distance = resolvePositiveDistance(featureId, size.distance.value);
      if (!distance.ok) {
        return distance;
      }
      const angleDegrees = size.angle.value;
      if (
        !Number.isFinite(angleDegrees) ||
        angleDegrees <= 0 ||
        angleDegrees >= MAX_CHAMFER_ANGLE_DEGREES
      ) {
        return {
          ok: false,
          error: partError(
            featureId,
            'invalidValue',
            '面取りの角度は 0 度より大きく 90 度より小さくしてください。',
          ),
        };
      }
      return {
        ok: true,
        size: { kind: 'distanceAngle', distance: distance.distance, angle: degreesToRadians(angleDegrees) },
      };
    }
  }
}

/**
 * C 面取り(FR-408、§2.6)。対象のボディを消費して1つの新しいボディを作る。
 * 基準面(2距離・距離+角度のとき)は `swapReferenceFace` の値をそのまま渡し、
 * どちらの面が先に出るかの判定はカーネルが `TopExp` の並びで行う(§0.a-0.18)。
 */
function planChamfer(
  feature: ChamferFeature,
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): PlanOutcome {
  const target = resolveMachiningTarget(feature.id, feature.targetFeatureId, bodyKeys, consumed);
  if (!target.ok) {
    return target;
  }
  const targets = sortedUniqueTargets(feature.targets);
  if (targets.length === 0) {
    return fail(feature.id, 'missingSubShape', MISSING_SUB_SHAPE_MESSAGE);
  }
  const sizeOutcome = resolveChamferSize(feature.id, feature.size);
  if (!sizeOutcome.ok) {
    return sizeOutcome;
  }
  return {
    ok: true,
    plan: {
      kind: 'chamfer',
      targetKey: target.targetKey,
      targets,
      size: sizeOutcome.size,
      swapReferenceFace: feature.swapReferenceFace,
    },
  };
}

/**
 * 全長・ピッチ・巻数のうち derived が指すものを、他の2つから計算する(FR-414、§0.a-0.30)。
 *
 * 関係式は `length = pitch × turns`。**derived が指す欄の保存値は読まない**(引数に含めても
 * 使わない)。0 で割ることになる欄が invalidValue の理由なので、割る前に断る。
 * OCCT も文書も触らない純関数で、3通りの derived をそれぞれ単体で検査できる
 * (計画書 タスク15b の検証表)。
 */
export function resolveSpringLength(
  values: { readonly length: number; readonly pitch: number; readonly turns: number },
  derived: SpringDerived,
):
  | { readonly ok: true; readonly length: number; readonly pitch: number; readonly turns: number }
  | { readonly ok: false; readonly message: string } {
  switch (derived) {
    case 'length': {
      const { pitch, turns } = values;
      if (!isPositiveFinite(pitch)) {
        return { ok: false, message: 'ピッチは 0 より大きい数にしてください。' };
      }
      if (!isPositiveFinite(turns)) {
        return { ok: false, message: '巻数は 0 より大きく 200 以下にしてください。' };
      }
      return { ok: true, length: pitch * turns, pitch, turns };
    }
    case 'pitch': {
      const { length, turns } = values;
      if (!isPositiveFinite(length)) {
        return { ok: false, message: 'ばねの全長は 0 より大きい数にしてください。' };
      }
      if (!isPositiveFinite(turns)) {
        return { ok: false, message: '巻数は 0 より大きく 200 以下にしてください。' };
      }
      return { ok: true, length, pitch: length / turns, turns };
    }
    case 'turns': {
      const { length, pitch } = values;
      if (!isPositiveFinite(length)) {
        return { ok: false, message: 'ばねの全長は 0 より大きい数にしてください。' };
      }
      if (!isPositiveFinite(pitch)) {
        return { ok: false, message: 'ピッチは 0 より大きい数にしてください。' };
      }
      return { ok: true, length, pitch, turns: length / pitch };
    }
  }
}

/**
 * スケッチの点フィーチャーから1点を引く(ばねの始点、§0.a-0.29)。
 *
 * ばねの始点は点フィーチャー(点列は使わない、型定義 `SketchPointRef` の注釈と同じ形を流用)。
 * `resolveSketch` の `points` は点フィーチャーと点列フィーチャーの全点を平らに並べた配列
 * (`resolveHoleCenters` の注釈を参照)なので、点列を指していても先頭の1点を返す。
 * 見つからなければ null(呼び出し側が missingProfile として断る)。
 */
export function resolveSpringOrigin(
  reference: SketchPointRef,
  sketches: readonly ResolvedPartSketch[],
): Vec3 | null {
  const sketch = sketches.find((entry) => entry.sketchId === reference.sketchId);
  if (sketch === undefined) {
    return null;
  }
  const point = sketch.resolved.points.find(
    (candidate) => candidate.featureId === reference.pointFeatureId,
  );
  return point === undefined ? null : point.position;
}

/** 0 のとき -0 になっている成分を +0 へ揃える(negateVec3 と同じ理由。§0.a-0.30 関連の過去の失敗)。 */
function cleanZeroVec3(vector: Vec3): Vec3 {
  return [
    vector[0] === 0 ? 0 : vector[0],
    vector[1] === 0 ? 0 : vector[1],
    vector[2] === 0 ? 0 : vector[2],
  ];
}

/**
 * 軸を解決し、傾き角・方位角を適用した向きを返す(FR-414、§0.a-0.10、§0.a-0.29)。
 *
 * 穴(タスク15 の `drillDirection`、`packages/kernel/src/occt/makeHole.ts`)と同じ三角関数の形
 * `sin(傾き) × (cos(方位)x + sin(方位)y) と cos(傾き) × 軸` を使うが、符号が違う:
 * 穴は「傾き 0 で面の法線の逆(材料の中)」なので `− cos(傾き)・法線` だが、
 * ばねは「傾き 0 で軸そのまま」(§0.a-0.10、types.ts の SpringFeature の注釈)なので
 * `+ cos(傾き)・軸` になる。またばねには面が無いので、基準の第1軸・第2軸は
 * `referenceAxes` が model 自身で作る(穴は面の `gp_Pln.XAxis()` をカーネルが使う)。
 *
 * `resolveTilt`(角度の範囲検査と度→ラジアンの変換)は穴と共用している。
 * 向きの組み立てそのものは `planeMath.ts` の `tiltedDirection` が正本で、任意の作業平面
 * (FR-328 の「点+軸と角度」、P4 タスク9)と同じ規約を 2 か所に書かないようにしている。
 * ここでは −0 を +0 へ揃える後始末だけを足す。
 */
export function resolveTiltedDirection(
  frame: RevolveAxisFrame,
  tiltAngleRadians: number,
  tiltAzimuthRadians: number,
): Vec3 {
  return cleanZeroVec3(
    tiltedDirection(frame.direction, tiltAngleRadians, tiltAzimuthRadians),
  );
}

/**
 * ばね(FR-414、§2.7b)。対象を取らず、新しいボディを1つ作る(§0.a-0.36)。
 *
 * 解決の順は計画書 タスク15b のとおり: 始点 → 軸 → 傾き → コイル径・線径 →
 * 全長・ピッチ・巻数(derived の計算)→ ピッチと線径の関係。
 * どの段階で断っても、それより後ろの計算(重い掃引はカーネル側だが)は行わない。
 */
function planSpring(
  feature: SpringFeature,
  sketches: readonly ResolvedPartSketch[],
  axisFrames: ReadonlyMap<string, AxisFrame>,
): PlanOutcome {
  const origin = resolveSpringOrigin(feature.origin, sketches);
  if (origin === null) {
    return fail(
      feature.id,
      'missingProfile',
      'ばねの始点にする点が見つかりません。スケッチで点を作ってからやり直してください。',
    );
  }
  const axisFrame = resolveRevolveAxis(feature.axis, sketches, axisFrames);
  if (axisFrame === null) {
    return fail(
      feature.id,
      'missingProfile',
      'ばねの軸にする線分が見つかりません。スケッチで線分をかいてから選び直してください。',
    );
  }
  const tilt = resolveTilt(feature.id, feature.tiltAngle, feature.tiltAzimuth);
  if (!tilt.ok) {
    return tilt;
  }
  const direction = resolveTiltedDirection(axisFrame, tilt.tilt.tiltAngle, tilt.tilt.tiltAzimuth);

  const coilDiameter = feature.coilDiameter.value;
  if (!isPositiveFinite(coilDiameter)) {
    return fail(feature.id, 'invalidValue', 'コイル径は 0 より大きい数にしてください。');
  }
  const wireDiameter = feature.wireDiameter.value;
  if (!isPositiveFinite(wireDiameter)) {
    return fail(feature.id, 'invalidValue', '線径は 0 より大きい数にしてください。');
  }
  if (wireDiameter >= coilDiameter) {
    return fail(feature.id, 'invalidValue', '線径はコイル径より小さくしてください。');
  }

  const resolvedLength = resolveSpringLength(
    { length: feature.length.value, pitch: feature.pitch.value, turns: feature.turns.value },
    feature.derived,
  );
  if (!resolvedLength.ok) {
    return fail(feature.id, 'invalidValue', resolvedLength.message);
  }
  if (resolvedLength.turns > MAX_SPRING_TURNS) {
    return fail(feature.id, 'invalidValue', '巻数は 0 より大きく 200 以下にしてください。');
  }
  // ここは model が先に断る(NFR-UX-5)。カーネル(タスク9b の makeSpring)でも同じ検査をするが、
  // 重い掃引を走らせる前にツリーへ理由を出す(計画書 タスク15b の解決の規則6)。
  if (resolvedLength.pitch <= wireDiameter) {
    return fail(
      feature.id,
      'invalidValue',
      'ピッチは線径より大きくしてください。隣どうしの線がぶつかります。',
    );
  }

  return {
    ok: true,
    plan: {
      kind: 'spring',
      origin,
      direction,
      coilDiameter,
      wireDiameter,
      pitch: resolvedLength.pitch,
      turns: resolvedLength.turns,
      handedness: feature.handedness,
    },
  };
}

/** パターンの並べ方の個数(FR-411、FR-412、§2.7)。2 以上 MAX_PATTERN_COUNT 以下の整数。 */
type PatternCountOutcome =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly message: string };

function resolvePatternCount(count: ExpressionValue): PatternCountOutcome {
  const value = count.value;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 2 || value > MAX_PATTERN_COUNT) {
    return { ok: false, message: '並べる個数は 2 以上 100 以下の整数にしてください。' };
  }
  return { ok: true, count: value };
}

/** 直線パターンの変換1つ(向き × 間隔 × k)。回転は掛けない(rotationAngle 0、§2.7)。 */
function linearPatternTransform(direction: Vec3, spacing: number, k: number): RigidTransform {
  return {
    // 0 を掛けると -0 になる成分があるので cleanZeroVec3 で揃える(negateVec3 と同じ理由)。
    translation: cleanZeroVec3(scaleVec3(direction, spacing * k)),
    rotationOrigin: ORIGIN,
    rotationAxis: direction,
    rotationAngle: 0,
  };
}

/**
 * パターンの変換の一覧を作る(FR-411、FR-412、§2.7)。もとの位置ぶんは作らない(n−1 個)。
 * 直線の向きも円形の軸も `resolveRevolveAxis` で解決する(`PatternDirection` は `RevolveAxis` と
 * 同じ形なので、専用の解決関数を新しく作らない、§0.a-0.21)。
 */
export function resolvePatternTransforms(
  placement: PatternPlacement,
  sketches: readonly ResolvedPartSketch[],
  axisFrames: ReadonlyMap<string, AxisFrame> = new Map<string, AxisFrame>(),
):
  | { readonly ok: true; readonly transforms: readonly RigidTransform[] }
  | { readonly ok: false; readonly code: PartErrorCode; readonly message: string } {
  const countOutcome = resolvePatternCount(placement.count);
  if (!countOutcome.ok) {
    return { ok: false, code: 'invalidValue', message: countOutcome.message };
  }
  const n = countOutcome.count;

  if (placement.kind === 'linear') {
    const spacing = placement.spacing.value;
    if (!isPositiveFinite(spacing)) {
      return {
        ok: false,
        code: 'invalidValue',
        message: '並べる間隔は 0 より大きい数にしてください。',
      };
    }
    // 両側へ並べるときに n が偶数だと、もとの穴の位置に工具が来ない(§2.7 の「注意」)。
    if (placement.symmetric && n % 2 === 0) {
      return {
        ok: false,
        code: 'invalidValue',
        message: '両側へ並べるときは、個数を奇数にしてください。',
      };
    }
    const frame = resolveRevolveAxis(placement.direction, sketches, axisFrames);
    if (frame === null) {
      return {
        ok: false,
        code: 'missingProfile',
        message: '並べる向きにする線分が見つかりません。スケッチで線分をかいてから選び直してください。',
      };
    }
    const transforms: RigidTransform[] = [];
    if (placement.symmetric) {
      // n は奇数なので (n-1)/2 は整数。0(もとの位置)を除いて両側へ振る(§2.7 の刻み表)。
      const half = (n - 1) / 2;
      for (let k = -half; k <= half; k += 1) {
        if (k === 0) {
          continue;
        }
        transforms.push(linearPatternTransform(frame.direction, spacing, k));
      }
    } else {
      for (let k = 1; k <= n - 1; k += 1) {
        transforms.push(linearPatternTransform(frame.direction, spacing, k));
      }
    }
    return { ok: true, transforms };
  }

  // 円形パターン。全周なら 360/n 度刻み、そうでなければ角度を n−1 等分する(§2.7)。
  let stepAngle: number;
  if (placement.fullCircle) {
    stepAngle = (2 * Math.PI) / n;
  } else {
    const angleDegrees = placement.angle.value;
    if (!Number.isFinite(angleDegrees) || angleDegrees <= 0 || angleDegrees > MAX_REVOLVE_DEGREES) {
      return {
        ok: false,
        code: 'invalidValue',
        message: '並べる角度は 0 より大きく 360 以下にしてください。',
      };
    }
    stepAngle = degreesToRadians(angleDegrees) / (n - 1);
  }
  const frame = resolveRevolveAxis(placement.axis, sketches, axisFrames);
  if (frame === null) {
    return {
      ok: false,
      code: 'missingProfile',
      message: '並べる向きにする線分が見つかりません。スケッチで線分をかいてから選び直してください。',
    };
  }
  const transforms: RigidTransform[] = [];
  for (let k = 1; k <= n - 1; k += 1) {
    transforms.push({
      translation: ORIGIN,
      rotationOrigin: frame.origin,
      rotationAxis: frame.direction,
      rotationAngle: stepAngle * k,
    });
  }
  return { ok: true, transforms };
}

/**
 * パターン(FR-411、FR-412、§2.7、§0.a-0.20)。繰り返すもとの加工フィーチャー(穴・ねじ穴に限る)
 * のボディを消費し、もとの工具の指定に `transforms` を足しただけの計画を作る。
 * パターン専用の SolidStepPlan の種類は持たない(§2.7「畳み方」手順5・6)。
 */
function planPattern(
  feature: PatternFeature,
  solids: readonly SolidFeature[],
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
  axisFrames: ReadonlyMap<string, AxisFrame>,
): PlanOutcome {
  const notPatternSourceMessage = '繰り返せるのは穴とねじ穴だけです。穴かねじ穴を選び直してください。';
  // 過去の失敗(ブーリアンの対象=相手)と同じ扱いで、自己参照を先に弾く
  // (docs/報告記録.md 2026-09-03 08:23 の②)。パターン自身は kind が 'pattern' で
  // isPatternSource が false になるので、この早期リターンが無くても下の判定で同じ結果になるが、
  // 「自己参照」であることを意図として明示するため独立させる。
  if (feature.sourceFeatureId === feature.id) {
    return fail(feature.id, 'invalidValue', notPatternSourceMessage);
  }
  const source = solids.find((candidate) => candidate.id === feature.sourceFeatureId);
  if (source === undefined || !isPatternSource(source)) {
    return fail(feature.id, 'invalidValue', notPatternSourceMessage);
  }
  const sourceTarget = resolveMachiningTarget(feature.id, feature.sourceFeatureId, bodyKeys, consumed);
  if (!sourceTarget.ok) {
    return sourceTarget;
  }
  const transformsOutcome = resolvePatternTransforms(feature.placement, sketches, axisFrames);
  if (!transformsOutcome.ok) {
    return fail(feature.id, transformsOutcome.code, transformsOutcome.message);
  }
  // もとの穴・ねじ穴の解決をもう一度呼んで再利用する(§2.7 手順5)。ただし consumed には
  // 「空集合」を渡す: もとのフィーチャー自身がその対象(例: 穴なら掘り込む先のボディ)を
  // main loop の消費記録ですでに consumed へ加えている(このパターンの直前で処理済みのため)。
  // 同じ consumed をそのまま渡すと、もとのフィーチャーがもう一度自分の対象を消費しようとした
  // ように誤認して consumedTwice で失敗してしまう。ここではもとの解決が使った値(面・中心・径
  // など)を再利用したいだけで、対象の消費可否は「もとのフィーチャーの鍵が bodyKeys にある」
  // ことで既に保証されている(無ければ sourceTarget の解決で先に missingBody として断っている)。
  const reuseConsumed = new Set<string>();
  let baseOutcome: PlanOutcome;
  if (source.kind === 'hole') {
    baseOutcome = planHole(source, sketches, bodyKeys, reuseConsumed);
  } else if (source.kind === 'threadHole') {
    baseOutcome = planThreadHole(source, sketches, bodyKeys, reuseConsumed);
  } else {
    // isPatternSource が hole/threadHole だけを通すので、ここへは来ない(型の保険)。
    return fail(feature.id, 'invalidValue', notPatternSourceMessage);
  }
  if (!baseOutcome.ok) {
    // もとの解決の失敗理由をそのままパターンの失敗として出す(featureId だけ差し替える)。
    return { ok: false, error: { ...baseOutcome.error, featureId: feature.id } };
  }
  const basePlan = baseOutcome.plan;
  if (basePlan.kind === 'hole') {
    return {
      ok: true,
      plan: { ...basePlan, targetKey: sourceTarget.targetKey, transforms: transformsOutcome.transforms },
    };
  }
  if (basePlan.kind === 'thread') {
    return {
      ok: true,
      plan: { ...basePlan, targetKey: sourceTarget.targetKey, transforms: transformsOutcome.transforms },
    };
  }
  // planHole / planThreadHole は必ず 'hole' / 'thread' の計画を返すので、ここへは来ない(型の保険)。
  return fail(feature.id, 'invalidValue', notPatternSourceMessage);
}

function planSolid(
  feature: SolidFeature,
  solids: readonly SolidFeature[],
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
  axisFrames: ReadonlyMap<string, AxisFrame>,
): PlanOutcome {
  switch (feature.kind) {
    case 'extrude':
      return planExtrude(feature, sketches);
    case 'revolve':
      return planRevolve(feature, sketches, axisFrames);
    case 'sew':
      return planSew(feature, sketches);
    case 'boolean':
      return planBoolean(feature, bodyKeys, consumed);
    case 'hole':
      return planHole(feature, sketches, bodyKeys, consumed);
    case 'threadHole':
      return planThreadHole(feature, sketches, bodyKeys, consumed);
    case 'spring':
      return planSpring(feature, sketches, axisFrames);
    case 'fillet':
      return planFillet(feature, bodyKeys, consumed);
    case 'chamfer':
      return planChamfer(feature, bodyKeys, consumed);
    case 'pattern':
      return planPattern(feature, solids, sketches, bodyKeys, consumed, axisFrames);
  }
}

function toKeyVec3(vector: Vec3): KeyVec3 {
  return [vector[0], vector[1], vector[2]];
}

/** 剛体変換を鍵の材料へ詰め替える(パターン、タスク16)。欄名は cacheKey.ts の KeyTransform と同じ。 */
function toKeyTransform(transform: RigidTransform): KeyTransform {
  return {
    translation: toKeyVec3(transform.translation),
    rotationOrigin: toKeyVec3(transform.rotationOrigin),
    rotationAxis: toKeyVec3(transform.rotationAxis),
    rotationAngle: transform.rotationAngle,
  };
}

/**
 * 解決済みの曲線を鍵の材料へ詰め替える(cacheKey.ts の KeyCurve)。
 * featureId は形に関わらないので落とす。詰め替えを省いて渡さないのは、
 * 材料の型が「鍵に混ぜる欄」の定義そのものであり、偶然の構造の一致に頼らないため。
 */
function toKeyCurve(curve: ResolvedCurve): KeyCurve {
  switch (curve.kind) {
    case 'segment':
      return { kind: 'segment', from: toKeyVec3(curve.from), to: toKeyVec3(curve.to) };
    case 'arc':
      return {
        kind: 'arc',
        center: toKeyVec3(curve.center),
        normal: toKeyVec3(curve.normal),
        xAxis: toKeyVec3(curve.xAxis),
        radius: curve.radius,
        startAngle: curve.startAngle,
        endAngle: curve.endAngle,
      };
    case 'ellipse':
      return {
        kind: 'ellipse',
        center: toKeyVec3(curve.center),
        normal: toKeyVec3(curve.normal),
        majorAxis: toKeyVec3(curve.majorAxis),
        majorRadius: curve.majorRadius,
        minorRadius: curve.minorRadius,
        startAngle: curve.startAngle,
        endAngle: curve.endAngle,
      };
    case 'spline':
      return {
        kind: 'spline',
        mode: curve.mode,
        points: curve.points.map((point) => toKeyVec3(point)),
        closed: curve.closed,
      };
  }
}

/** 1段ぶんの鍵の材料(§0.a-0.20)。名前・抑制・色は混ぜない(形が変わらないため)。 */
function keyMaterialFor(plan: SolidStepPlan): SolidStepKeyMaterial {
  switch (plan.kind) {
    case 'extrude':
      return {
        kind: 'extrude',
        profile: plan.profile.map(toKeyCurve),
        direction: toKeyVec3(plan.direction),
        distance: plan.distance,
      };
    case 'revolve':
      return {
        kind: 'revolve',
        profile: plan.profile.map(toKeyCurve),
        axisOrigin: toKeyVec3(plan.axisOrigin),
        axisDirection: toKeyVec3(plan.axisDirection),
        angle: plan.angle,
      };
    case 'sew':
      return {
        kind: 'sew',
        profiles: plan.profiles.map((profile) => profile.map(toKeyCurve)),
        tolerance: plan.tolerance,
      };
    case 'boolean':
      // 上流の鍵をそのまま材料にするので、上流が変われば下流の鍵も必ず変わる(鍵の連鎖)。
      return {
        kind: 'boolean',
        operation: plan.operation,
        targetKey: plan.targetKey,
        toolKey: plan.toolKey,
      };
    case 'hole':
      return {
        kind: 'hole',
        targetKey: plan.targetKey,
        face: fingerprintKeyText(plan.face),
        centers: plan.centers.map(toKeyVec3),
        diameter: plan.diameter,
        depth: plan.depth,
        tiltAngle: plan.tiltAngle,
        tiltAzimuth: plan.tiltAzimuth,
        transforms: plan.transforms.map(toKeyTransform),
      };
    case 'thread':
      return {
        kind: 'thread',
        targetKey: plan.targetKey,
        face: fingerprintKeyText(plan.face),
        centers: plan.centers.map(toKeyVec3),
        drillDiameter: plan.drillDiameter,
        // 外径とねじ部の長さは印(必ず作る)から取る。実らせんの有無で欠けることがない。
        majorDiameter: plan.mark.majorDiameter,
        pitch: plan.pitch,
        threadLength: plan.mark.length,
        depth: plan.depth,
        // 実らせんか簡略表示かで形そのものが変わるので鍵に混ぜる(§0.a-0.15、§0.a-0.16)。
        modeled: plan.thread !== null,
        tiltAngle: plan.tiltAngle,
        tiltAzimuth: plan.tiltAzimuth,
        transforms: plan.transforms.map(toKeyTransform),
      };
    case 'spring':
      // 全長(length)と derived は混ぜない(cacheKey.ts の SpringKeyMaterial の注釈、§0.a-0.30)。
      return {
        kind: 'spring',
        origin: toKeyVec3(plan.origin),
        direction: toKeyVec3(plan.direction),
        coilDiameter: plan.coilDiameter,
        wireDiameter: plan.wireDiameter,
        pitch: plan.pitch,
        turns: plan.turns,
        handedness: plan.handedness,
      };
    case 'fillet':
      return {
        kind: 'fillet',
        targetKey: plan.targetKey,
        // 並びはすでに planFillet が通し番号の昇順に揃えてある(FilletKeyMaterial の注釈)。
        targets: plan.targets.map(fingerprintKeyText),
        radius: plan.radius,
      };
    case 'chamfer': {
      const size = plan.size;
      // ChamferKeyMaterial は3通りの大きさを「距離2つ」に均して持つ(cacheKey.ts の注釈)。
      // 等距離は distance2 を使わないので 0 に揃え、距離+角度は角度(ラジアン)を distance2 に置く。
      const [distance1, distance2] =
        size.kind === 'equal'
          ? [size.distance, 0]
          : size.kind === 'twoDistances'
            ? [size.distance1, size.distance2]
            : [size.distance, size.angle];
      return {
        kind: 'chamfer',
        targetKey: plan.targetKey,
        targets: plan.targets.map(fingerprintKeyText),
        mode: size.kind,
        distance1,
        distance2,
        swapReferenceFace: plan.swapReferenceFace,
      };
    }
  }
}

/** visible を決める前の段。消費はすべての段を見終わってから確定する。 */
interface StepDraft {
  readonly featureId: string;
  readonly name: string;
  readonly key: string;
  readonly plan: SolidStepPlan;
}

/**
 * 基準ジオメトリの断り(`ReferenceErrorCode`)を、ツリーが読む `PartErrorCode` へ写す。
 * 失敗の一覧を 1 か所(`ResolvedPart.errors`)にまとめるための詰め替え。
 */
const REFERENCE_ERROR_CODES: Readonly<Record<ReferenceErrorCode, PartErrorCode>> = {
  missingPoint: 'missingProfile',
  missingSubShape: 'missingSubShape',
  missingAxis: 'missingProfile',
  missingPlane: 'missingProfile',
  collinear: 'notPlanar',
  notStraightEdge: 'degenerate',
  notFlatFace: 'degenerate',
  invalidValue: 'invalidValue',
  degenerate: 'degenerate',
  circularReference: 'circularReference',
};

function toPartError(error: ReferenceError): PartError {
  return partError(error.featureId, REFERENCE_ERROR_CODES[error.code], error.message);
}

/**
 * スケッチと基準ジオメトリを、互いを頼りながら解く(P4 タスク9)。
 *
 * スケッチは作図面として任意の作業平面(FR-328)を指せて、その作業平面はスケッチの点を
 * 基準にできる。どちらを先に解くかは決められないので、**頼まれたときに解いて覚える**形にする。
 * 解いている最中のスケッチをもう一度頼まれたら null を返し、基準ジオメトリ側が
 * 「循環しています」と断る(FR-504。無限に呼び合わない)。
 */
function resolveSketchesAndReferences(document: PartDocument): {
  readonly sketches: readonly ResolvedPartSketch[];
  readonly references: ResolvedReferences;
  readonly workPlane: (planeId: WorkPlaneId) => WorkPlane | null;
  readonly axisFrames: ReadonlyMap<string, AxisFrame>;
} {
  const resolvedSketches = new Map<string, ResolvedSketch>();
  const resolvingSketches = new Set<string>();

  const resolver = createReferenceResolver(document, {
    sketch: (sketchId) => {
      const remembered = resolvedSketches.get(sketchId);
      if (remembered !== undefined) {
        return remembered;
      }
      if (resolvingSketches.has(sketchId)) {
        return null;
      }
      const found = document.sketches.find((sketch) => sketch.id === sketchId);
      if (found === undefined) {
        return null;
      }
      resolvingSketches.add(sketchId);
      const resolved = resolveSketch(found, { workPlane: (planeId) => resolver.workPlane(planeId) });
      resolvingSketches.delete(sketchId);
      resolvedSketches.set(sketchId, resolved);
      return resolved;
    },
  });

  // 基準ジオメトリを先に解く(スケッチが作図面として使うため)。中で必要になった
  // スケッチはその場で解かれ、覚えられる。
  const references = resolver.resolveAll();
  const axisFrames = new Map<string, AxisFrame>(
    references.axes.map((axis) => [axis.featureId, { origin: axis.origin, direction: axis.direction }]),
  );

  const sketches: ResolvedPartSketch[] = document.sketches.map((sketch) => {
    const remembered = resolvedSketches.get(sketch.id);
    if (remembered !== undefined) {
      return { sketchId: sketch.id, resolved: remembered };
    }
    const resolved = resolveSketch(sketch, { workPlane: (planeId) => resolver.workPlane(planeId) });
    resolvedSketches.set(sketch.id, resolved);
    return { sketchId: sketch.id, resolved };
  });

  return { sketches, references, workPlane: resolver.workPlane, axisFrames };
}

/** 部品文書を解決して、カーネルへ渡す段の一覧を作る。例外を投げない(FR-504)。 */
export function resolvePart(document: PartDocument): ResolvedPart {
  const { sketches, references, axisFrames } = resolveSketchesAndReferences(document);

  const drafts: StepDraft[] = [];
  // 基準ジオメトリの失敗もツリーの行として出すので、同じ一覧へ写す(FR-504)。
  const errors: PartError[] = references.errors.map(toPartError);
  /** 作成に成功したボディの鍵。ここに無い id は下流から参照できない。 */
  const bodyKeys = new Map<string, string>();
  /** すでに他のフィーチャーが消費したボディ。同じものを2度は使えない(§2.2)。 */
  const consumed = new Set<string>();

  for (const feature of document.solids) {
    // 抑制は失敗ではない(FR-503)。ボディを作らず、errors にも入れない。
    if (feature.suppressed) {
      continue;
    }
    const outcome = planSolid(feature, document.solids, sketches, bodyKeys, consumed, axisFrames);
    if (!outcome.ok) {
      errors.push(outcome.error);
      continue;
    }
    const key = cacheKeyFor(keyMaterialFor(outcome.plan));
    drafts.push({ featureId: feature.id, name: feature.name, key, plan: outcome.plan });
    bodyKeys.set(feature.id, key);
    // 消費するボディを記録する(ブーリアンは対象と相手、加工は対象1つ、§0.a-0.5)。
    // 種類ごとの規則は createPartDocument.ts の consumedTargetsOf が正本で、ここには書かない。
    // 段が作れなかったフィーチャーはここへ来ないので、失敗した加工は何も消費しない。
    for (const consumedId of consumedTargetsOf(feature)) {
      consumed.add(consumedId);
    }
  }

  const steps: ResolvedSolidStep[] = drafts.map((draft) => ({
    featureId: draft.featureId,
    name: draft.name,
    key: draft.key,
    plan: draft.plan,
    visible: !consumed.has(draft.featureId),
  }));

  return {
    sketches,
    references,
    steps,
    errors,
    liveBodyIds: steps.filter((step) => step.visible).map((step) => step.featureId),
  };
}
