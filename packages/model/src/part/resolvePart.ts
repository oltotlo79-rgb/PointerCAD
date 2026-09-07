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
import { importedShapeOf } from './types.js';

import type {
  AxisFrame,
  AxisSpec,
  PlaneResolveContext,
  PlaneSpec,
  ResolvedSubShape,
} from '../geometry/planeSpec.js';
import { resolvePlaneSpec, subShapeFromFingerprint } from '../geometry/planeSpec.js';
import { projectionCacheKey } from '../sketch/projectionMath.js';
import {
  degreesToRadians,
  tiltedDirection,
  WORK_PLANES,
  WORLD_AXIS_DIRECTIONS,
  type WorkPlane,
  type WorkPlaneId,
} from '../sketch/planeMath.js';
import type { ConstraintDiagnosis } from '../sketch/constraints/diagnose.js';
import {
  resolveConstrainedSketch,
  type ConstrainedSketch,
} from '../sketch/constraints/solveSketch.js';
import {
  resolveCoordinate,
  type ResolvedSphere,
  type ResolveContext,
} from '../sketch/resolveCoordinate.js';
import {
  arcPointAt,
  curveEnd,
  curveStart,
  ellipsePointAt,
  fitPlaneNormal,
} from '../sketch/resolveSketch.js';
import { projectionBodyFeatureId } from '../sketch/types.js';
import type {
  PendingProjection,
  PointReference,
  ProjectionSource,
  ResolvedCurve,
  ResolvedFace,
  ResolvedSketch,
  SketchDocument,
  SketchError,
} from '../sketch/types.js';
import {
  addVec3,
  crossVec3,
  dotVec3,
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
  type ExtrudeEndKeyMaterial,
  type FilletRadiusKeyMaterial,
  type HoleEntryKeyMaterial,
  type KeyCurve,
  type KeyTransform,
  type KeyVec3,
  type PrimitiveShapeKeyMaterial,
  type SolidStepKeyMaterial,
  type SurfaceShapeKeyMaterial,
  type ThruSectionKeyMaterial,
} from './cacheKey.js';
import {
  consumedTargetsOf,
  DEFAULT_RULED_SPHERE_SEGMENTS,
  extrudeShapingOf,
  filletRadiusOf,
  holeEntryOf,
  isPatternSource,
  MAX_DRAFT_ANGLE_DEGREES,
  MAX_PATTERN_COUNT,
  MAX_SCALE,
  MAX_SPRING_TURNS,
  MAX_TAPER_ANGLE_DEGREES,
  MIN_SCALE,
} from './createPartDocument.js';
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
  CutFeature,
  DraftFeature,
  EmbossFeature,
  ExtrudeEnd,
  ExtrudeFeature,
  FilletFeature,
  HoleDepth,
  HoleEntry,
  HoleFeature,
  ImportedSolidFeature,
  LoftFeature,
  MirrorFeature,
  MirrorPlane,
  PartDocument,
  PatternFeature,
  PatternPlacement,
  PrimitiveFeature,
  PrimitiveShape,
  RevolveAxis,
  RevolveFeature,
  RibFeature,
  RuledFeature,
  RuledSection,
  RuledSphereSegments,
  ScaleFeature,
  SewFeature,
  ShellFeature,
  SketchCurveRef,
  SketchFaceRef,
  SketchPointRef,
  SolidFeature,
  SolidOrigin,
  SurfaceFeature,
  SurfaceOperation,
  SpringDerived,
  SpringFeature,
  SubShapeRef,
  SweepFeature,
  ThicknessSide,
  ThreadHoleFeature,
  ThreadShaftFeature,
  TransformFeature,
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
 * 罫線面・ロフト(FR-430、FR-410、P5 §2.9)の断面 1 つの解決結果。
 *
 * 種類は kernel の `ThruSectionSpec` と同じ意味で並べる(詰め替えは `kernelBridge.ts`)。
 * スケッチの面は輪郭の座標まで解けるが、**立体の面は指紋のまま段へ乗せる**
 * (輪郭を取り出せるのはカーネルだけ。穴の面とまったく同じ扱い、§2.2)。
 * 球は縁を持たないので中心と半径で渡す(§2.9.3)。
 */
export type ThruSectionPlan =
  | { readonly kind: 'curves'; readonly curves: readonly ResolvedCurve[] }
  | { readonly kind: 'sphere'; readonly center: Vec3; readonly radius: number }
  | {
      readonly kind: 'faceQuery';
      /**
       * 面を持つ立体の段の鍵。**この段はその立体を消費しない**(§0.a-0.27)ので、
       * 加工フィーチャーの `targetKey` と違い `consumedTargetsOf` には現れない。
       * 鍵に混ぜるのは、上流が変われば輪郭も変わるようにするためだけである(NFR-PF-3)。
       */
      readonly targetKey: string;
      /** 輪郭にする面の指紋。必ず面(`kind: 'face'`)で、選び直しはカーネルが行う。 */
      readonly query: SubShapeQueryPlan;
    };

/**
 * 押し出しの終端(FR-415、P5 §2.11、タスク45)を解決した結果。
 *
 * 4 種と欄名は kernel の `ExtrudeEndSpec`(`occt/makeSolidSweep.ts`)と同じで、距離は mm。
 * **`toFace`(選んだ面まで)の距離は model が計算して数値で渡す**(§0.a-0.33)ので、
 * カーネルから見ると `distance` と同じ扱いになる。`toNext`(次の面まで)だけは相手の形が
 * 要るので、段の `targetKey` と組で使う。
 *
 * **`distance` と `symmetric` の段は P2 のまま**(`SolidStepPlan.extrude` の注釈)なので、
 * ここへ現れるのは `toFace` と `toNext` だけである。4 種を書いてあるのは、カーネルの型と
 * 1 対 1 に保って詰め替えを分岐なしにするためと、鍵の材料(`ExtrudeEndKeyMaterial`)が
 * 同じ 4 種を持つためである。
 */
export type ExtrudeEndPlan =
  | { readonly kind: 'distance'; readonly distance: number }
  | { readonly kind: 'symmetric'; readonly forward: number; readonly backward: number }
  | { readonly kind: 'toFace'; readonly distance: number }
  | { readonly kind: 'toNext' };

/** 薄板押し出し(FR-416、§0.a-0.46)。kernel の `ThinExtrudeSpec` と同じ欄名。 */
export interface ThinExtrudePlan {
  /** 壁の厚み(mm)。0 より大きい。 */
  readonly thickness: number;
  readonly side: ThicknessSide;
}

/**
 * 穴・ねじ穴の入口の形(ざぐり・皿もみ。FR-422、P5 §0.a-0.39、タスク46)を解決した結果。
 *
 * 3 種と欄名は kernel の `HoleEntrySpec`(`occt/makeHole.ts`)と同じで、**皿もみの角度は
 * ラジアン**(文書は度で持ち、換算はここが行う。`HoleEntry` の注釈)。
 * **皿もみの円錐の深さは持たない**——頭径・穴の径・角度からカーネルが導くためである
 * (導出できるものは渡さない。統括の決定 2026-09-05 17:37)。
 *
 * `plain`(広げない)の段は**この欄そのものを省く**ので、入口を指定していない穴と
 * 「広げない」を明示した穴は段も鍵も 1 ドット違わない(押し出しの終端と同じ決め)。
 */
export type HoleEntryPlan =
  | { readonly kind: 'counterbore'; readonly diameter: number; readonly depth: number }
  /** `angle` は**ラジアン**。 */
  | { readonly kind: 'countersink'; readonly diameter: number; readonly angle: number };

/**
 * 丸める半径(FR-407、可変半径は FR-426、§0.a-0.48)を解決した結果。
 *
 * kernel の `FilletRadiusSpec` と同じ形(`number | { start; end }`)にしてあるので、
 * `kernelBridge` はそのまま渡せる。`start` は辺の始点側、`end` は終点側の半径(mm)。
 */
export type FilletRadiusPlan = number | { readonly start: number; readonly end: number };

/**
 * 曲面の作り方(FR-428、§0.a-0.45)を解決した結果。6 種。
 *
 * 種類と欄名は kernel の `SurfaceInput`(`occt/makeSurface.ts`)に揃えてあるので、
 * `kernelBridge` は曲線と指紋を詰め替えるだけで渡せる。角度はラジアン、距離は mm。
 * **`face` と `offset` だけが立体の面を材料にする**が、どちらも借りるだけで消費しない
 * (罫線面の `faceQuery`・基本形状の頂点と同じ扱い、§0.a-0.27)。
 */
export type SurfaceShapePlan =
  | {
      readonly kind: 'extrude';
      readonly profile: readonly ResolvedCurve[];
      /** 掃く向き(単位ベクトル)。反転を適用した後の向き。 */
      readonly direction: Vec3;
      readonly distance: number;
    }
  | {
      readonly kind: 'revolve';
      readonly profile: readonly ResolvedCurve[];
      readonly axisOrigin: Vec3;
      readonly axisDirection: Vec3;
      /** 回転角(ラジアン)。 */
      readonly angle: number;
    }
  | { readonly kind: 'planar'; readonly profile: readonly ResolvedCurve[] }
  | {
      readonly kind: 'loft';
      readonly sections: readonly (readonly ResolvedCurve[])[];
      readonly ruled: boolean;
    }
  | { readonly kind: 'face'; readonly face: SubShapeQueryPlan }
  | {
      readonly kind: 'offset';
      readonly face: SubShapeQueryPlan;
      /** 離す距離(mm)。0 以外(0 は解決が断る)。 */
      readonly distance: number;
    };

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
      /**
       * 押し出す長さ(mm)。正の数。両側でも半分にしない(断面をずらして表す)。
       * 「選んだ面まで」(FR-415)のときは**面まで測った距離**が入る(利用者が入れた長さは
       * 使わない)ので、`end` を見ないカーネルでも同じ形になる。
       */
      readonly distance: number;
      /**
       * どこまで押し出すか(FR-415、P5 タスク45)。**省略は「距離ぶんを片側へ」と同じ。**
       *
       * **両側(`symmetric`)でも省略する。** 断面を距離の半分だけ逆向きへ動かすのは
       * P2 からの model の役目(§0.a-0.8)で、`profile` にその平行移動が入っている。
       * ここへ kernel の `symmetric`(前後の長さ)を重ねて渡すと、カーネルがもう一度
       * 同じぶんだけずらしてしまう。したがって現れるのは `toFace` と `toNext` だけ。
       */
      readonly end?: ExtrudeEndPlan;
      /**
       * 側面の傾き(**ラジアン**、FR-401)。大きさだけを持ち、向きは `taperOutward`。
       * 省略・0 は「傾けない」(P2 からの押し出しと同じ形)。
       */
      readonly taperAngle?: number;
      /** true で押し出すほど外へ広がり、false(既定)で内へ絞る。 */
      readonly taperOutward?: boolean;
      /** 薄板にするときの厚みと向き(FR-416)。省略・null は中身の詰まった押し出し。 */
      readonly thin?: ThinExtrudePlan | null;
      /**
       * 「次の面まで」(`end.kind === 'toNext'`)の相手の立体の段の鍵。
       * **この段は相手を消費しない**(長さを決めるために形を読むだけ)が、相手が変われば
       * 長さが変わるので**鍵には必ず混ぜる**(NFR-PF-3。基本形状の頂点と同じ扱い)。
       * それ以外の終端では省略する。
       */
      readonly targetKey?: string | null;
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
      /**
       * 入口の形(ざぐり・皿もみ。FR-422、タスク46)。**広げないときは省く**
       * (`HoleEntryPlan` の注釈。省略と「広げない」を同じ段・同じ鍵にするため)。
       */
      readonly entry?: HoleEntryPlan;
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
      /**
       * 入口の形(ざぐり・皿もみ。FR-422、タスク46)。**広げないときは省く**
       * (`HoleEntryPlan` の注釈と同じ約束。穴の枝と1文字も違わない扱い)。
       */
      readonly entry?: HoleEntryPlan;
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
      /**
       * 丸める半径(mm)。0 より大きい。**可変半径(FR-426)のときは始点と終点の 2 値**
       * (`FilletRadiusPlan`)。一定半径のときは P3 と同じ数 1 つで、段も鍵も変わらない。
       */
      readonly radius: FilletRadiusPlan;
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
    }
  | {
      readonly kind: 'primitive';
      /**
       * 基準点(mm)。球・箱・トーラスは中心、円柱・円錐は底面の中心(P5 §0.a-0.17)。
       *
       * **`originQuery` が入っているときは、その頂点からのずれ**(kernel の
       * `PrimitiveStepSpec.origin` と同じ約束)。いまの UI にはずれの欄が無いので、
       * 頂点を指したときは必ず原点 `[0, 0, 0]` になる。
       */
      readonly origin: Vec3;
      /** 向き(単位ベクトル)。カーネルでは `gp_Ax2` の Z 方向になる。 */
      readonly axis: Vec3;
      readonly shape:
        | { readonly kind: 'sphere'; readonly radius: number }
        | {
            readonly kind: 'box';
            readonly sizeX: number;
            readonly sizeY: number;
            readonly sizeZ: number;
          }
        | { readonly kind: 'cylinder'; readonly radius: number; readonly height: number }
        | {
            readonly kind: 'cone';
            readonly bottomRadius: number;
            readonly topRadius: number;
            readonly height: number;
          }
        | { readonly kind: 'torus'; readonly majorRadius: number; readonly minorRadius: number };
      /**
       * 基準点にする「立体の頂点」の指紋(FR-429、§0.a-0.18)。座標の式・スケッチの点なら null。
       * **選び直しはカーネルが行う**(model は面・辺・頂点の位置を持たないため、穴の面と同じ扱い)。
       */
      readonly originQuery: SubShapeQueryPlan | null;
      /**
       * `originQuery` の頂点を持つ立体の段の鍵。`originQuery` が null なら null。
       * **この段はその立体を消費しない**(頂点の座標を読むだけ、§0.a-0.19)ので、
       * 加工フィーチャーの `targetKey` と違い `consumedTargetsOf` には現れない。
       */
      readonly targetKey: string | null;
    }
  | {
      /**
       * 輪郭をつないで立体にする段(罫線面 FR-430・ロフト FR-410、P5 §2.9)。
       *
       * **model のフィーチャーは 2 種類(`ruled` / `loft`)だが、段は 1 種類**にまとめる
       * (§0.a-0.25。カーネルでは `ruled` の真偽しか違わないので、同じものを 2 つ作らない)。
       * 対象を取らない「作る」段で、輪郭を貸した立体は消費しない(§0.a-0.27)。
       */
      readonly kind: 'thruSections';
      /** つなぐ断面。2 つ以上。並びが意味を持つ。 */
      readonly sections: readonly ThruSectionPlan[];
      /** true なら直線で結ぶ(罫線面)、false ならなめらかに結ぶ(ロフト)。 */
      readonly ruled: boolean;
      /** 両端に面を張って閉じた立体にするか。いまは常に true(§0.a-0.25)。 */
      readonly closed: boolean;
      /** ねじれの補正(整数、§0.a-0.28)。小数は解決のときに断ってあるのでここへは来ない。 */
      readonly twist: number;
      /**
       * 球へつなぐときの近似の点の数(§0.a-0.74)。球を含まない段でも
       * 既定(`DEFAULT_RULED_SPHERE_SEGMENTS`)が入る(段の欄を種類で出し分けないため)。
       */
      readonly sphereSegments: RuledSphereSegments;
    }
  | {
      /**
       * 抜き勾配(FR-417、P5 §2.11、タスク45)。**対象を消費する。**
       * 面の選び直しはカーネルが行う(model は指紋を渡すだけ。穴の面と同じ扱い、§2.2)。
       */
      readonly kind: 'draft';
      readonly targetKey: string;
      /** 傾ける面の指紋。1 枚以上。通し番号の昇順(R 面取りと同じ理由で鍵を安定させる)。 */
      readonly faces: readonly SubShapeQueryPlan[];
      /** 基準にする平らな面(中立面)の指紋。この面は動かない。 */
      readonly neutralFace: SubShapeQueryPlan;
      /** 傾きの大きさ(ラジアン)。0 より大きく MAX_DRAFT_ANGLE_DEGREES 以下。 */
      readonly angle: number;
      readonly reversed: boolean;
    }
  | {
      /**
       * ミラー(FR-419、§0.a-0.36)。平面に対する鏡像のボディを 1 つ作る。
       * **対象を消費しない**(元と鏡像を後で和でまとめるため)が、`targetKey` は必ず持つ。
       */
      readonly kind: 'mirror';
      readonly targetKey: string;
      /** 鏡の平面が通る点(mm)。 */
      readonly origin: Vec3;
      /** 鏡の平面の単位法線。 */
      readonly normal: Vec3;
    }
  | {
      /**
       * 移動/回転(FR-424、§0.a-0.41)。**対象を消費する。**
       * 欄の意味は `RigidTransform`(パターンの剛体変換)と同じで、回転角はラジアン。
       */
      readonly kind: 'transform';
      readonly targetKey: string;
      readonly translation: Vec3;
      readonly rotationOrigin: Vec3;
      readonly rotationAxis: Vec3;
      /** 回転角(ラジアン)。0 なら平行移動だけ。 */
      readonly rotationAngle: number;
    }
  | {
      /**
       * 拡大縮小(FR-424、§0.a-0.41)。**対象を消費する。**
       * `uniform` と `perAxis` は**どちらか一方だけ**が入る(解決が正規化する、§2.11)。
       */
      readonly kind: 'scale';
      readonly targetKey: string;
      /** 拡大縮小の中心(mm)。この点は動かない。 */
      readonly origin: Vec3;
      /** 全体の倍率。軸ごとに変えるときは null。 */
      readonly uniform: number | null;
      /** 軸ごとの倍率(X, Y, Z)。全体の倍率のときは null。 */
      readonly perAxis: Vec3 | null;
    }
  | {
      /**
       * スイープ(FR-409、§0.a-0.43、タスク46)。断面を経路に沿って掃く。
       * **対象を取らない「作る」段**(押し出し・ばね・基本形状と同じ)。
       */
      readonly kind: 'sweep';
      /** 掃く断面の閉ループ。 */
      readonly profile: readonly ResolvedCurve[];
      /** 経路。並びが意味を持つ(書かれた順につながっている前提)。 */
      readonly path: readonly ResolvedCurve[];
      /** true で Frenet、false(既定)で「ねじれを抑える」。 */
      readonly frenet: boolean;
    }
  | {
      /**
       * リブ(FR-420、§0.a-0.37、タスク46)。開いた輪郭に厚みを付けた壁を足す。
       * **対象を消費する。**
       */
      readonly kind: 'rib';
      readonly targetKey: string;
      /** 壁にする輪郭(閉じていなくてよい)。 */
      readonly profile: readonly ResolvedCurve[];
      /** 輪郭の平面の単位法線。厚みはこの向きへ付く。 */
      readonly normal: Vec3;
      /** 壁の厚み(mm)。0 より大きい。 */
      readonly thickness: number;
      /** 両側へ付けるか(false なら法線の側だけ)。 */
      readonly symmetric: boolean;
      /** 伸ばす向き(材料へ向かう向き、単位ベクトル)。輪郭の平面の中にある。 */
      readonly direction: Vec3;
      /**
       * 材料に届くまで伸ばすか(FR-420、タスク46)。false は伸ばさず輪郭の厚みぶんだけの壁。
       * カーネルの段(`RibStepSpec.extendToBody`)と同じ欄名で、鍵にも必ず混ぜる
       * (`cacheKey.ts` の `RibKeyMaterial.extendToBody` の注釈)。
       */
      readonly extendToBody: boolean;
    }
  | {
      /**
       * エンボス(FR-421、§0.a-0.38、タスク46)。平らな面へ輪郭を彫る / 浮き出す。
       * **対象を消費する。**
       */
      readonly kind: 'emboss';
      readonly targetKey: string;
      /** 相手の面の指紋。平らな面だけ(選び直しはカーネル、§2.2)。 */
      readonly face: SubShapeQueryPlan;
      /** 面の上に置く閉じた輪郭。model のフィーチャーは 1 枚だが、段は列で受ける。 */
      readonly profiles: readonly (readonly ResolvedCurve[])[];
      /** 面から測った深さ(mm)。0 より大きい(文書の `height` そのもの)。 */
      readonly depth: number;
      /** true なら浮き出す(和)、false なら彫る(差)。 */
      readonly raised: boolean;
    }
  | {
      /**
       * 外ねじ(FR-423、§0.a-0.40、タスク46)。円柱面にねじを切る。**対象を消費する。**
       * 呼び径は規格表(`thread/metricThread.ts`)から引き、軸の実寸との食い違いは
       * 解決が先に断る(§0.a-0.85、`THREAD_SHAFT_DIAMETER_TOLERANCE_MM`)。
       */
      readonly kind: 'threadShaft';
      readonly targetKey: string;
      /** ねじを切る円柱面の指紋。 */
      readonly face: SubShapeQueryPlan;
      /** 呼び径 d(mm)。印に載せる値で、削る深さはカーネルがピッチから決める。 */
      readonly majorDiameter: number;
      readonly pitch: number;
      /** ねじ部の長さ(mm)。 */
      readonly length: number;
      readonly fromEnd: 'first' | 'last';
      /** 実らせんを切るなら true。false(既定)は簡略表示で B-rep に触れない。 */
      readonly modeled: boolean;
    }
  | {
      /**
       * 曲面(FR-428、§0.a-0.45、タスク46)。**面だけのボディ**を作る。
       * **どの作り方でも対象を消費しない**が、`face` / `offset` のときは面を借りる立体の
       * 鍵を必ず持つ(鍵の連鎖。混ぜないと上流を編集しても古い面の形が返る、NFR-PF-3)。
       */
      readonly kind: 'surface';
      readonly shape: SurfaceShapePlan;
      /** 面を借りる立体の段の鍵。`face` / `offset` 以外は null。**消費しない。** */
      readonly targetKey: string | null;
    }
  | {
      /**
       * くり抜き(シェル。FR-418、§0.a-0.47、タスク46)。壁の厚さを残して中身を抜く。
       * **対象を消費する。**
       */
      readonly kind: 'shell';
      readonly targetKey: string;
      /** 開ける面の指紋。**0 枚でもよい。** 通し番号の昇順(R 面取りと同じ理由)。 */
      readonly openFaces: readonly SubShapeQueryPlan[];
      /** 壁の厚さ(mm)。0 より大きい。 */
      readonly thickness: number;
      /** true で外向きに肉を付ける。false(既定)で内向き。 */
      readonly outward: boolean;
    }
  | {
      /**
       * 平面による切断(FR-432、§2.9b、タスク27c)。**対象を消費し、残す側 1 つ**を作る。
       *
       * 平面(`PlaneSpec` の 7 種)は解決が「通る点+単位法線」の数値まで解いてから
       * 載せる。カーネルは平面 1 枚しか要らないので、指紋を段へ運ばない
       * (§2.9b の「カーネルへの往復を増やさない」)。
       */
      readonly kind: 'cut';
      readonly targetKey: string;
      /** 切断面が通る点(mm)。 */
      readonly origin: Vec3;
      /** 切断面の単位法線。この向きの側を残すかどうかが `keepPositive`。 */
      readonly normal: Vec3;
      /** 法線の側を残すなら true(文書の `keep === 'positive'`)。 */
      readonly keepPositive: boolean;
    }
  | {
      /**
       * 読み込んだ形(ベースボディ。FR-802、P6 §2.8、タスク20)。**対象を取らない「作る」段。**
       *
       * 段がすることは「抱き込んであるバイト列から B-rep を戻す」ことだけである
       * (カーネルの `ImportedSolidStepSpec`、タスク10)。
       *
       * **鍵に混ぜるのは `shapeRef` だけ**(`bytes` は混ぜない)。中身は読み込んだあと
       * 二度と変わらないので、同じ `shapeRef` なら必ず同じ形になり、大きなバイト列を
       * 毎回ハッシュに掛けずに済む(NFR-PF-3)。
       */
      readonly kind: 'importedSolid';
      /** `.pcad` の `shapes/<shapeRef>.brep` の名前の素。鍵の材料はこれだけ。 */
      readonly shapeRef: string;
      /**
       * 抱き込んだ B-rep のバイト列。Worker が作り直された(タブの再読み込み、キャッシュの
       * 追い出し)ときに形を戻せる材料はここにしか無いので、段に載せて毎回渡す。
       */
      readonly bytes: Uint8Array;
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
  /**
   * 拘束の診断(自由度・足しすぎ・矛盾。FR-313、P4b タスク8)。
   * **拘束が 1 つも無いスケッチと 3D スケッチでは null**(診断そのものを行わない)。
   */
  readonly diagnosis: ConstraintDiagnosis | null;
  /**
   * 拘束の失敗(FR-504)。`resolved.errors` とは別に持つ。分けているのは、
   * 拘束の失敗が「フィーチャーが作れなかった」ではなく「拘束が効かなかった」で、
   * 画面での出し方(どの拘束を指すか)が違うため。
   */
  readonly constraintErrors: readonly SketchError[];
}

/**
 * まだ形の無い投影・交差を、カーネルへ頼める形まで組み立てたもの(FR-325、タスク25)。
 *
 * スケッチ側の `PendingProjection` は「どの立体の何を、どの作図面へ」までしか知らない。
 * ここでその立体の**段の鍵**(`ResolvedSolidStep.key`)を足すことで、
 * ①覚え書きの鍵が作れる(上流が変われば必ず変わる)、②カーネルが形状キャッシュから
 * もとの立体を引ける、の 2 つがそろう。頼むのは `recomputePart` の役目。
 */
export interface ResolvedProjection {
  /** この投影・交差を持つスケッチの id。 */
  readonly sketchId: string;
  /** 投影・交差フィーチャーの id。結果の対応づけに使う。 */
  readonly featureId: string;
  /** 覚え書き(`ProjectionCache`)の鍵。 */
  readonly key: string;
  /** もとの立体の段の鍵。 */
  readonly bodyKey: string;
  readonly source: ProjectionSource;
  readonly plane: WorkPlane;
}

/**
 * 読み込んだ三角形の形のボディ 1 つ(FR-802、P6 §2.8、タスク20)。
 *
 * **段(`ResolvedSolidStep`)にはならない。** 三角形は B-rep にしない(§0.a-0.23)ので
 * 幾何カーネルへ渡す形が無く、`SolidStepPlan` にも `bodyKeys` にも現れない。そのかわり
 * ここへ 1 行ずつ並べ、画面が `.pcad` の `meshes/<meshRef>.bin` から三角形を読んで描く。
 *
 * **形状キャッシュも要らない。** 読み込んだ三角形は再計算で変わりようがなく、
 * 作り直す計算そのものが無いためである(だから鍵の欄も持たない)。
 */
export interface ResolvedMeshBody {
  /** このボディを作ったフィーチャーの id(= ボディの id、§0.a-0.5)。 */
  readonly featureId: string;
  /** フィーチャーツリーに出す名前(FR-501)。 */
  readonly name: string;
  /** `.pcad` の `meshes/<meshRef>.bin` の名前の素。画面はこれで三角形を引く。 */
  readonly meshRef: string;
  /** 三角形の数(文書に記録された値をそのまま持つ)。 */
  readonly triangleCount: number;
  /** 体積(mm³)。測っていない / 閉じていないので測れないときは null。 */
  readonly volume: number | null;
  /**
   * 画面に出すか。**いまは必ず true。** 三角形の形は加工にもブーリアンにも使えない
   * (`IMPORTED_MESH_TARGET_MESSAGE` で断る)ので、消費されようがないためである。
   * 欄を置いてあるのは段(`ResolvedSolidStep.visible`)と読み方をそろえるためで、
   * 画面はどちらのボディも同じ規則(`visible`)だけを見ればよい。
   */
  readonly visible: boolean;
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
  /**
   * 読み込んだ三角形の形のボディ(FR-802、P6 §2.8、タスク20)。無ければ空。
   *
   * **`steps` とは別の一覧にしてある。** カーネルへ渡す段が 1 つも増えないので `steps` へ
   * 混ぜると「段の数」「キャッシュに当たった数」の意味が狂い、性能の検査(NFR-PF-2)が
   * 数えているものが変わってしまう。並びは文書の履歴の順。
   */
  readonly meshBodies: readonly ResolvedMeshBody[];
  /**
   * まだ形の無い投影・交差(FR-325、タスク25)。無ければ空。
   * `recomputePart` がカーネルへ頼み、覚え書きへ入れてから解決し直す
   * (`ResolvedSketch.pendingOffsets` と同じ 2 段の流れ)。
   */
  readonly projections: readonly ResolvedProjection[];
  /** ソリッドの解決の失敗(FR-504)。抑制は失敗ではないので入れない。 */
  readonly errors: readonly PartError[];
  /**
   * いま画面に出るボディの id(§0.a-0.5)。steps のうち visible なものを履歴順に並べたもの。
   * createPartDocument.ts の liveBodyIds は文書だけを見る近似で、こちらは
   * 「作成に成功したか」まで見た確定版(FR-502 の表示・選択はこちらを使う)。
   *
   * **読み込んだ三角形の形(`meshBodies`)もここへ並ぶ**(FR-802、P6 §2.8)。画面に出て
   * 選べて色を付けられる(§0.a-0.28)ものは、段になるかどうかに関わらず「生きたボディ」
   * だからである。並びは履歴の順で、段とメッシュが混ざっても文書の並びのままになる。
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

/**
 * 段を組み立てるのに要る「部品文書の外から解ける道具」(P5 タスク45)。
 *
 * P5 の Should 群(押し出しの「選んだ面まで」・ミラー・拡大縮小)は、断面と式のほかに
 * **立体の面の平面・作業平面・点の参照**を要る。どれも既に正本の解決が別の場所にあり
 * (`geometry/planeSpec.ts` の `subShapeFromFingerprint`、`part/resolveReferences.ts` の
 * `workPlane` / `point`)、ここへ写すと同じ規約が 2 か所になる。そこで**関数のまま束ねて
 * 渡す**。引数を 1 つずつ足していくと `planSolid` の引数が 8 個を超えて読めなくなるのも
 * 束ねる理由である。
 */
interface SolidPlanContext {
  /**
   * 面・辺・頂点の位置と向き。`resolvePart` の `options.subShape` が渡されていれば
   * 「いまの形」で選び直した値、渡されていなければ保存された指紋の値になる
   * (`ResolvePartOptions.subShape` の注釈と同じ約束)。
   */
  readonly subShape: (reference: SubShapeRef) => ResolvedSubShape | null;
  /** 作図面(基準の 3 面と FR-328 の任意の作業平面)を id で引く。 */
  readonly workPlane: (planeId: WorkPlaneId) => WorkPlane | null;
  /** 点の参照(座標の式・スケッチの点・立体の頂点ほか)を世界座標へ。 */
  readonly point: (reference: PointReference) => Vec3 | null;
  /** 基準軸(FR-329)の解決結果。`resolveRevolveAxis` へそのまま渡す。 */
  readonly axisFrames: ReadonlyMap<string, AxisFrame>;
  /**
   * スケッチの**保存形**(P5 タスク46)。解決済みの `ResolvedPartSketch` は作図面の id を
   * 持たないので、**開いた輪郭の平面の法線**を作図面から取るためにここで持つ
   * (リブ FR-420・曲面の押し出し FR-428。線分 1 本の輪郭は座標だけからは平面が決まらない)。
   */
  readonly sketchDocuments: readonly SketchDocument[];
}

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

/* ------------------------------------------------------------------ *
 * 押し出しの終端・テーパ・薄板(FR-415、FR-401、FR-416)。P5 §2.11、タスク45
 * ------------------------------------------------------------------ */

/** 選んだ面が引けない(消えた・上流が失敗した)。面取りの言い回しに揃える。 */
const EXTRUDE_TO_FACE_MISSING_MESSAGE =
  '押し出す先の面が見つかりません。形が大きく変わったため、選び直してください。';
/** 面までの距離は平面でないと測れない(曲面までの距離は 1 つに決まらない)。 */
const EXTRUDE_TO_FACE_NOT_FLAT_MESSAGE =
  '押し出す先にできるのは平らな面だけです。面を選び直してください。';
/** 向きと面が平行だと交わらないので、どこまで伸ばしても面に届かない。 */
const EXTRUDE_TO_FACE_PARALLEL_MESSAGE =
  '押し出す向きと面が平行です。別の面を選ぶか、押し出す向きを変えてください。';
/** 面が断面の後ろ側にある(向きの先に無い)。反転すれば届く。 */
const EXTRUDE_TO_FACE_BEHIND_MESSAGE =
  '押し出す向きの先に面がありません。向きを反転するか、別の面を選んでください。';
/**
 * 「次の面まで」の相手にできる立体が 1 つも無い。
 * **文言はカーネル(`makeSolidSweep.ts` の `NO_MATERIAL_AHEAD_MESSAGE`)と 1 字も違えずに
 * 揃える**(基本形状の断りと同じ決め。片方だけ直すと理由が食い違う)。
 */
const EXTRUDE_TO_NEXT_MISSING_MESSAGE = '押し出す先に立体がありません。';

/** 向きと面の法線がこれ以下しか噛み合っていなければ「平行」とみなす(平面の当てはめと同じ桁)。 */
const EXTRUDE_TO_FACE_EPSILON = 1e-9;

/** 押し出しの終端を解決した結果。`targetKey` は `toNext` のときだけ入る。 */
interface ExtrudeEndOutcomeValue {
  readonly end: ExtrudeEndPlan | null;
  /** 段の `distance`。`toFace` は測った距離、それ以外は利用者が入れた長さ。 */
  readonly distance: number;
  readonly targetKey: string | null;
}

type ExtrudeEndOutcome =
  | { readonly ok: true; readonly value: ExtrudeEndOutcomeValue }
  | { readonly ok: false; readonly error: PartError };

/**
 * 「選んだ面まで」の距離を model 側で計算する(FR-415、§0.a-0.33)。
 *
 * 面の平面は **P4 タスク9 と同じ仕組み**(`geometry/planeSpec.ts` の
 * `subShapeFromFingerprint`、または `resolvePart` に渡された選び直しの関数)で解く。
 * カーネルを呼ばずに済むのは、面の重心と法線が指紋そのものに入っているためである。
 *
 * 距離は「断面の平面上の 1 点から、向きに沿って面の平面と交わるまで」で、
 * 交点までの長さ `t` は `((面の点 − 断面の点)・法線) / (向き・法線)` で決まる。
 * 向きと面が平行(分母 ≈ 0)、面が後ろ側(t ≤ 0)のときは理由をつけて断る(FR-504)。
 */
function resolveExtrudeToFace(
  featureId: string,
  face: SubShapeRef,
  profilePoint: Vec3,
  direction: Vec3,
  context: SolidPlanContext,
): { readonly ok: true; readonly distance: number } | { readonly ok: false; readonly error: PartError } {
  const resolved = context.subShape(face);
  if (resolved === null) {
    return {
      ok: false,
      error: partError(featureId, 'missingSubShape', EXTRUDE_TO_FACE_MISSING_MESSAGE),
    };
  }
  if (resolved.kind !== 'face' || resolved.surfaceKind !== 'plane' || resolved.axis === null) {
    return {
      ok: false,
      error: partError(featureId, 'degenerate', EXTRUDE_TO_FACE_NOT_FLAT_MESSAGE),
    };
  }
  const normal = normalizeVec3(resolved.axis);
  const denominator = dotVec3(direction, normal);
  if (Math.abs(denominator) <= EXTRUDE_TO_FACE_EPSILON) {
    return {
      ok: false,
      error: partError(featureId, 'degenerate', EXTRUDE_TO_FACE_PARALLEL_MESSAGE),
    };
  }
  const distance = dotVec3(subVec3(resolved.position, profilePoint), normal) / denominator;
  if (!Number.isFinite(distance) || distance <= 0) {
    return {
      ok: false,
      error: partError(featureId, 'invalidValue', EXTRUDE_TO_FACE_BEHIND_MESSAGE),
    };
  }
  return { ok: true, distance };
}

/**
 * 「次の面まで」の相手にする立体を選ぶ(FR-415)。
 *
 * `ExtrudeEnd.toNext` は相手を指す欄を持たない(利用者は「次にぶつかるまで」としか
 * 言っていない)ので、**履歴で自分より前にあり、まだ消費されていない立体のうち、
 * いちばん新しいもの**を相手にする。`bodyKeys` は履歴順に積まれるので、その最後が
 * 「直前に作った立体」になる。どこまで伸ばすかを決めるのはカーネル(相手の境界箱)で、
 * model は相手の鍵を渡すだけである。**消費はしない**(相手はそのまま画面に残る)。
 */
function lastLiveBodyKey(
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): string | null {
  let found: string | null = null;
  for (const [featureId, key] of bodyKeys) {
    if (!consumed.has(featureId)) {
      found = key;
    }
  }
  return found;
}

/**
 * 押し出しの終端(FR-415)を段の欄へ直す。
 *
 * `distance` と `symmetric` は **P2 のまま**(段に `end` を載せない)。両側の平行移動は
 * model の役目(§0.a-0.8)で `profile` に入っており、kernel の `symmetric` を重ねると
 * 二重にずれるためである(`SolidStepPlan.extrude.end` の注釈)。
 */
function resolveExtrudeEnd(
  feature: ExtrudeFeature,
  end: ExtrudeEnd,
  profilePoint: Vec3,
  direction: Vec3,
  distance: number,
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
  context: SolidPlanContext,
): ExtrudeEndOutcome {
  switch (end.kind) {
    case 'distance':
    case 'symmetric':
      return { ok: true, value: { end: null, distance, targetKey: null } };
    case 'toFace': {
      const outcome = resolveExtrudeToFace(feature.id, end.face, profilePoint, direction, context);
      if (!outcome.ok) {
        return outcome;
      }
      // 段の `distance` も測った距離にする(`end` を見ないカーネルでも同じ形になる)。
      return {
        ok: true,
        value: {
          end: { kind: 'toFace', distance: outcome.distance },
          distance: outcome.distance,
          targetKey: null,
        },
      };
    }
    case 'toNext': {
      const targetKey = lastLiveBodyKey(bodyKeys, consumed);
      if (targetKey === null) {
        return {
          ok: false,
          error: partError(feature.id, 'missingBody', EXTRUDE_TO_NEXT_MISSING_MESSAGE),
        };
      }
      return { ok: true, value: { end: { kind: 'toNext' }, distance, targetKey } };
    }
  }
}

/**
 * 押し出し(FR-401、FR-415、FR-416、§0.a-0.8)。向き・反転・両側の平行移動をここで決める。
 *
 * P5 タスク45 で終端(FR-415)・テーパ(FR-401)・薄板(FR-416)を足した。省略できる 5 欄は
 * **必ず `extrudeShapingOf` を通して読む**(既定値は createPartDocument.ts の 1 か所)。
 * 段へは**既定から外れた欄だけ**を載せるので、欄を省いた押し出しと既定を明示した押し出しは
 * 段も鍵も 1 ドット違わない(cacheKey.ts の `keyExtrudeExtras` と同じ決め)。
 */
function planExtrude(
  feature: ExtrudeFeature,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
  context: SolidPlanContext,
): PlanOutcome {
  const face = findResolvedFace(sketches, feature.profile);
  if (face === undefined) {
    return fail(
      feature.id,
      'missingProfile',
      '押し出すもとの面が見つかりません。スケッチで面を張ってからやり直してください。',
    );
  }
  const entered = feature.distance.value;
  if (!Number.isFinite(entered) || entered <= 0) {
    return fail(feature.id, 'invalidValue', '押し出す長さは 0 より大きい数にしてください。');
  }
  const samples = face.curves.flatMap((curve) => curveSamplePoints(curve));
  const normal = fitPlaneNormal(samples);
  // resolveSketch が平面に乗らない面を断るので通常は起きない。断っても止めない(FR-504)。
  if (normal === null) {
    return fail(
      feature.id,
      'notPlanar',
      '押し出す向きが決まりません。面の形が平らになっているか確かめてください。',
    );
  }
  const direction = feature.reversed ? negateVec3(normal) : normal;
  const shaping = extrudeShapingOf(feature);

  // 面の平面上の 1 点。断面は平らなのでどの点で測っても同じ距離になる(標本点の先頭を使う)。
  const endOutcome = resolveExtrudeEnd(
    feature,
    shaping.end,
    samples[0] ?? ORIGIN,
    direction,
    entered,
    bodyKeys,
    consumed,
    context,
  );
  if (!endOutcome.ok) {
    return endOutcome;
  }

  const taperDegrees = shaping.taperAngle.value;
  if (
    !Number.isFinite(taperDegrees) ||
    taperDegrees < 0 ||
    taperDegrees > MAX_TAPER_ANGLE_DEGREES
  ) {
    return fail(feature.id, 'invalidValue', '側面の傾きは 0 以上 60 度以下にしてください。');
  }
  let thin: ThinExtrudePlan | null = null;
  if (shaping.thickness !== null) {
    if (!isPositiveFinite(shaping.thickness.value)) {
      return fail(feature.id, 'invalidValue', '壁の厚みは 0 より大きい数にしてください。');
    }
    thin = { thickness: shaping.thickness.value, side: shaping.thicknessSide };
  }

  // 「両側へ」は、断面を逆向きへ距離の半分だけ動かしてから距離ぶん押し出す(§0.a-0.8)。
  // 平行移動を model 側で行うので、カーネルへは断面・向き・長さだけを渡せる。
  const profile =
    shaping.end.kind === 'symmetric'
      ? face.curves.map((curve) =>
          translateCurve(curve, scaleVec3(negateVec3(direction), entered / 2)),
        )
      : face.curves;
  const { end, distance, targetKey } = endOutcome.value;
  return {
    ok: true,
    plan: {
      kind: 'extrude',
      profile,
      direction,
      distance,
      // 既定の欄は載せない(省略と既定を同じ段・同じ鍵にするため)。
      ...(end === null ? {} : { end }),
      ...(taperDegrees === 0
        ? {}
        : { taperAngle: degreesToRadians(taperDegrees), taperOutward: shaping.taperOutward }),
      ...(thin === null ? {} : { thin }),
      ...(targetKey === null ? {} : { targetKey }),
    },
  };
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

/* ------------------------------------------------------------------ *
 * 穴の入口(ざぐり・皿もみ。FR-422、P5 §0.a-0.39)。タスク46
 * ------------------------------------------------------------------ */

/**
 * ざぐり・皿もみの断りの文言(FR-504、NFR-UX-5)。
 *
 * **同じ検査がカーネル(`packages/kernel/src/occt/makeHole.ts` の `checkHoleEntry`)にもある。**
 * model が先に断るので利用者が見るのはここの文言だけだが、片方だけ直すと理由が食い違うため
 * **文言は 1 字も違えずに揃える**(基本形状・罫線面の断りと同じ扱い)。
 * model 側で先に断るのは、重い OCCT の呼び出しの前にツリーへ理由を出すためである。
 */
const COUNTERBORE_DIAMETER_MESSAGE = 'ざぐりの径は穴の径より大きくしてください。';
const COUNTERBORE_DEPTH_MESSAGE = 'ざぐりの深さは 0 より大きい数にしてください。';
const COUNTERSINK_ANGLE_MESSAGE = '皿もみの角度は 0 度より大きく 180 度未満にしてください。';
const COUNTERSINK_DIAMETER_MESSAGE = '皿もみの頭の径は穴の径より大きくしてください。';

/** 皿もみの開き角の上限(度、含まない)。180 度では円錐が平らになり深さ 0 になる。 */
const MAX_COUNTERSINK_DEGREES = 180;

type HoleEntryOutcome =
  | { readonly ok: true; readonly entry: HoleEntryPlan | null }
  | { readonly ok: false; readonly error: PartError };

/**
 * 穴の入口の形(FR-422)を段の欄へ直す(§0.a-0.39、タスク46)。
 *
 * - `plain`(広げない)は **null** を返し、段へ欄そのものを載せない(省略と同じ鍵にする)。
 * - `counterbore` は径と深さをそのまま。**径は下穴の径より大きい**こと(先出し検査)。
 * - `countersink` は角度を**度からラジアンへ**直す。**円錐の深さは計算しない**——
 *   `(頭径 − 穴の径) / 2 / tan(角度 / 2)` はカーネルが導く(統括の決定 2026-09-05 17:37)。
 *
 * `drillDiameter` は「入口を広げるもとの穴の径」で、穴では直径、ねじ穴では下穴径になる。
 * 見る順(角度 → 頭径)はカーネルの `checkHoleEntry` と同じにしてある——深さの式が角度の
 * 正しさに乗っているためで、同じ入力から必ず同じ理由が出るようにする。
 */
function resolveHoleEntry(
  featureId: string,
  entry: HoleEntry,
  drillDiameter: number,
): HoleEntryOutcome {
  switch (entry.kind) {
    case 'plain':
      return { ok: true, entry: null };
    case 'counterbore': {
      const diameter = entry.diameter.value;
      if (!Number.isFinite(diameter) || diameter <= drillDiameter) {
        return {
          ok: false,
          error: partError(featureId, 'invalidValue', COUNTERBORE_DIAMETER_MESSAGE),
        };
      }
      const depth = entry.depth.value;
      if (!isPositiveFinite(depth)) {
        return {
          ok: false,
          error: partError(featureId, 'invalidValue', COUNTERBORE_DEPTH_MESSAGE),
        };
      }
      return { ok: true, entry: { kind: 'counterbore', diameter, depth } };
    }
    case 'countersink': {
      const angleDegrees = entry.angle.value;
      if (
        !Number.isFinite(angleDegrees) ||
        angleDegrees <= 0 ||
        angleDegrees >= MAX_COUNTERSINK_DEGREES
      ) {
        return {
          ok: false,
          error: partError(featureId, 'invalidValue', COUNTERSINK_ANGLE_MESSAGE),
        };
      }
      const diameter = entry.diameter.value;
      if (!Number.isFinite(diameter) || diameter <= drillDiameter) {
        return {
          ok: false,
          error: partError(featureId, 'invalidValue', COUNTERSINK_DIAMETER_MESSAGE),
        };
      }
      return {
        ok: true,
        entry: { kind: 'countersink', diameter, angle: degreesToRadians(angleDegrees) },
      };
    }
  }
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
  // 入口の形(FR-422、タスク46)。省略された欄は `holeEntryOf` が既定で埋める。
  const entry = resolveHoleEntry(feature.id, holeEntryOf(feature), diameter);
  if (!entry.ok) {
    return entry;
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
      // 広げないときは欄そのものを載せない(省略と「広げない」を同じ鍵にするため)。
      ...(entry.entry === null ? {} : { entry: entry.entry }),
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
  // 入口の形(FR-422)。比べる相手は**下穴の径**(ざぐり・皿もみは下穴を広げるため)で、
  // 値の検査は穴とまったく同じ口を通す。カーネルの段(`ThreadStepSpec`)が `entry` を
  // 受け取れるようになった(42c)ので、穴とまったく同じ形で段へ載せる。
  const entry = resolveHoleEntry(feature.id, holeEntryOf(feature), drillDiameter);
  if (!entry.ok) {
    return entry;
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
      // 広げないときは欄そのものを載せない(省略と「広げない」を同じ段・同じ鍵にするため)。
      ...(entry.entry === null ? {} : { entry: entry.entry }),
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
  /*
    半径(FR-407)と可変半径(FR-426、§0.a-0.48、タスク46)。省略できる欄は必ず
    `filletRadiusOf` を通して読む(既定は `createPartDocument.ts` の 1 か所)。
    **可変でも始点と終点の両方が 0 より大きい**ことを先に確かめる(カーネルの
    `makeVariableFillet.ts` は `Add_3(0, r)` も成功させてしまうので入口で断る、タスク53)。
    始点と終点が同じ値のときも `{ start; end }` のまま渡す——カーネルの実測で
    「始点 = 終点は一定半径と 1e-6 一致」が固定されており(2026-09-05 16:13)、
    ここで数 1 つへ畳むと利用者が入れた「可変」の指定が段の形から消えてしまうためである。
  */
  const radiusInput = filletRadiusOf(feature);
  if (radiusInput.kind === 'constant') {
    const radius = radiusInput.radius.value;
    if (!isPositiveFinite(radius)) {
      return fail(feature.id, 'invalidValue', '丸める半径は 0 より大きい数にしてください。');
    }
    return {
      ok: true,
      plan: { kind: 'fillet', targetKey: target.targetKey, targets, radius },
    };
  }
  const start = radiusInput.start.value;
  const end = radiusInput.end.value;
  if (!isPositiveFinite(start) || !isPositiveFinite(end)) {
    return fail(feature.id, 'invalidValue', '丸める半径は 0 より大きい数にしてください。');
  }
  return {
    ok: true,
    plan: { kind: 'fillet', targetKey: target.targetKey, targets, radius: { start, end } },
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
 *
 * P5(FR-429、タスク16)で基本形状の基準点(`SolidOrigin.sketchPoint`)からも呼ぶ。
 * 「スケッチの点フィーチャーを1つ引く」という同じ仕事なので、同じものを2つ作らない
 * (断りの文言だけが呼び出し側で違う)。
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

/** 点集合パターン(FR-425)で点が 1 つも選ばれていない。 */
const POINT_PATTERN_EMPTY_MESSAGE =
  '並べる点が選ばれていません。スケッチで点を作ってから選び直してください。';
/** 点集合パターンの点が引けない(消された・上流が失敗した・履歴の順序が合わない)。 */
const POINT_PATTERN_MISSING_MESSAGE =
  '並べる点が見つかりません。スケッチで点を作ってからやり直してください。';

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
  point: (reference: PointReference) => Vec3 | null = () => null,
):
  | { readonly ok: true; readonly transforms: readonly RigidTransform[] }
  | { readonly ok: false; readonly code: PartErrorCode; readonly message: string } {
  if (placement.kind === 'points') {
    /*
      点の集まりへ複製(FR-425、P5 §0.a-0.42、タスク46)。

      **点の一覧がそのまま置き場所になる。** 直線・円形が「もとを含めた総数」を持ち
      もとの位置ぶんの変換を作らない(n−1 個)のと違い、点集合は利用者が「並べたい場所を
      全部書く」ものなので、**点の数だけ変換を作る**(n 個)。**基準は最初の点**で、
      最初の変換は必ず恒等になる——もとの工具は最初の点の位置で作られている前提だからで、
      基準を重心などにすると、点を 1 つ足すたびに既にある穴が全部動いてしまう。

      点の解決(座標の式・スケッチの点・立体の頂点・球面上の点)は `PointReference` の
      正本(`resolveReferences.ts` の `point`)を関数のまま受け取る。ここへ写すと同じ規約が
      2 か所になるためである(`SolidPlanContext` の注釈と同じ理由)。
    */
    if (placement.points.length === 0) {
      return { ok: false, code: 'missingProfile', message: POINT_PATTERN_EMPTY_MESSAGE };
    }
    const positions: Vec3[] = [];
    for (const reference of placement.points) {
      const resolved = point(reference);
      if (resolved === null) {
        return { ok: false, code: 'missingProfile', message: POINT_PATTERN_MISSING_MESSAGE };
      }
      positions.push(resolved);
    }
    const base = positions[0] ?? ORIGIN;
    return {
      ok: true,
      transforms: positions.map((position) => ({
        // 最初の点は自分自身との差なので恒等(平行移動 0)になる。
        translation: cleanZeroVec3(subVec3(position, base)),
        rotationOrigin: ORIGIN,
        // 回さないので軸は世界の Z にして角 0(移動/回転の段と同じ約束)。
        rotationAxis: WORLD_AXIS_DIRECTIONS.z,
        rotationAngle: 0,
      })),
    };
  }
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
  context: SolidPlanContext,
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
  const transformsOutcome = resolvePatternTransforms(
    feature.placement,
    sketches,
    context.axisFrames,
    context.point,
  );
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

/* ------------------------------------------------------------------ *
 * 基本形状(FR-429、P5 §2.7、タスク16)
 * ------------------------------------------------------------------ */

/**
 * 部品文書の側で座標の式を解くときの手掛かり。
 *
 * 部品文書には作図面もスケッチの履歴も無いので、極座標の基準は XY 平面と決め(決定性)、
 * 点・端点の表は空にする(P4 の `resolveReferences.ts` の `pointFromDefinition` と
 * まったく同じ決め方。同じ規約を2通りに分けない)。この結果、
 *   - 絶対座標(`mode: 'absolute'`)は常に解ける
 *   - ずれ・極座標は基準が「原点」か「立体の部分形状」のときに解ける
 *   - 基準が「直前の点」「スケッチの点」「要素の端点」のときは断る(部品には無い概念)
 * となる。基本形状の中心を UI が作るときは絶対座標なので(`defaultPrimitiveOrigin`)、
 * ふだんは 1 つ目の道だけを通る。
 *
 * **`subShape`(いまの形での選び直し)は渡さない。** 渡さないと `resolveCoordinate` は
 * 保存された指紋の位置をそのまま使う。上流の立体に追従させたい基準点は
 * `SolidOrigin.vertex`(`originQuery` でカーネルが選び直す)で表すのが正しい道で、
 * 座標の式の基準を二重の追従の口にしない。
 */
const PART_COORDINATE_CONTEXT: ResolveContext = {
  plane: WORK_PLANES.xy,
  points: [],
  previous: null,
  vertices: new Map<string, Vec3>(),
};

/**
 * 基本形状の断りの文言(FR-429、FR-504、§2.7.1 の「断りの条件」)。
 *
 * **同じ検査がカーネル(`packages/kernel/src/occt/makePrimitive.ts`)にもある。**
 * model が先に断るので利用者が見るのはここの文言だけだが、片方だけ直すと理由が食い違うため
 * **文言は 1 字も違えずに揃える**(ばねの「ピッチは線径より…」が model と kernel の
 * 2 か所にあるのと同じ扱い。統括の決定 2026-09-05「model の文言を採る」)。
 * model 側で先に断るのは、重い OCCT の呼び出しの前にツリーへ理由を出すため(NFR-UX-5)。
 */
const PRIMITIVE_CONE_RADIUS_NEGATIVE_MESSAGE = '円錐の半径は 0 以上にしてください。';
const PRIMITIVE_CONE_RADIUS_BOTH_ZERO_MESSAGE =
  '円錐の半径は、どちらか一方を 0 より大きくしてください。';
/** 上下の半径が同じ円錐は OCCT が作れない(実測。makePrimitive.ts の注釈)ので円柱を促す。 */
const PRIMITIVE_CONE_RADIUS_SAME_MESSAGE = '円錐の上下の半径が同じです。円柱を使ってください。';
/** 管が中心の穴を食いつぶして自己交差する。 */
const PRIMITIVE_TORUS_MINOR_TOO_LARGE_MESSAGE =
  'トーラスの管の半径は、中心までの半径より小さくしてください。';
/** 中心にしたスケッチの点が消えた・見つからない(§2.7.1 の断り方の表)。 */
const MISSING_PRIMITIVE_POINT_MESSAGE = '中心にする点が見つかりません。点を選び直してください。';
/**
 * 中心にした頂点を持つ立体が引けない(未作成・抑制中・上流が失敗・履歴から消えた)。
 * 語尾はカーネルの `MISSING_PRIMITIVE_VERTEX_MESSAGE` と揃えてある(利用者から見れば
 * 「頂点が見つからない」という同じ出来事で、model と kernel のどちらが先に気づいたかは
 * 見せる理由に関係しないため)。
 */
const MISSING_PRIMITIVE_VERTEX_MESSAGE =
  '中心にする頂点が見つかりません。形が大きく変わったため、選び直してください。';
/** 面・辺を中心に選ぼうとした。FR-429 が中心にできるとしているのは頂点だけ。 */
const PRIMITIVE_ORIGIN_NOT_VERTEX_MESSAGE = '中心にできるのは立体の頂点だけです。頂点を選び直してください。';
/** 向き(軸)が解決できない。ばね・パターンの言い回しに揃える。 */
const MISSING_PRIMITIVE_AXIS_MESSAGE =
  '向きにする線分が見つかりません。スケッチで線分をかいてから選び直してください。';

/** 「〜は 0 より大きい数にしてください。」(欄の名前を差し込む。kernel の positiveMessage と同文)。 */
function positiveFieldMessage(fieldName: string): string {
  return `${fieldName}は 0 より大きい数にしてください。`;
}

/** 解決済みの基本形状の寸法(mm)。段の型からそのまま借りる(ChamferSizePlan と同じ書き方)。 */
export type PrimitiveShapePlan = Extract<SolidStepPlan, { kind: 'primitive' }>['shape'];

type PrimitiveShapeOutcome =
  | { readonly ok: true; readonly shape: PrimitiveShapePlan }
  | { readonly ok: false; readonly message: string };

/**
 * 基本形状の寸法を式から解決し、範囲を確かめる(§2.7.1 の表)。
 *
 * 見る順は `makePrimitive.ts` の `checkShapeSpec` と同じにしてある(同じ入力からは
 * 必ず同じ理由が出るようにするため)。円錐だけは半径 0 を許す(上半径 0 で尖るため、
 * §0.a-0.16)ので「0 以上」で見て、両方 0・上下同径を別の理由で断る。
 */
function resolvePrimitiveShape(shape: PrimitiveShape): PrimitiveShapeOutcome {
  switch (shape.kind) {
    case 'sphere': {
      const radius = shape.radius.value;
      if (!isPositiveFinite(radius)) {
        return { ok: false, message: positiveFieldMessage('半径') };
      }
      return { ok: true, shape: { kind: 'sphere', radius } };
    }
    case 'box': {
      const sizeX = shape.sizeX.value;
      const sizeY = shape.sizeY.value;
      const sizeZ = shape.sizeZ.value;
      if (!isPositiveFinite(sizeX)) {
        return { ok: false, message: positiveFieldMessage('X の長さ') };
      }
      if (!isPositiveFinite(sizeY)) {
        return { ok: false, message: positiveFieldMessage('Y の長さ') };
      }
      if (!isPositiveFinite(sizeZ)) {
        return { ok: false, message: positiveFieldMessage('Z の長さ') };
      }
      return { ok: true, shape: { kind: 'box', sizeX, sizeY, sizeZ } };
    }
    case 'cylinder': {
      const radius = shape.radius.value;
      const height = shape.height.value;
      if (!isPositiveFinite(radius)) {
        return { ok: false, message: positiveFieldMessage('半径') };
      }
      if (!isPositiveFinite(height)) {
        return { ok: false, message: positiveFieldMessage('高さ') };
      }
      return { ok: true, shape: { kind: 'cylinder', radius, height } };
    }
    case 'cone': {
      const bottomRadius = shape.bottomRadius.value;
      const topRadius = shape.topRadius.value;
      const height = shape.height.value;
      if (!isPositiveFinite(height)) {
        return { ok: false, message: positiveFieldMessage('高さ') };
      }
      // 非数は「0 以上か」を判定できないので、負と同じ理由で断る(kernel と同じ順)。
      if (!Number.isFinite(bottomRadius) || bottomRadius < 0) {
        return { ok: false, message: PRIMITIVE_CONE_RADIUS_NEGATIVE_MESSAGE };
      }
      if (!Number.isFinite(topRadius) || topRadius < 0) {
        return { ok: false, message: PRIMITIVE_CONE_RADIUS_NEGATIVE_MESSAGE };
      }
      if (bottomRadius <= 0 && topRadius <= 0) {
        return { ok: false, message: PRIMITIVE_CONE_RADIUS_BOTH_ZERO_MESSAGE };
      }
      if (bottomRadius === topRadius) {
        return { ok: false, message: PRIMITIVE_CONE_RADIUS_SAME_MESSAGE };
      }
      return { ok: true, shape: { kind: 'cone', bottomRadius, topRadius, height } };
    }
    case 'torus': {
      const majorRadius = shape.majorRadius.value;
      const minorRadius = shape.minorRadius.value;
      if (!isPositiveFinite(majorRadius)) {
        return { ok: false, message: positiveFieldMessage('主半径') };
      }
      if (!isPositiveFinite(minorRadius)) {
        return { ok: false, message: positiveFieldMessage('管の半径') };
      }
      if (minorRadius >= majorRadius) {
        return { ok: false, message: PRIMITIVE_TORUS_MINOR_TOO_LARGE_MESSAGE };
      }
      return { ok: true, shape: { kind: 'torus', majorRadius, minorRadius } };
    }
  }
}

/** 基準点の解決結果。段へ乗せる3つの欄(位置・頂点の指紋・上流の鍵)をそのまま持つ。 */
interface SolidOriginPlan {
  /** 基準点(mm)。`query` があるときは頂点からのずれなので `[0,0,0]`。 */
  readonly origin: Vec3;
  readonly query: SubShapeQueryPlan | null;
  readonly targetKey: string | null;
}

export type SolidOriginOutcome =
  | { readonly ok: true; readonly value: SolidOriginPlan }
  | { readonly ok: false; readonly error: PartError };

/**
 * 立体の基準点を解決する(FR-429 の3通り、§2.7.1、§0.a-0.18)。
 *
 * - 座標の式 … `resolveCoordinate`(スケッチ側の正本)を再利用して世界座標にする。
 * - スケッチの点 … 解決済みのスケッチから点を引いて世界座標にする。
 * - 立体の頂点 … **ここでは解決しない。** 指紋(`query`)と、その頂点を持つ立体の段の鍵
 *   (`targetKey`)を段へ乗せ、頂点の選び直しはカーネルが行う(穴の面と同じ扱い、§2.2)。
 *   model は面・辺・頂点の位置を持たないので、ここで解こうとしても解けない。
 *
 * **頂点を借りても対象は消費しない**(§0.a-0.19)。`targetKey` を持つのは鍵を連鎖させる
 * ためだけで、消費の記録(`consumedTargetsOf`)には現れない。鍵に混ぜないと、上流を
 * 伸ばして頂点が動いても鍵が変わらず古い形がキャッシュから返る(cacheKey.ts の注釈)。
 */
export function resolveSolidOrigin(
  featureId: string,
  origin: SolidOrigin,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
): SolidOriginOutcome {
  switch (origin.kind) {
    case 'coordinate': {
      const resolved = resolveCoordinate(origin.value, PART_COORDINATE_CONTEXT, featureId);
      if (!resolved.ok) {
        // 式のエラー(値が数でない・基準が無い)をそのまま見せる(§2.7.1 の断り方の表)。
        return { ok: false, error: partError(featureId, 'invalidValue', resolved.error.message) };
      }
      return { ok: true, value: { origin: resolved.value, query: null, targetKey: null } };
    }
    case 'sketchPoint': {
      // 点の引き方はばねの始点とまったく同じ(点列を指していれば先頭の1点)。
      const point = resolveSpringOrigin(origin.ref, sketches);
      if (point === null) {
        return {
          ok: false,
          error: partError(featureId, 'missingProfile', MISSING_PRIMITIVE_POINT_MESSAGE),
        };
      }
      return { ok: true, value: { origin: point, query: null, targetKey: null } };
    }
    case 'vertex': {
      // 参照の型(SubShapeRef)は面・辺も表せるので、頂点であることをここで確かめる
      // (カーネルも断るが、OCCT を呼ぶ前に赤くする。穴の「面だけ」と同じ守り)。
      if (subShapeKindOf(origin.ref) !== 'vertex') {
        return {
          ok: false,
          error: partError(featureId, 'invalidValue', PRIMITIVE_ORIGIN_NOT_VERTEX_MESSAGE),
        };
      }
      const targetKey = bodyKeys.get(origin.ref.bodyFeatureId);
      if (targetKey === undefined) {
        return {
          ok: false,
          error: partError(featureId, 'missingSubShape', MISSING_PRIMITIVE_VERTEX_MESSAGE),
        };
      }
      // ずれの欄はまだ無いので、頂点そのものを指す `[0,0,0]` を渡す(段の型の注釈)。
      return { ok: true, value: { origin: ORIGIN, query: origin.ref, targetKey } };
    }
  }
}

/**
 * 基本形状(FR-429、§2.7)。対象を取らず、新しいボディを1つ作る(§0.a-0.19)。
 *
 * 解決の順は 基準点 → 向き(軸)→ 寸法。どの段階で断っても、それより後ろは見ない
 * (ばね `planSpring` と同じ組み立て方)。**寸法の範囲はここで先に断る**ので、
 * 画面は実行前に赤くできる(NFR-UX-5)。
 */
function planPrimitive(
  feature: PrimitiveFeature,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  axisFrames: ReadonlyMap<string, AxisFrame>,
): PlanOutcome {
  const origin = resolveSolidOrigin(feature.id, feature.origin, sketches, bodyKeys);
  if (!origin.ok) {
    return origin;
  }
  // 向きは回転軸(FR-402)と同じ `AxisSpec` を流用する(§0.a-0.16。同じものを2つ作らない)。
  const axisFrame = resolveRevolveAxis(feature.axis, sketches, axisFrames);
  if (axisFrame === null) {
    return fail(feature.id, 'missingProfile', MISSING_PRIMITIVE_AXIS_MESSAGE);
  }
  const shape = resolvePrimitiveShape(feature.shape);
  if (!shape.ok) {
    return fail(feature.id, 'invalidValue', shape.message);
  }
  return {
    ok: true,
    plan: {
      kind: 'primitive',
      origin: origin.value.origin,
      // 軸の原点は使わない(基準点は上で決めた)。向きだけを取り、-0 を +0 へ揃える
      // (ばねの向きと同じ後始末。negateVec3 の注釈を参照)。
      axis: cleanZeroVec3(axisFrame.direction),
      shape: shape.shape,
      originQuery: origin.value.query,
      targetKey: origin.value.targetKey,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 面をつなぐ(罫線面 FR-430)・ロフト(FR-410)。P5 §2.9、タスク25
 * ------------------------------------------------------------------ */

/** つなぐには断面が 2 つ要る(§2.9.1)。ロフトも下限は同じ。 */
const MIN_THRU_SECTIONS = 2;

/**
 * 断りの文言(FR-504、NFR-UX-5)。カーネル(`makeThruSections.ts`)にも同じ状況の断りが
 * あるものは**文言をそろえてある**(基本形状の断りと同じ扱い。片方だけ直すと理由が食い違う)。
 */
const THRU_SECTIONS_TOO_FEW_MESSAGE = 'つなぐ面を 2 つ選んでください。';
const THRU_SECTIONS_MISSING_FACE_MESSAGE =
  'つなぐもとの面が見つかりません。スケッチで面を張ってからやり直してください。';
const THRU_SECTIONS_MISSING_SPHERE_MESSAGE =
  'つなぐもとの球が見つかりません。球を選び直してください。';
/** 球は縁を持たないので、球どうしを結ぶ直線が決まらない(§2.9.3)。 */
const THRU_SECTIONS_TWO_SPHERES_MESSAGE = '球どうしを直線でつなぐことはできません。';
/** ロフトは球を扱わない(§2.9.3。球へつなぐのは罫線面だけ)。 */
const LOFT_SPHERE_MESSAGE = 'ロフトには球を使えません。「面をつなぐ」を使ってください。';
/** ねじれの補正は稜線を何本ずらすかなので、整数でないと意味が決まらない(§0.a-0.28)。 */
const THRU_SECTIONS_TWIST_MESSAGE = 'ねじれの補正は整数にしてください。';
/**
 * 中心を立体の頂点で決めた球(FR-429 の 3 通りのうちの 1 つ)は、まだ相手にできない。
 * 段へ渡せるのは中心の座標そのもの(`ThruSectionPlan.sphere.center`)で、頂点の選び直しは
 * カーネルの中でしか行えないため、model にはその時点の中心が無い。
 */
const THRU_SECTIONS_SPHERE_ORIGIN_MESSAGE =
  '中心を立体の頂点で決めた球は、まだ面をつなぐ相手にできません。球の中心を座標かスケッチの点で決めてください。';
/** 輪郭にできるのは面だけ(辺・頂点には外周が無い)。穴の「面だけ」と同じ守り。 */
const THRU_SECTIONS_NOT_FACE_MESSAGE = '輪郭にできるのは立体の面だけです。面を選び直してください。';
/** 面を持つ立体が引けない(未作成・抑制中・上流が失敗・履歴から消えた)。 */
const THRU_SECTIONS_MISSING_BODY_MESSAGE =
  'つなぐもとの立体が見つかりません。立体を選び直してください。';

type ThruSectionOutcome =
  | { readonly ok: true; readonly section: ThruSectionPlan }
  | { readonly ok: false; readonly error: PartError };

/**
 * 断面に指した球(`kind: 'primitive'` の球、FR-429)を中心と半径に直す(§2.9.3)。
 *
 * 引き方は球面上の点(FR-431、タスク19b の `sphereAt`)とまったく同じにしてある
 * (同じ規則を 2 通りに書かない)。中心は `resolveSolidOrigin`、半径は `shape.radius.value`。
 */
function resolveSphereSection(
  featureId: string,
  sphereFeatureId: string,
  solids: readonly SolidFeature[],
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
): ThruSectionOutcome {
  const sphere = solids.find((candidate) => candidate.id === sphereFeatureId);
  if (
    sphere === undefined ||
    sphere.kind !== 'primitive' ||
    sphere.shape.kind !== 'sphere' ||
    // 抑制した球は画面に無いので、つなぐ相手にもできない(タスク19b の球面上の点と同じ)。
    sphere.suppressed
  ) {
    return {
      ok: false,
      error: partError(featureId, 'missingProfile', THRU_SECTIONS_MISSING_SPHERE_MESSAGE),
    };
  }
  const radius = sphere.shape.radius.value;
  if (!isPositiveFinite(radius)) {
    return {
      ok: false,
      error: partError(featureId, 'invalidValue', positiveFieldMessage('半径')),
    };
  }
  const origin = resolveSolidOrigin(featureId, sphere.origin, sketches, bodyKeys);
  if (!origin.ok) {
    return origin;
  }
  if (origin.value.query !== null) {
    return {
      ok: false,
      error: partError(featureId, 'invalidValue', THRU_SECTIONS_SPHERE_ORIGIN_MESSAGE),
    };
  }
  return { ok: true, section: { kind: 'sphere', center: origin.value.origin, radius } };
}

/**
 * 断面 1 つを解決する(§2.9.1)。
 *
 * - スケッチの面 … 解決済みの輪郭(`ResolvedCurve`)をそのまま段へ乗せる。
 * - 球 … 中心と半径へ直す(上の `resolveSphereSection`)。
 * - 立体の面 … **カーネルが選び直してから輪郭を取り出す**(§0.a-0.73、タスク24b)。
 */
function resolveRuledSection(
  featureId: string,
  section: RuledSection,
  solids: readonly SolidFeature[],
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
): ThruSectionOutcome {
  switch (section.kind) {
    case 'sketchFace': {
      const face = findResolvedFace(sketches, section.ref);
      if (face === undefined) {
        return {
          ok: false,
          error: partError(featureId, 'missingProfile', THRU_SECTIONS_MISSING_FACE_MESSAGE),
        };
      }
      return { ok: true, section: { kind: 'curves', curves: face.curves } };
    }
    case 'sphere':
      return resolveSphereSection(featureId, section.sphereFeatureId, solids, sketches, bodyKeys);
    case 'solidFace': {
      /*
        立体の面(§0.a-0.73、タスク24b)。**輪郭へは直さず、指紋のまま段へ乗せる。**
        面を選び直せるのはカーネルだけ(model は面の位置も外周も持たない)で、穴・面取りの
        面とまったく同じ扱いである(§2.2.4)。参照の型は辺・頂点も表せるので、面であることを
        ここで先に確かめる(カーネルも断るが、OCCT を呼ぶ前に赤くする。NFR-UX-5)。
      */
      if (subShapeKindOf(section.ref) !== 'face') {
        return {
          ok: false,
          error: partError(featureId, 'invalidValue', THRU_SECTIONS_NOT_FACE_MESSAGE),
        };
      }
      const targetKey = bodyKeys.get(section.ref.bodyFeatureId);
      if (targetKey === undefined) {
        return {
          ok: false,
          error: partError(featureId, 'missingBody', THRU_SECTIONS_MISSING_BODY_MESSAGE),
        };
      }
      // **消費しない**(§0.a-0.27)ので `consumed` は見ない。鍵に混ぜるのは鍵の連鎖のため。
      return { ok: true, section: { kind: 'faceQuery', targetKey, query: section.ref } };
    }
  }
}

/** ねじれの補正(§0.a-0.28)。小数は切り捨てずに断る(統括の決定)。 */
function resolveThruSectionsTwist(
  featureId: string,
  twist: ExpressionValue,
): { readonly ok: true; readonly twist: number } | { readonly ok: false; readonly error: PartError } {
  const value = twist.value;
  if (!Number.isInteger(value)) {
    return {
      ok: false,
      error: partError(featureId, 'invalidValue', THRU_SECTIONS_TWIST_MESSAGE),
    };
  }
  return { ok: true, twist: value };
}

/** 断面の並びをまとめて解決する。1 つでも解けなければその理由で断る(FR-504)。 */
function resolveRuledSections(
  featureId: string,
  sections: readonly RuledSection[],
  solids: readonly SolidFeature[],
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
):
  | { readonly ok: true; readonly sections: readonly ThruSectionPlan[] }
  | { readonly ok: false; readonly error: PartError } {
  const resolved: ThruSectionPlan[] = [];
  for (const section of sections) {
    const outcome = resolveRuledSection(featureId, section, solids, sketches, bodyKeys);
    if (!outcome.ok) {
      return outcome;
    }
    resolved.push(outcome.section);
  }
  return { ok: true, sections: resolved };
}

/**
 * 面をつなぐ(罫線面、FR-430、§2.9)。2 つの断面を直線で結ぶ。
 *
 * **対象を消費しない**(§0.a-0.27)ので `consumed` を見ない。輪郭を貸した立体・球は
 * そのまま画面に残り、要るなら和(FR-404)でまとめられる。
 */
function planRuled(
  feature: RuledFeature,
  solids: readonly SolidFeature[],
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
): PlanOutcome {
  if (feature.first.kind === 'sphere' && feature.second.kind === 'sphere') {
    return fail(feature.id, 'degenerate', THRU_SECTIONS_TWO_SPHERES_MESSAGE);
  }
  const sections = resolveRuledSections(
    feature.id,
    [feature.first, feature.second],
    solids,
    sketches,
    bodyKeys,
  );
  if (!sections.ok) {
    return sections;
  }
  const twist = resolveThruSectionsTwist(feature.id, feature.twist);
  if (!twist.ok) {
    return twist;
  }
  return {
    ok: true,
    plan: {
      kind: 'thruSections',
      sections: sections.sections,
      // 直線で結ぶ(罫線面)。ロフトとの違いはこの 1 つだけ(§0.a-0.25)。
      ruled: true,
      closed: true,
      twist: twist.twist,
      sphereSegments: feature.sphereSegments,
    },
  };
}

/**
 * ロフト(FR-410、§2.9)。2 つ以上の断面をなめらかに結ぶ。
 * 球は置けない(§2.9.3)ので、指されていたら理由を出して断る。
 */
function planLoft(
  feature: LoftFeature,
  solids: readonly SolidFeature[],
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
): PlanOutcome {
  if (feature.sections.length < MIN_THRU_SECTIONS) {
    return fail(feature.id, 'missingProfile', THRU_SECTIONS_TOO_FEW_MESSAGE);
  }
  if (feature.sections.some((section) => section.kind === 'sphere')) {
    return fail(feature.id, 'degenerate', LOFT_SPHERE_MESSAGE);
  }
  const sections = resolveRuledSections(
    feature.id,
    feature.sections,
    solids,
    sketches,
    bodyKeys,
  );
  if (!sections.ok) {
    return sections;
  }
  const twist = resolveThruSectionsTwist(feature.id, feature.twist);
  if (!twist.ok) {
    return twist;
  }
  return {
    ok: true,
    plan: {
      kind: 'thruSections',
      sections: sections.sections,
      ruled: false,
      closed: true,
      twist: twist.twist,
      // ロフトには球を置けないので形には効かないが、段の欄は種類で出し分けずに既定を入れる。
      sphereSegments: DEFAULT_RULED_SPHERE_SEGMENTS,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 抜き勾配・ミラー・移動/回転・拡大縮小(FR-417、FR-419、FR-424)。P5 §2.11、タスク45
 * ------------------------------------------------------------------ */

/** 傾ける面・中立面に面でないもの(辺・頂点)を選んだ。穴の「面だけ」と同じ守り。 */
const DRAFT_NOT_FACE_MESSAGE = '傾けられるのは面だけです。面を選び直してください。';
/** 中立面が平らでない。抜き方向は中立面の法線で決まるので、平らでないと向きが定まらない。 */
const DRAFT_NEUTRAL_NOT_FLAT_MESSAGE =
  '基準にする面は平らな面にしてください。平らな面を選び直してください。';
/** 別のボディの面を指した(穴の同じ守りと同じ理由。カーネルは対象の中から選び直す)。 */
const DRAFT_OTHER_BODY_MESSAGE = '傾ける面は、加工するもとの立体の面にしてください。';

/**
 * 抜き勾配(FR-417、§2.11)。対象のボディを消費して 1 つの新しいボディを作る。
 *
 * 面の選び直しはカーネルが行う(model は指紋を渡すだけ、§2.2)。ここで確かめるのは
 * 「面を指しているか」「対象の立体の面か」「角度が範囲の中か」の 3 つで、どれも
 * OCCT を呼ぶ前に赤くできる(NFR-UX-5)。
 */
function planDraft(
  feature: DraftFeature,
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
  context: SolidPlanContext,
): PlanOutcome {
  const target = resolveMachiningTarget(feature.id, feature.targetFeatureId, bodyKeys, consumed);
  if (!target.ok) {
    return target;
  }
  // 重複を除いて通し番号の昇順にする(R 面取りと同じ。同じ面の組なら必ず同じ鍵になる)。
  const faces = sortedUniqueTargets(feature.faces);
  if (faces.length === 0) {
    return fail(feature.id, 'missingSubShape', MISSING_SUB_SHAPE_MESSAGE);
  }
  for (const face of [...faces, feature.neutralFace]) {
    if (subShapeKindOf(face) !== 'face') {
      return fail(feature.id, 'invalidValue', DRAFT_NOT_FACE_MESSAGE);
    }
    if (face.bodyFeatureId !== feature.targetFeatureId) {
      return fail(feature.id, 'invalidValue', DRAFT_OTHER_BODY_MESSAGE);
    }
  }
  // 中立面だけは平らでなければならない(types.ts の `neutralFace` の注釈、タスク34 の実測)。
  const neutral = context.subShape(feature.neutralFace);
  if (neutral !== null && (neutral.surfaceKind !== 'plane' || neutral.axis === null)) {
    return fail(feature.id, 'degenerate', DRAFT_NEUTRAL_NOT_FLAT_MESSAGE);
  }
  const angleDegrees = feature.angle.value;
  if (
    !Number.isFinite(angleDegrees) ||
    angleDegrees <= 0 ||
    angleDegrees > MAX_DRAFT_ANGLE_DEGREES
  ) {
    return fail(feature.id, 'invalidValue', '抜き勾配の角度は 0 より大きく 60 度以下にしてください。');
  }
  return {
    ok: true,
    plan: {
      kind: 'draft',
      targetKey: target.targetKey,
      faces,
      neutralFace: feature.neutralFace,
      angle: degreesToRadians(angleDegrees),
      reversed: feature.reversed,
    },
  };
}

/** 鏡に映すもとの立体が引けない(未作成・抑制中・上流が失敗・履歴から消えた)。 */
const MIRROR_MISSING_BODY_MESSAGE = '鏡に映すもとの立体が見つかりません。立体を選び直してください。';
/** 鏡にする作業平面が引けない(任意の作業平面が消された・解決に失敗した)。 */
const MIRROR_MISSING_PLANE_MESSAGE = '鏡にする平面が見つかりません。平面を選び直してください。';
/** 鏡にできるのは面だけ(辺・頂点は平面を決めない)。 */
const MIRROR_NOT_FACE_MESSAGE = '鏡にできるのは立体の平らな面だけです。面を選び直してください。';
/** 曲面は鏡にならない(法線が場所によって変わる)。 */
const MIRROR_NOT_FLAT_MESSAGE = '鏡にできるのは平らな面だけです。平らな面を選び直してください。';

type MirrorPlaneOutcome =
  | { readonly ok: true; readonly origin: Vec3; readonly normal: Vec3 }
  | { readonly ok: false; readonly error: PartError };

/**
 * ミラーの鏡にする平面(FR-419、§0.a-0.36)を「通る点+単位法線」へ直す。
 *
 * 基準の 3 面と任意の作業平面(FR-328)は同じ `workPlane`(P4 タスク9 の解決結果)から、
 * 立体の平らな面は面の指紋(または選び直し)から取る。どちらも既にある仕組みを呼ぶだけで、
 * 平面の作り方をここへ写さない。
 */
function resolveMirrorPlane(
  featureId: string,
  plane: MirrorPlane,
  context: SolidPlanContext,
): MirrorPlaneOutcome {
  if (plane.kind === 'workPlane') {
    const resolved = context.workPlane(plane.planeId);
    if (resolved === null) {
      return {
        ok: false,
        error: partError(featureId, 'missingProfile', MIRROR_MISSING_PLANE_MESSAGE),
      };
    }
    return { ok: true, origin: resolved.origin, normal: cleanZeroVec3(resolved.normal) };
  }
  if (subShapeKindOf(plane.face) !== 'face') {
    return { ok: false, error: partError(featureId, 'invalidValue', MIRROR_NOT_FACE_MESSAGE) };
  }
  const resolved = context.subShape(plane.face);
  if (resolved === null) {
    return {
      ok: false,
      error: partError(featureId, 'missingSubShape', MIRROR_NOT_FACE_MESSAGE),
    };
  }
  if (resolved.surfaceKind !== 'plane' || resolved.axis === null) {
    return { ok: false, error: partError(featureId, 'degenerate', MIRROR_NOT_FLAT_MESSAGE) };
  }
  return {
    ok: true,
    origin: resolved.position,
    normal: cleanZeroVec3(normalizeVec3(resolved.axis)),
  };
}

/**
 * ミラー(FR-419、§0.a-0.36)。平面に対する鏡像のボディを 1 つ作る。
 *
 * **対象を消費しない**ので `consumed` を見ない(罫線面の立体の面と同じ扱い、§0.a-0.27)。
 * 元と鏡像の両方が `liveBodyIds` に残り、要るなら和(FR-404)でまとめられる。
 * それでも `targetKey` は必ず持つ——元を編集したら鏡像も作り直すためである(NFR-PF-3)。
 */
function planMirror(
  feature: MirrorFeature,
  bodyKeys: ReadonlyMap<string, string>,
  context: SolidPlanContext,
): PlanOutcome {
  const targetKey = bodyKeys.get(feature.targetFeatureId);
  if (targetKey === undefined) {
    return fail(feature.id, 'missingBody', MIRROR_MISSING_BODY_MESSAGE);
  }
  const plane = resolveMirrorPlane(feature.id, feature.plane, context);
  if (!plane.ok) {
    return plane;
  }
  return {
    ok: true,
    plan: { kind: 'mirror', targetKey, origin: plane.origin, normal: plane.normal },
  };
}

/** 移動/回転の軸が引けない(回転軸・ばねの言い回しに揃える)。 */
const TRANSFORM_MISSING_AXIS_MESSAGE =
  '回転の軸にする線分が見つかりません。スケッチで線分をかいてから選び直してください。';

/**
 * 移動/回転(FR-424、§0.a-0.41)。対象を剛体変換したボディを 1 つ作る。**対象を消費する。**
 *
 * 回転軸は回転(FR-402)・パターン(FR-411)と同じ `AxisSpec` なので `resolveRevolveAxis` を
 * 再利用する(同じものを 2 つ作らない、§0.a-0.21)。軸が null なら平行移動だけで、
 * 段には恒等の回転(角 0)を入れる——kernel の `RigidTransformSpec` が軸の欄を必ず持つため。
 */
function planTransform(
  feature: TransformFeature,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
  context: SolidPlanContext,
): PlanOutcome {
  const target = resolveMachiningTarget(feature.id, feature.targetFeatureId, bodyKeys, consumed);
  if (!target.ok) {
    return target;
  }
  const translation = feature.translation.map((value) => value.value);
  if (!translation.every((value) => Number.isFinite(value))) {
    return fail(feature.id, 'invalidValue', '移動の量は数にしてください。');
  }
  const moved: Vec3 = cleanZeroVec3([translation[0], translation[1], translation[2]]);
  if (feature.rotationAxis === null) {
    // 回さないときも軸の欄は要る。向きは世界の Z にして角 0 を渡す(形は変わらない)。
    return {
      ok: true,
      plan: {
        kind: 'transform',
        targetKey: target.targetKey,
        translation: moved,
        rotationOrigin: ORIGIN,
        rotationAxis: WORLD_AXIS_DIRECTIONS.z,
        rotationAngle: 0,
      },
    };
  }
  const frame = resolveRevolveAxis(feature.rotationAxis, sketches, context.axisFrames);
  if (frame === null) {
    return fail(feature.id, 'missingProfile', TRANSFORM_MISSING_AXIS_MESSAGE);
  }
  const angleDegrees = feature.rotationAngle.value;
  if (!Number.isFinite(angleDegrees)) {
    return fail(feature.id, 'invalidValue', '回転の角度が数になっていません。');
  }
  return {
    ok: true,
    plan: {
      kind: 'transform',
      targetKey: target.targetKey,
      translation: moved,
      rotationOrigin: frame.origin,
      rotationAxis: cleanZeroVec3(frame.direction),
      rotationAngle: degreesToRadians(angleDegrees),
    },
  };
}

/** 拡大縮小の中心にする点が引けない(基本形状の中心の言い回しに揃える)。 */
const SCALE_MISSING_ORIGIN_MESSAGE = '拡大縮小の中心にする点が見つかりません。点を選び直してください。';
/** 倍率の断り 3 種(§2.11 の範囲 MIN_SCALE 〜 MAX_SCALE)。 */
const SCALE_NOT_POSITIVE_MESSAGE = '倍率は 0 より大きい数にしてください。';
const SCALE_TOO_SMALL_MESSAGE = '倍率は 0.001 以上にしてください。';
const SCALE_TOO_LARGE_MESSAGE = '倍率は 1000 以下にしてください。';

/** 倍率 1 つの範囲を確かめる。理由は 3 つに分ける(何を直せばよいかが分かるようにする)。 */
function checkScaleFactor(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return SCALE_NOT_POSITIVE_MESSAGE;
  }
  if (value < MIN_SCALE) {
    return SCALE_TOO_SMALL_MESSAGE;
  }
  if (value > MAX_SCALE) {
    return SCALE_TOO_LARGE_MESSAGE;
  }
  return null;
}

/**
 * 拡大縮小(FR-424、§0.a-0.41)。**対象を消費する。**
 *
 * **軸ごとの倍率が 3 つとも同じなら全体の倍率へ正規化する。** 倍率 2 の立方体は
 * `uniform: 2` でも `perAxis: [2,2,2]` でもまったく同じ形なので、正規化しないと
 * 同じ形に 2 つの鍵ができ、キャッシュが 2 度計算する(cacheKey.ts の
 * `ScaleKeyMaterial` の注釈が「判断はタスク45」としているのがここ)。
 */
function planScale(
  feature: ScaleFeature,
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
  context: SolidPlanContext,
): PlanOutcome {
  const target = resolveMachiningTarget(feature.id, feature.targetFeatureId, bodyKeys, consumed);
  if (!target.ok) {
    return target;
  }
  const origin = context.point(feature.origin);
  if (origin === null) {
    return fail(feature.id, 'missingProfile', SCALE_MISSING_ORIGIN_MESSAGE);
  }
  if (feature.factor.kind === 'uniform') {
    const value = feature.factor.value.value;
    const message = checkScaleFactor(value);
    if (message !== null) {
      return fail(feature.id, 'invalidValue', message);
    }
    return {
      ok: true,
      plan: { kind: 'scale', targetKey: target.targetKey, origin, uniform: value, perAxis: null },
    };
  }
  const x = feature.factor.x.value;
  const y = feature.factor.y.value;
  const z = feature.factor.z.value;
  for (const value of [x, y, z]) {
    const message = checkScaleFactor(value);
    if (message !== null) {
      return fail(feature.id, 'invalidValue', message);
    }
  }
  // 3 つとも同じなら全体の倍率と同じ形なので、書き方を 1 つに揃える(上の注釈)。
  const uniform = x === y && y === z;
  return {
    ok: true,
    plan: {
      kind: 'scale',
      targetKey: target.targetKey,
      origin,
      uniform: uniform ? x : null,
      perAxis: uniform ? null : [x, y, z],
    },
  };
}

/* ------------------------------------------------------------------ *
 * スイープ・リブ・エンボス・外ねじ・曲面・くり抜き
 * (FR-409、FR-420、FR-421、FR-423、FR-428、FR-418)。P5 §2.11・§2.12、タスク46
 * ------------------------------------------------------------------ */

/**
 * スケッチの曲線フィーチャーの並び(`SketchCurveRef`)を解決済みの曲線へ直す。
 *
 * `ResolvedSketch.curvesByFeature` は「フィーチャー id → その形になった曲線」の表で、
 * 矩形・正多角形のように 1 つのフィーチャーが複数の曲線になるものも 1 つの束で引ける
 * (P4 タスク17 で公開された表。同じ引き方を 2 通りに書かない)。
 *
 * **並びは書かれた順のまま**にする(経路は順につながっている前提。`SketchCurveRef` の注釈)。
 * 1 本でも引けなければ null を返し、呼び出し側が種類ごとの文言で断る(FR-504)。
 * 曲線 id が空の並びも null になる——「道筋を 1 本も選んでいない」は形が決まらないためである。
 */
function findResolvedCurves(
  sketches: readonly ResolvedPartSketch[],
  reference: SketchCurveRef,
): readonly ResolvedCurve[] | null {
  const sketch = sketches.find((entry) => entry.sketchId === reference.sketchId);
  if (sketch === undefined) {
    return null;
  }
  const resolved = sketch.resolved;
  // **`curvesByFeature` に入るのは「1 フィーチャーが複数の曲線を生む」ものだけ**
  // (矩形・正多角形・長穴・オフセット・複製。`ResolvedSketch` の注釈)。線分・円弧・
  // 楕円・スプラインは種類ごとの配列にしか入らないので、そちらからも拾う。
  const singles: readonly ResolvedCurve[] = [
    ...resolved.segments,
    ...resolved.arcs,
    ...resolved.ellipses,
    ...resolved.splines,
  ];
  const curves: ResolvedCurve[] = [];
  for (const featureId of reference.curveIds) {
    const group = resolved.curvesByFeature.get(featureId);
    if (group !== undefined && group.length > 0) {
      curves.push(...group);
      continue;
    }
    const found = singles.filter((curve) => curve.featureId === featureId);
    if (found.length === 0) {
      return null;
    }
    curves.push(...found);
  }
  return curves.length === 0 ? null : curves;
}

/**
 * 開いた輪郭が乗っている平面の単位法線(リブ FR-420・曲面の押し出し FR-428、タスク46)。
 *
 * まず座標から当てはめる(`fitPlaneNormal`)。**線分 1 本の輪郭は座標だけからは平面が
 * 決まらない**(直線を含む平面は無数にある)ので、そのときは輪郭をかいた**作図面**の
 * 法線を使う。作図面は保存形の `planeId` にあり、解決済みの曲線には残らないので
 * `SolidPlanContext.sketchDocuments` から引く。3D スケッチ(`free`)の線分 1 本のように
 * どちらでも決まらないときは null を返し、呼び出し側が理由をつけて断る(FR-504)。
 */
function curveProfileNormal(
  reference: SketchCurveRef,
  curves: readonly ResolvedCurve[],
  context: SolidPlanContext,
): Vec3 | null {
  const fitted = fitPlaneNormal(curves.flatMap((curve) => curveSamplePoints(curve)));
  if (fitted !== null) {
    return fitted;
  }
  const sketch = context.sketchDocuments.find((entry) => entry.id === reference.sketchId);
  if (sketch === undefined) {
    return null;
  }
  const first = reference.curveIds[0];
  const feature = sketch.features.find((candidate) => candidate.id === first);
  if (feature === undefined) {
    return null;
  }
  const plane = context.workPlane(feature.planeId);
  return plane === null ? null : plane.normal;
}

/** スイープの断りの文言(FR-409、FR-504)。 */
const SWEEP_MISSING_PROFILE_MESSAGE =
  '掃くもとの面が見つかりません。スケッチで面を張ってからやり直してください。';
/** 経路が空・引けない。**「道筋」**の語で断面と区別する(利用者から見て別のもの)。 */
const SWEEP_MISSING_PATH_MESSAGE =
  '掃く道筋が見つかりません。スケッチで線をかいてから選び直してください。';

/**
 * スイープ(FR-409、§0.a-0.43、§0.a-0.76)。断面を経路に沿って掃く。
 *
 * **対象を取らない「作る」段**なので `bodyKeys` も `consumed` も見ない。
 * 断面の重心を経路の始点へ移すこと・法線を接線へ合わせることはカーネルの役目
 * (タスク37)で、model は断面と経路の座標を渡すだけである。
 */
function planSweep(feature: SweepFeature, sketches: readonly ResolvedPartSketch[]): PlanOutcome {
  const face = findResolvedFace(sketches, feature.profile);
  if (face === undefined) {
    return fail(feature.id, 'missingProfile', SWEEP_MISSING_PROFILE_MESSAGE);
  }
  const path = findResolvedCurves(sketches, feature.path);
  if (path === null) {
    return fail(feature.id, 'missingProfile', SWEEP_MISSING_PATH_MESSAGE);
  }
  return {
    ok: true,
    plan: { kind: 'sweep', profile: face.curves, path, frenet: feature.frenet },
  };
}

/** リブの輪郭が引けない(FR-420、FR-504)。 */
const RIB_MISSING_PROFILE_MESSAGE =
  'リブの輪郭が見つかりません。スケッチで線をかいてから選び直してください。';
/** 輪郭の平面が決まらない。厚みを付ける向きが法線なので、平らでないと決まらない。 */
const RIB_NOT_PLANAR_MESSAGE =
  'リブの輪郭が 1 つの平面に乗っていません。輪郭をかき直してください。';
/** 厚みが 0 以下。**カーネル(`makeRib.ts` の `THICKNESS_MESSAGE`)と同文に揃える。** */
const RIB_THICKNESS_MESSAGE = '厚みは 0 より大きい数にしてください。';
/** 伸ばす向きが決まらない。カーネルの `NO_DIRECTION_MESSAGE` と同文。 */
const RIB_NO_DIRECTION_MESSAGE =
  'リブの向きが決まりません。輪郭の面と伸ばす向きを確かめてください。';
/**
 * リブ(FR-420、§0.a-0.37、§0.a-0.75)。開いた輪郭に厚みを付けた壁を立体へ足す。
 *
 * **厚みの向き(`side`)と伸ばす向き(`direction`)は別物である。**
 * - 厚みは輪郭の平面の法線の側へ付く。`both` は両側へ半分ずつ(段の `symmetric` が真)、
 *   `positive` は法線の側だけ、`negative` は法線を裏返して片側だけにする
 *   (カーネルの `RibStepSpec` は `symmetric` の真偽しか持たないので、向きは法線で表す)。
 * - 伸ばす向きは**輪郭の平面の中**にあり、`法線 × 輪郭の弦`(始点 → 終点)で決める。
 *   カーネルの検査(`makeRib.test.ts`)の例——法線 (0,1,0)・弦 +X・伸ばす向き (0,0,−1)——が
 *   ちょうどこの式になる。輪郭をかいた順で向きが決まるので、思っていたのと逆になったら
 *   輪郭をかき直す(段に向きの欄が無いため。**タスク49・50 への申し送り**)。
 */
function planRib(
  feature: RibFeature,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
  context: SolidPlanContext,
): PlanOutcome {
  const target = resolveMachiningTarget(feature.id, feature.targetFeatureId, bodyKeys, consumed);
  if (!target.ok) {
    return target;
  }
  const profile = findResolvedCurves(sketches, feature.profile);
  if (profile === null) {
    return fail(feature.id, 'missingProfile', RIB_MISSING_PROFILE_MESSAGE);
  }
  const thickness = feature.thickness.value;
  if (!isPositiveFinite(thickness)) {
    return fail(feature.id, 'invalidValue', RIB_THICKNESS_MESSAGE);
  }
  const planeNormal = curveProfileNormal(feature.profile, profile, context);
  if (planeNormal === null) {
    return fail(feature.id, 'notPlanar', RIB_NOT_PLANAR_MESSAGE);
  }
  const first = profile[0];
  const last = profile[profile.length - 1];
  if (first === undefined || last === undefined) {
    return fail(feature.id, 'missingProfile', RIB_MISSING_PROFILE_MESSAGE);
  }
  const chord = subVec3(curveEnd(last), curveStart(first));
  const extend = crossVec3(planeNormal, chord);
  // 閉じた輪郭(弦が 0)・弦が法線と平行なときは外積が潰れる。どちらも壁を立てる向きが
  // 決まらないので、OCCT を呼ぶ前に断る(NFR-UX-5)。
  if (!Number.isFinite(lengthVec3(extend)) || lengthVec3(extend) === 0) {
    return fail(feature.id, 'degenerate', RIB_NO_DIRECTION_MESSAGE);
  }
  return {
    ok: true,
    plan: {
      kind: 'rib',
      targetKey: target.targetKey,
      profile,
      // `negative` は法線を裏返して「法線の側だけ」に読み替える(上の注釈)。
      normal: feature.side === 'negative' ? negateVec3(planeNormal) : cleanZeroVec3(planeNormal),
      thickness,
      symmetric: feature.side === 'both',
      direction: ribExtendDirection(extend),
      extendToBody: feature.extendToBody,
    },
  };
}

/**
 * リブを伸ばす向きを 1 つに決める(FR-420、タスク46)。
 *
 * 弦に直交する向きは平面の中に 2 つ(互いに逆)あり、**どちらに材料があるかは model には
 * 分からない**(段は相手の形を鍵でしか持たない)。そこで「材料は輪郭の下にある」という
 * いちばん普通の使い方を採り、**世界の下向き(−Z)に近いほうを選ぶ**。カーネルの実装が
 * 検査で使っている例(板の上に置いた線 → 伸ばす向き (0,0,−1))もこの選び方になる。
 * 輪郭の平面が水平で上下の別が付かない(内積 0)ときだけ、外積の向きをそのまま採る。
 *
 * 思っていたのと逆になったら輪郭をかき直す。段にもフィーチャーにも向きの欄が無いので、
 * つまみが要るかどうかは画面の段(**タスク49・50**)で判断する。
 */
function ribExtendDirection(extend: Vec3): Vec3 {
  const unit = normalizeVec3(extend);
  const downward = dotVec3(unit, WORLD_DOWN);
  return cleanZeroVec3(downward < 0 ? negateVec3(unit) : unit);
}

/** 世界の下向き。リブを伸ばす向きの選び方(`ribExtendDirection`)の基準。 */
const WORLD_DOWN: Vec3 = [0, 0, -1];

/** エンボスの断りの文言(FR-421、FR-504)。 */
const EMBOSS_OTHER_BODY_MESSAGE = '彫る面は、加工するもとの立体の面にしてください。';
const EMBOSS_NOT_FACE_MESSAGE = '彫れるのは面だけです。面を選び直してください。';
/** 曲面へのラップは P6 以降(タスク39)。いまは平らな面だけ。 */
const EMBOSS_NOT_FLAT_MESSAGE = '彫れるのは平らな面だけです。平らな面を選び直してください。';
const EMBOSS_MISSING_PROFILE_MESSAGE =
  '彫る輪郭が見つかりません。スケッチで面を張ってからやり直してください。';

/**
 * エンボス(FR-421、§0.a-0.38)。平らな面へ輪郭を彫る / 浮き出す。**対象を消費する。**
 *
 * 面の選び直しはカーネルが行う(model は指紋を渡すだけ、§2.2)。ここで確かめるのは
 * 「面か」「対象の立体の面か」「平らか」「輪郭があるか」「高さが正か」の 5 つで、
 * どれも OCCT を呼ぶ前に赤くできる(NFR-UX-5)。
 * 文書の `height`(面から測った高さ)がカーネルの `depth` になる——彫るときは
 * そのぶんの深さ、浮き出すときはそのぶんの高さで、値の意味は同じである。
 */
function planEmboss(
  feature: EmbossFeature,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
  context: SolidPlanContext,
): PlanOutcome {
  const target = resolveMachiningTarget(feature.id, feature.targetFeatureId, bodyKeys, consumed);
  if (!target.ok) {
    return target;
  }
  if (subShapeKindOf(feature.face) !== 'face') {
    return fail(feature.id, 'invalidValue', EMBOSS_NOT_FACE_MESSAGE);
  }
  if (feature.face.bodyFeatureId !== feature.targetFeatureId) {
    return fail(feature.id, 'invalidValue', EMBOSS_OTHER_BODY_MESSAGE);
  }
  // 面の平らさは「いまの形」で見る(抜き勾配の中立面と同じ扱い)。引けないときは
  // カーネルの選び直しに任せる(model が指紋を持っていても選び直しの結果は知らない)。
  const resolved = context.subShape(feature.face);
  if (resolved !== null && (resolved.surfaceKind !== 'plane' || resolved.axis === null)) {
    return fail(feature.id, 'degenerate', EMBOSS_NOT_FLAT_MESSAGE);
  }
  const profile = findResolvedFace(sketches, feature.profile);
  if (profile === undefined) {
    return fail(feature.id, 'missingProfile', EMBOSS_MISSING_PROFILE_MESSAGE);
  }
  const depth = feature.height.value;
  if (!isPositiveFinite(depth)) {
    return fail(feature.id, 'invalidValue', '彫る深さは 0 より大きい数にしてください。');
  }
  return {
    ok: true,
    plan: {
      kind: 'emboss',
      targetKey: target.targetKey,
      face: feature.face,
      // model のフィーチャーは輪郭 1 枚だが、段は複数の輪郭を受ける(カーネルの
      // `EmbossStepSpec.profiles`)。1 枚を 1 要素の列にして渡す。
      profiles: [profile.curves],
      depth,
      raised: feature.raised,
    },
  };
}

/** 外ねじの断りの文言(FR-423、FR-504)。 */
const THREAD_SHAFT_OTHER_BODY_MESSAGE = 'ねじを切る面は、加工するもとの立体の面にしてください。';
const THREAD_SHAFT_NOT_CYLINDER_MESSAGE =
  'ねじを切れるのは円柱の面だけです。円柱の面を選び直してください。';
/**
 * 呼び径と軸の実寸が食い違う(§0.a-0.85、統括の決定 2026-09-05 17:37)。
 * **カーネルでは断らず model で断る**ので、この文言が唯一の理由になる。
 */
const THREAD_SHAFT_DIAMETER_MESSAGE =
  '呼び径と軸の径が合いません。ねじの呼びか、ねじを切る面を選び直してください。';

/**
 * 呼び径と軸の実寸の許容差(mm、§0.a-0.85)。
 * おねじの外径は軸の径とほぼ同じ(JIS のはめあいで数十 μm 差)なので、
 * 0.5mm も違えば「別の太さの軸にその呼びを付けた」とみなしてよい。
 */
const THREAD_SHAFT_DIAMETER_TOLERANCE_MM = 0.5;

/**
 * 外ねじ(FR-423、§0.a-0.40)。円柱面にねじを切る。**対象を消費する。**
 *
 * 呼び(`nominal`)から規格表(`thread/metricThread.ts`)を引いて呼び径 d を得る。
 * ピッチは規格表から入るが式で書き換えられる(FR-202)ので**文書の値を正**とし、
 * 表からは呼び径だけを取る(ねじ穴 `planThreadHole` とまったく同じ扱い)。
 *
 * **呼び径と円柱面の実寸の食い違いは、保存された指紋の半径で見る**(§0.a-0.85)。
 * 「いまの形」で選び直した半径は model に無い(`ResolvedSubShape` は面積・重心・軸しか
 * 持たない)ためで、上流を大きく作り替えて軸の太さが変わった場合は、カーネルの選び直しの
 * 結果とここの判定がずれうる。**そのときはカーネルがねじを切れずに断る**ので黙って
 * 間違った形になることはないが、理由の出どころが変わる(**タスク47・55 への申し送り**)。
 */
function planThreadShaft(
  feature: ThreadShaftFeature,
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): PlanOutcome {
  const target = resolveMachiningTarget(feature.id, feature.targetFeatureId, bodyKeys, consumed);
  if (!target.ok) {
    return target;
  }
  const fingerprint = feature.face.fingerprint;
  if (fingerprint.kind !== 'face') {
    return fail(feature.id, 'invalidValue', THREAD_SHAFT_NOT_CYLINDER_MESSAGE);
  }
  if (feature.face.bodyFeatureId !== feature.targetFeatureId) {
    return fail(feature.id, 'invalidValue', THREAD_SHAFT_OTHER_BODY_MESSAGE);
  }
  if (fingerprint.surfaceKind !== 'cylinder') {
    return fail(feature.id, 'invalidValue', THREAD_SHAFT_NOT_CYLINDER_MESSAGE);
  }
  const size = findMetricThread(feature.nominal);
  if (size === undefined) {
    return fail(
      feature.id,
      'invalidValue',
      'そのねじの呼びは使えません。一覧から選び直してください。',
    );
  }
  const radius = fingerprint.radius;
  if (
    radius !== null &&
    Math.abs(2 * radius - size.diameter) > THREAD_SHAFT_DIAMETER_TOLERANCE_MM
  ) {
    return fail(feature.id, 'invalidValue', THREAD_SHAFT_DIAMETER_MESSAGE);
  }
  const pitch = feature.pitch.value;
  if (!isPositiveFinite(pitch)) {
    return fail(feature.id, 'invalidValue', 'ねじのピッチは 0 より大きい数にしてください。');
  }
  const length = feature.length.value;
  if (!isPositiveFinite(length)) {
    return fail(feature.id, 'invalidValue', 'ねじ部の長さは 0 より大きい数にしてください。');
  }
  return {
    ok: true,
    plan: {
      kind: 'threadShaft',
      targetKey: target.targetKey,
      face: feature.face,
      majorDiameter: size.diameter,
      pitch,
      length,
      fromEnd: feature.fromEnd,
      modeled: feature.modeled,
    },
  };
}

/** 曲面の断りの文言(FR-428、FR-504)。 */
const SURFACE_MISSING_PROFILE_MESSAGE =
  '曲面のもとになる線が見つかりません。スケッチで線をかいてから選び直してください。';
const SURFACE_NOT_PLANAR_MESSAGE =
  '曲面のもとの線が 1 つの平面に乗っていません。輪郭をかき直してください。';
const SURFACE_MISSING_AXIS_MESSAGE =
  '回転の軸にする線分が見つかりません。スケッチで線分をかいてから選び直してください。';
const SURFACE_NOT_FACE_MESSAGE = '取り出せるのは立体の面だけです。面を選び直してください。';
const SURFACE_MISSING_BODY_MESSAGE =
  '面を借りるもとの立体が見つかりません。立体を選び直してください。';
/** 距離 0 のオフセットは元の面と同じ形になる(同じ形に 2 通りの書き方を残さない)。 */
const SURFACE_OFFSET_ZERO_MESSAGE = '離す距離は 0 以外の数にしてください。';

/** 曲面の作り方を解決した結果。`targetKey` は `face` / `offset` のときだけ入る。 */
interface SurfaceShapeOutcomeValue {
  readonly shape: SurfaceShapePlan;
  readonly targetKey: string | null;
}

type SurfaceShapeOutcome =
  | { readonly ok: true; readonly value: SurfaceShapeOutcomeValue }
  | { readonly ok: false; readonly error: PartError };

/**
 * 曲面の作り方 6 種(FR-428、§0.a-0.45)を段の欄へ直す。
 *
 * **種類ごとに材料が違う**——押し出し・回転・平面・ロフトはスケッチの曲線、
 * 面・オフセットは立体の面の指紋である。前者は座標まで解けるが、後者は指紋のまま渡し、
 * 選び直しはカーネルが行う(罫線面の `solidFace` とまったく同じ扱い、§2.2)。
 * **どの作り方でも対象を消費しない**ので `consumed` を見ない(§0.a-0.45)。
 */
function resolveSurfaceShape(
  featureId: string,
  operation: SurfaceOperation,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  context: SolidPlanContext,
): SurfaceShapeOutcome {
  switch (operation.kind) {
    case 'extrude': {
      const profile = findResolvedCurves(sketches, operation.profile);
      if (profile === null) {
        return {
          ok: false,
          error: partError(featureId, 'missingProfile', SURFACE_MISSING_PROFILE_MESSAGE),
        };
      }
      // 掃く向きは輪郭の平面の法線(リブと同じ引き方。線分 1 本なら作図面から取る)。
      const normal = curveProfileNormal(operation.profile, profile, context);
      if (normal === null) {
        return {
          ok: false,
          error: partError(featureId, 'notPlanar', SURFACE_NOT_PLANAR_MESSAGE),
        };
      }
      const distance = operation.distance.value;
      if (!isPositiveFinite(distance)) {
        return {
          ok: false,
          error: partError(featureId, 'invalidValue', positiveFieldMessage('掃く長さ')),
        };
      }
      return {
        ok: true,
        value: {
          shape: {
            kind: 'extrude',
            profile,
            direction: operation.reversed ? negateVec3(normal) : cleanZeroVec3(normal),
            distance,
          },
          targetKey: null,
        },
      };
    }
    case 'revolve': {
      const profile = findResolvedCurves(sketches, operation.profile);
      if (profile === null) {
        return {
          ok: false,
          error: partError(featureId, 'missingProfile', SURFACE_MISSING_PROFILE_MESSAGE),
        };
      }
      const degrees = operation.angle.value;
      if (!Number.isFinite(degrees) || degrees <= 0 || degrees > MAX_REVOLVE_DEGREES) {
        return {
          ok: false,
          error: partError(
            featureId,
            'invalidValue',
            '回転の角度は 0 より大きく 360 以下にしてください。',
          ),
        };
      }
      const frame = resolveRevolveAxis(operation.axis, sketches, context.axisFrames);
      if (frame === null) {
        return {
          ok: false,
          error: partError(featureId, 'missingProfile', SURFACE_MISSING_AXIS_MESSAGE),
        };
      }
      return {
        ok: true,
        value: {
          shape: {
            kind: 'revolve',
            profile,
            axisOrigin: frame.origin,
            axisDirection: operation.reversed
              ? negateVec3(frame.direction)
              : cleanZeroVec3(frame.direction),
            angle: degreesToRadians(degrees),
          },
          targetKey: null,
        },
      };
    }
    case 'planar': {
      const profile = findResolvedCurves(sketches, operation.profile);
      if (profile === null) {
        return {
          ok: false,
          error: partError(featureId, 'missingProfile', SURFACE_MISSING_PROFILE_MESSAGE),
        };
      }
      return { ok: true, value: { shape: { kind: 'planar', profile }, targetKey: null } };
    }
    case 'loft': {
      if (operation.sections.length < MIN_THRU_SECTIONS) {
        return {
          ok: false,
          error: partError(featureId, 'missingProfile', THRU_SECTIONS_TOO_FEW_MESSAGE),
        };
      }
      const sections: (readonly ResolvedCurve[])[] = [];
      for (const reference of operation.sections) {
        const curves = findResolvedCurves(sketches, reference);
        if (curves === null) {
          return {
            ok: false,
            error: partError(featureId, 'missingProfile', SURFACE_MISSING_PROFILE_MESSAGE),
          };
        }
        sections.push(curves);
      }
      return {
        ok: true,
        value: { shape: { kind: 'loft', sections, ruled: operation.ruled }, targetKey: null },
      };
    }
    case 'face':
    case 'offset': {
      if (subShapeKindOf(operation.face) !== 'face') {
        return {
          ok: false,
          error: partError(featureId, 'invalidValue', SURFACE_NOT_FACE_MESSAGE),
        };
      }
      const targetKey = bodyKeys.get(operation.targetFeatureId);
      if (targetKey === undefined) {
        return {
          ok: false,
          error: partError(featureId, 'missingBody', SURFACE_MISSING_BODY_MESSAGE),
        };
      }
      if (operation.kind === 'face') {
        // **消費しない**(§0.a-0.45)ので `consumed` は見ない。鍵は連鎖のために持つ。
        return {
          ok: true,
          value: { shape: { kind: 'face', face: operation.face }, targetKey },
        };
      }
      const distance = operation.distance.value;
      if (!Number.isFinite(distance) || distance === 0) {
        return {
          ok: false,
          error: partError(featureId, 'invalidValue', SURFACE_OFFSET_ZERO_MESSAGE),
        };
      }
      return {
        ok: true,
        value: { shape: { kind: 'offset', face: operation.face, distance }, targetKey },
      };
    }
  }
}

/**
 * 曲面(FR-428、§0.a-0.45)。**閉じた立体ではなく面だけのボディ**を作る。
 * **どの作り方でも対象を消費しない**(面を貸した立体はそのまま画面に残る)。
 */
function planSurface(
  feature: SurfaceFeature,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  context: SolidPlanContext,
): PlanOutcome {
  const outcome = resolveSurfaceShape(feature.id, feature.operation, sketches, bodyKeys, context);
  if (!outcome.ok) {
    return outcome;
  }
  return {
    ok: true,
    plan: { kind: 'surface', shape: outcome.value.shape, targetKey: outcome.value.targetKey },
  };
}

/** くり抜きの断りの文言(FR-418、FR-504)。 */
const SHELL_NOT_FACE_MESSAGE = '開けられるのは面だけです。面を選び直してください。';
const SHELL_OTHER_BODY_MESSAGE = '開ける面は、くり抜くもとの立体の面にしてください。';
/** 厚さが 0 以下。**カーネル(`makeShell.ts`)と同じ状況の断り。** */
const SHELL_THICKNESS_MESSAGE = '壁の厚さは 0 より大きい数にしてください。';

/**
 * くり抜き(シェル。FR-418、§0.a-0.47、§2.12)。壁の厚さを残して中身を抜く。
 * **対象を消費する。**
 *
 * **開ける面は 0 枚でもよい**(そのときは外から見た形が変わらず、中だけが空になる)ので、
 * R 面取りのような「1 つも指していない」の断りは持たない。重複を除いて通し番号の昇順に
 * 並べるのは R 面取りと同じ理由(同じ面の組なら必ず同じ鍵になる)。
 */
function planShell(
  feature: ShellFeature,
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): PlanOutcome {
  const target = resolveMachiningTarget(feature.id, feature.targetFeatureId, bodyKeys, consumed);
  if (!target.ok) {
    return target;
  }
  const openFaces = sortedUniqueTargets(feature.openFaces);
  for (const face of openFaces) {
    if (subShapeKindOf(face) !== 'face') {
      return fail(feature.id, 'invalidValue', SHELL_NOT_FACE_MESSAGE);
    }
    if (face.bodyFeatureId !== feature.targetFeatureId) {
      return fail(feature.id, 'invalidValue', SHELL_OTHER_BODY_MESSAGE);
    }
  }
  const thickness = feature.thickness.value;
  if (!isPositiveFinite(thickness)) {
    return fail(feature.id, 'invalidValue', SHELL_THICKNESS_MESSAGE);
  }
  return {
    ok: true,
    plan: {
      kind: 'shell',
      targetKey: target.targetKey,
      openFaces,
      thickness,
      outward: feature.outward,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 平面による切断(FR-432、§2.9b、タスク27c)
 * ------------------------------------------------------------------ */

/** 切るもとの立体が引けない(未作成・抑制中・上流が失敗・前方参照)。 */
const CUT_MISSING_BODY_MESSAGE = '切るもとの立体が見つかりません。';
/** 対でないのに、すでに使われた立体をもう一度切ろうとした。 */
const CUT_CONSUMED_TWICE_MESSAGE = 'その立体はすでに別のところで使われています。';

/**
 * 対になっている切断(§0.a-0.58)を文書から引く。
 *
 * 結びは 2 つ目が `pairedWith` に 1 つ目の id を持つ形で保存されるので、**どちら向きにも
 * 探す**(履歴の並べ替え FR-507 で 2 つの順序が入れ替わっても対のままにするため)。
 *
 * **相手が文書に無い・抑制されている・切断でない・別の立体を切っているときは null**
 * (= 単独の切断として扱う)。文書は書き換えない(§2.9b.2)。
 */
function pairedCutOf(feature: CutFeature, solids: readonly SolidFeature[]): CutFeature | null {
  const partner = solids.find(
    (candidate) =>
      candidate.kind === 'cut' &&
      candidate.id !== feature.id &&
      (candidate.id === feature.pairedWith || candidate.pairedWith === feature.id),
  );
  if (partner === undefined || partner.kind !== 'cut' || partner.suppressed) {
    return null;
  }
  return partner.targetFeatureId === feature.targetFeatureId ? partner : null;
}

/**
 * 切断の対象になるボディの鍵を引く(§0.a-0.5、§0.a-0.58)。
 *
 * 加工の `resolveMachiningTarget` と同じ判定に、**対の切断だけの例外**を足したもの。
 * 「反対側も残す」で積まれた 2 つ目は、対象が 1 つ目に消費された後で解決される。
 * このときだけ `consumedTwice` を出さず、対象を **1 度だけ**消費したものとして扱う。
 *
 * 例外を許すのは「対の相手が段を作れた」(= `bodyKeys` にいる)ときだけである。相手が
 * 段を作れていないなら、対象を消費したのは相手ではない別のフィーチャーなので、
 * 通常どおり断る(対を口実に二重消費を通さない)。
 */
function resolveCutTarget(
  feature: CutFeature,
  solids: readonly SolidFeature[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): MachiningTargetOutcome {
  const targetKey = bodyKeys.get(feature.targetFeatureId);
  if (targetKey === undefined) {
    return { ok: false, error: partError(feature.id, 'missingBody', CUT_MISSING_BODY_MESSAGE) };
  }
  if (!consumed.has(feature.targetFeatureId)) {
    return { ok: true, targetKey };
  }
  const partner = pairedCutOf(feature, solids);
  if (partner !== null && bodyKeys.has(partner.id)) {
    return { ok: true, targetKey };
  }
  return { ok: false, error: partError(feature.id, 'consumedTwice', CUT_CONSUMED_TWICE_MESSAGE) };
}

/**
 * 切断面(`PlaneSpec`)を解く。**平面の解決の正本は `geometry/planeSpec.ts`** で、
 * ここは手掛かり(点・部分形状・軸・作図面)を束ねて渡すだけである(同じ規則を 2 か所に
 * 書かない。§0.a-0.56)。軸は回転・パターンと同じ `resolveRevolveAxis` を再利用する。
 */
function cutPlaneContext(
  sketches: readonly ResolvedPartSketch[],
  context: SolidPlanContext,
): PlaneResolveContext {
  return {
    point: context.point,
    subShape: context.subShape,
    axis: (spec: AxisSpec) => resolveRevolveAxis(spec, sketches, context.axisFrames),
    workPlane: context.workPlane,
  };
}

/**
 * 平面による切断(FR-432、§2.9b)。対象を消費し、残す側 1 つのボディを作る。
 *
 * 残す側の意味は解決した**法線の向き**で決まる(§0.a-0.57)ので、断りの文言も含めて
 * 平面の解決は `resolvePlaneSpec` に任せる(同じ指定からは必ず同じ法線が出る)。
 * 平面が決まらなかった理由(`PlaneErrorKey`)は基準ジオメトリと同じ表でツリーの
 * 断りへ写す(`REFERENCE_ERROR_CODES`。断りのコードを増やさない)。
 */
function planCut(
  feature: CutFeature,
  solids: readonly SolidFeature[],
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
  context: SolidPlanContext,
): PlanOutcome {
  const target = resolveCutTarget(feature, solids, bodyKeys, consumed);
  if (!target.ok) {
    return target;
  }
  const outcome = resolvePlaneSpec(feature.plane, cutPlaneContext(sketches, context));
  if (!outcome.ok) {
    return fail(feature.id, REFERENCE_ERROR_CODES[outcome.reason], outcome.message);
  }
  return {
    ok: true,
    plan: {
      kind: 'cut',
      targetKey: target.targetKey,
      origin: outcome.plane.origin,
      // 法線は `resolvePlaneSpec` が単位化済み。-0 を 0 に揃えるのはミラーと同じ理由
      // (同じ平面から必ず同じ鍵を出すため)。
      normal: cleanZeroVec3(outcome.plane.normal),
      keepPositive: feature.keep === 'positive',
    },
  };
}

/**
 * 読み込んだ三角形の形を加工・組み合わせの対象に指したときの断り(P6 §2.8 の表、§0.a-0.23)。
 *
 * **この文言の正本は model のこの 1 行**である。カーネル(`worker/recomputeSolids.ts` の
 * `MESH_NOT_MACHINABLE_MESSAGE`、タスク10)にも 1 字違わぬ同じ文言の断りがあるが、
 * あちらは二重の網(段まで届いてしまった場合の最後の砦)で、
 * **参照へ変えるのは P6 タスク16 の担当**である(model → kernel の依存を作らずに、
 * kernel が model の文言を輸入する形にはできないため、当面は同じ文字列が 2 か所にある)。
 */
export const IMPORTED_MESH_TARGET_MESSAGE =
  '読み込んだ三角形の形には、穴あけや面取りはできません。';

/**
 * 読み込んだ形(ベースボディ。FR-802、P6 §2.8、タスク20)の段。
 *
 * 対象も式も取らないので、することは**抱き込んだバイト列を置き場から引く**ことだけ。
 * 引けなかった(= `.pcad` の `shapes/<shapeRef>.brep` が無い)ときは、形が作れない理由を
 * FR-504 のとおり持ち回る。**断りのコードは増やさず** `missingProfile`(もとになる形が
 * 見つからない)を使う。
 */
function planImportedSolid(
  feature: ImportedSolidFeature,
  importedShapes: ImportedShapeBytes,
): PlanOutcome {
  const bytes = importedShapes.get(feature.shapeRef);
  if (bytes === undefined) {
    return fail(
      feature.id,
      'missingProfile',
      '読み込んだ形が見つかりません。ファイルを読み込み直してください。',
    );
  }
  return { ok: true, plan: { kind: 'importedSolid', shapeRef: feature.shapeRef, bytes } };
}

/**
 * 「読み込んだ三角形の形は加工・組み合わせの対象にできない」の断り(§0.a-0.23)を、
 * **model で 1 か所だけ**判定する。
 *
 * 判定に `consumedTargetsOf`(`createPartDocument.ts`)をそのまま使うのは、**形を変える
 * ために相手のボディを取る種類の一覧がちょうどそれだから**である(ブーリアンの対象と
 * 相手、穴・ねじ穴・面取り・抜き勾配・移動/回転・拡大縮小・リブ・エンボス・外ねじ・
 * くり抜き・切断の対象、パターンのもと)。種類ごとの欄名をここへ書き写すと、同じ規則が
 * 2 か所になる(`resolvePart` の消費の記録がこの表を正本にしているのと同じ理由)。
 *
 * 面を借りるだけの種類(ミラー・曲面の `face`)はこの一覧に無いので、三角形の形を指すと
 * 「もとの立体が見つかりません」になる。段を作れない点は同じで、断りの言葉だけが違う。
 */
function importedMeshTargetError(
  feature: SolidFeature,
  solids: readonly SolidFeature[],
): PartError | null {
  for (const targetId of consumedTargetsOf(feature)) {
    const target = solids.find((candidate) => candidate.id === targetId);
    // 抑制された形はボディを作らないので「見つからない」が正しい断りになる(FR-503)。
    if (target !== undefined && target.kind === 'importedMesh' && !target.suppressed) {
      return partError(feature.id, 'invalidValue', IMPORTED_MESH_TARGET_MESSAGE);
    }
  }
  return null;
}

function planSolid(
  feature: SolidFeature,
  solids: readonly SolidFeature[],
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
  context: SolidPlanContext,
  importedShapes: ImportedShapeBytes,
): PlanOutcome {
  const axisFrames = context.axisFrames;
  const meshError = importedMeshTargetError(feature, solids);
  if (meshError !== null) {
    return { ok: false, error: meshError };
  }
  switch (feature.kind) {
    case 'extrude':
      return planExtrude(feature, sketches, bodyKeys, consumed, context);
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
      return planPattern(feature, solids, sketches, bodyKeys, consumed, context);
    case 'primitive':
      return planPrimitive(feature, sketches, bodyKeys, axisFrames);
    case 'ruled':
      return planRuled(feature, solids, sketches, bodyKeys);
    case 'loft':
      return planLoft(feature, solids, sketches, bodyKeys);
    case 'draft':
      return planDraft(feature, bodyKeys, consumed, context);
    case 'mirror':
      return planMirror(feature, bodyKeys, context);
    case 'transform':
      return planTransform(feature, sketches, bodyKeys, consumed, context);
    case 'scale':
      return planScale(feature, bodyKeys, consumed, context);
    // P5 の Should 群の残り 5 種(§2.11、タスク46)と、前倒しした Could 群の 1 種(§2.12)。
    case 'sweep':
      return planSweep(feature, sketches);
    case 'rib':
      return planRib(feature, sketches, bodyKeys, consumed, context);
    case 'emboss':
      return planEmboss(feature, sketches, bodyKeys, consumed, context);
    case 'threadShaft':
      return planThreadShaft(feature, bodyKeys, consumed);
    case 'surface':
      return planSurface(feature, sketches, bodyKeys, context);
    case 'shell':
      return planShell(feature, bodyKeys, consumed);
    // 平面による切断(FR-432、§2.9b、タスク27c)。
    case 'cut':
      return planCut(feature, solids, sketches, bodyKeys, consumed, context);
    // 読み込んだ形(FR-802、P6 §2.8、タスク20)。
    case 'importedSolid':
      return planImportedSolid(feature, importedShapes);
    case 'importedMesh':
      /*
        読み込んだ三角形の形は**幾何カーネルの段にならない**(§0.a-0.23)。
        呼び出し側(`resolvePart`)が `importedMesh` をこの関数へ渡す前に `meshBodies` へ
        振り分けているので、ここへは来ない。到達しない節に断りを書くのではなく
        `degenerate` の失敗で返してあるのは、`default` を作らずに網羅の switch を保ちつつ、
        万一の呼び違いを黙って通さないためである(FR-504、NFR-RE-1)。
      */
      return fail(feature.id, 'degenerate', IMPORTED_MESH_TARGET_MESSAGE);
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

/**
 * 基本形状の寸法を鍵の材料へ詰め替える(cacheKey.ts の `PrimitiveShapeKeyMaterial`)。
 * 欄名も形も同じだが、`toKeyCurve` と同じ理由で偶然の構造の一致に頼らず種類ごとに写す。
 */
function toKeyPrimitiveShape(shape: PrimitiveShapePlan): PrimitiveShapeKeyMaterial {
  switch (shape.kind) {
    case 'sphere':
      return { kind: 'sphere', radius: shape.radius };
    case 'box':
      return { kind: 'box', sizeX: shape.sizeX, sizeY: shape.sizeY, sizeZ: shape.sizeZ };
    case 'cylinder':
      return { kind: 'cylinder', radius: shape.radius, height: shape.height };
    case 'cone':
      return {
        kind: 'cone',
        bottomRadius: shape.bottomRadius,
        topRadius: shape.topRadius,
        height: shape.height,
      };
    case 'torus':
      return { kind: 'torus', majorRadius: shape.majorRadius, minorRadius: shape.minorRadius };
  }
}

/**
 * 罫線面・ロフトの断面を鍵の材料へ詰め替える(cacheKey.ts の `ThruSectionKeyMaterial`)。
 * `toKeyCurve` と同じ理由で、欄が同じでも種類ごとに写す(偶然の構造の一致に頼らない)。
 */
function toKeyThruSection(section: ThruSectionPlan): ThruSectionKeyMaterial {
  switch (section.kind) {
    case 'curves':
      return { kind: 'curves', curves: section.curves.map(toKeyCurve) };
    case 'sphere':
      return { kind: 'sphere', center: toKeyVec3(section.center), radius: section.radius };
    case 'faceQuery':
      // 上流の鍵と面の指紋を必ず混ぜる(混ぜないと、上流を伸ばして面が動いても
      // 段の鍵が変わらず古い輪郭の形がキャッシュから返る。NFR-PF-3)。
      return {
        kind: 'faceQuery',
        targetKey: section.targetKey,
        query: fingerprintKeyText(section.query),
      };
  }
}

/**
 * 押し出しの終端を鍵の材料へ詰め替える(cacheKey.ts の `ExtrudeEndKeyMaterial`)。
 * 欄も種類も同じだが、`toKeyCurve` と同じ理由で偶然の構造の一致に頼らず種類ごとに写す。
 */
function toKeyExtrudeEnd(end: ExtrudeEndPlan): ExtrudeEndKeyMaterial {
  switch (end.kind) {
    case 'distance':
      return { kind: 'distance', distance: end.distance };
    case 'symmetric':
      return { kind: 'symmetric', forward: end.forward, backward: end.backward };
    case 'toFace':
      return { kind: 'toFace', distance: end.distance };
    case 'toNext':
      return { kind: 'toNext' };
  }
}

/**
 * 穴の入口を鍵の材料へ詰め替える(cacheKey.ts の `HoleEntryKeyMaterial`、タスク46)。
 * 段に欄が無い(広げない)ときは `{ kind: 'plain' }` を渡す——`keyHoleEntryExtra` が
 * `plain` を鍵の文字列に出さないので、省略と「広げない」は同じ鍵になる。
 */
function toKeyHoleEntry(entry: HoleEntryPlan | undefined): HoleEntryKeyMaterial {
  if (entry === undefined) {
    return { kind: 'plain' };
  }
  return entry.kind === 'counterbore'
    ? { kind: 'counterbore', diameter: entry.diameter, depth: entry.depth }
    : { kind: 'countersink', diameter: entry.diameter, angle: entry.angle };
}

/**
 * 丸める半径を鍵の材料へ詰め替える(cacheKey.ts の `FilletRadiusKeyMaterial`)。
 * 一定半径は数 1 つのままなので、P3 からの R 面取りの鍵は 1 文字も変わらない。
 */
function toKeyFilletRadius(radius: FilletRadiusPlan): FilletRadiusKeyMaterial {
  return typeof radius === 'number' ? radius : { start: radius.start, end: radius.end };
}

/**
 * 曲面の作り方を鍵の材料へ詰め替える(cacheKey.ts の `SurfaceShapeKeyMaterial`)。
 * `toKeyCurve` と同じ理由で、欄が同じでも種類ごとに写す(偶然の構造の一致に頼らない)。
 */
function toKeySurfaceShape(shape: SurfaceShapePlan): SurfaceShapeKeyMaterial {
  switch (shape.kind) {
    case 'extrude':
      return {
        kind: 'extrude',
        profile: shape.profile.map(toKeyCurve),
        direction: toKeyVec3(shape.direction),
        distance: shape.distance,
      };
    case 'revolve':
      return {
        kind: 'revolve',
        profile: shape.profile.map(toKeyCurve),
        axisOrigin: toKeyVec3(shape.axisOrigin),
        axisDirection: toKeyVec3(shape.axisDirection),
        angle: shape.angle,
      };
    case 'planar':
      return { kind: 'planar', profile: shape.profile.map(toKeyCurve) };
    case 'loft':
      return {
        kind: 'loft',
        sections: shape.sections.map((section) => section.map(toKeyCurve)),
        ruled: shape.ruled,
      };
    case 'face':
      return { kind: 'face', face: fingerprintKeyText(shape.face) };
    case 'offset':
      return {
        kind: 'offset',
        face: fingerprintKeyText(shape.face),
        distance: shape.distance,
      };
  }
}

/** 1段ぶんの鍵の材料(§0.a-0.20)。名前・抑制・色は混ぜない(形が変わらないため)。 */
function keyMaterialFor(plan: SolidStepPlan): SolidStepKeyMaterial {
  switch (plan.kind) {
    case 'extrude':
      // P5 で足した 5 欄は**省略された欄も既定で埋めてから**渡す。埋めても
      // `keyExtrudeExtras` が既定を空文字列に畳むので、P2 からの押し出しの鍵は変わらず、
      // 「欄を省いた押し出し」と「既定を明示した押し出し」も同じ鍵になる(タスク44 の決め 3)。
      return {
        kind: 'extrude',
        profile: plan.profile.map(toKeyCurve),
        direction: toKeyVec3(plan.direction),
        distance: plan.distance,
        end:
          plan.end === undefined
            ? { kind: 'distance', distance: plan.distance }
            : toKeyExtrudeEnd(plan.end),
        taperAngle: plan.taperAngle ?? 0,
        taperOutward: plan.taperOutward ?? false,
        thin: plan.thin === undefined || plan.thin === null
          ? null
          : { thickness: plan.thin.thickness, side: plan.thin.side },
        targetKey: plan.targetKey ?? null,
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
        // 入口の形(FR-422)。省略と「広げない」は同じ鍵になる(`toKeyHoleEntry` の注釈)。
        entry: toKeyHoleEntry(plan.entry),
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
        // 入口の形(FR-422)。穴とまったく同じ扱いで、省略と「広げない」は同じ鍵になる。
        entry: toKeyHoleEntry(plan.entry),
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
        radius: toKeyFilletRadius(plan.radius),
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
    case 'primitive':
      // 頂点の指紋(originQuery)と上流の鍵(targetKey)を**必ず**混ぜる。混ぜないと、
      // 上流の押し出しを伸ばして頂点が動いても鍵が変わらず、古い位置の形が
      // キャッシュから返る(cacheKey.ts の `PrimitiveKeyMaterial` の注釈、NFR-PF-3)。
      return {
        kind: 'primitive',
        origin: toKeyVec3(plan.origin),
        axis: toKeyVec3(plan.axis),
        shape: toKeyPrimitiveShape(plan.shape),
        originQuery: plan.originQuery === null ? null : fingerprintKeyText(plan.originQuery),
        targetKey: plan.targetKey,
      };
    case 'thruSections':
      // 断面の輪郭・球の中心と半径をすべて混ぜる(cacheKey.ts の `ThruSectionsKeyMaterial`)。
      // 混ぜないと、スケッチの面を動かしても段の鍵が変わらず古い形が返る(NFR-PF-3)。
      return {
        kind: 'thruSections',
        sections: plan.sections.map(toKeyThruSection),
        ruled: plan.ruled,
        closed: plan.closed,
        twist: plan.twist,
        sphereSegments: plan.sphereSegments,
      };
    case 'draft':
      return {
        kind: 'draft',
        targetKey: plan.targetKey,
        // 並びはすでに planDraft が通し番号の昇順に揃えてある(R 面取りと同じ)。
        faces: plan.faces.map(fingerprintKeyText),
        neutralFace: fingerprintKeyText(plan.neutralFace),
        angle: plan.angle,
        reversed: plan.reversed,
      };
    case 'mirror':
      // 対象を消費しないが targetKey を必ず混ぜる(元を編集したら鏡像も作り直す、NFR-PF-3)。
      return {
        kind: 'mirror',
        targetKey: plan.targetKey,
        origin: toKeyVec3(plan.origin),
        normal: toKeyVec3(plan.normal),
      };
    case 'transform':
      return {
        kind: 'transform',
        targetKey: plan.targetKey,
        translation: toKeyVec3(plan.translation),
        rotationOrigin: toKeyVec3(plan.rotationOrigin),
        rotationAxis: toKeyVec3(plan.rotationAxis),
        rotationAngle: plan.rotationAngle,
      };
    case 'scale':
      // uniform / perAxis はどちらか一方だけが入る(planScale が正規化済み)。
      return {
        kind: 'scale',
        targetKey: plan.targetKey,
        origin: toKeyVec3(plan.origin),
        uniform: plan.uniform,
        perAxis: plan.perAxis === null ? null : toKeyVec3(plan.perAxis),
      };
    case 'sweep':
      // 対象を取らない「作る」段なので targetKey を持たない(押し出し・ばねと同じ)。
      return {
        kind: 'sweep',
        profile: plan.profile.map(toKeyCurve),
        path: plan.path.map(toKeyCurve),
        frenet: plan.frenet,
      };
    case 'rib':
      return {
        kind: 'rib',
        targetKey: plan.targetKey,
        profile: plan.profile.map(toKeyCurve),
        normal: toKeyVec3(plan.normal),
        thickness: plan.thickness,
        symmetric: plan.symmetric,
        direction: toKeyVec3(plan.direction),
        // 伸ばす/伸ばさないで形が変わるので鍵にも混ぜる(cacheKey.ts の RibKeyMaterial の注釈)。
        extendToBody: plan.extendToBody,
      };
    case 'emboss':
      return {
        kind: 'emboss',
        targetKey: plan.targetKey,
        face: fingerprintKeyText(plan.face),
        profiles: plan.profiles.map((profile) => profile.map(toKeyCurve)),
        depth: plan.depth,
        raised: plan.raised,
      };
    case 'threadShaft':
      return {
        kind: 'threadShaft',
        targetKey: plan.targetKey,
        face: fingerprintKeyText(plan.face),
        majorDiameter: plan.majorDiameter,
        pitch: plan.pitch,
        length: plan.length,
        fromEnd: plan.fromEnd,
        modeled: plan.modeled,
      };
    case 'surface':
      // 面を借りる作り方(face / offset)でも消費しないが targetKey は必ず混ぜる
      // (混ぜないと上流を編集しても鍵が変わらず古い面の形が返る。NFR-PF-3)。
      return {
        kind: 'surface',
        shape: toKeySurfaceShape(plan.shape),
        targetKey: plan.targetKey,
      };
    case 'shell':
      return {
        kind: 'shell',
        targetKey: plan.targetKey,
        // 並びはすでに planShell が通し番号の昇順に揃えてある(R 面取りと同じ)。
        openFaces: plan.openFaces.map(fingerprintKeyText),
        thickness: plan.thickness,
        outward: plan.outward,
      };
    case 'cut':
      /*
        切断(FR-432)。**平面は解決済みの点と法線を混ぜる**(`planeSpecKeyText` は混ぜない)。
        指定の書き方が違っても同じ平面になるなら同じ形なので、鍵も同じにするためである。
        点の座標を変えれば解決した `origin` が動いて鍵も変わる(検証表の行)。
        **`pairedWith` は混ぜない**(形に影響しない。`CutKeyMaterial` の注釈)。
      */
      return {
        kind: 'cut',
        targetKey: plan.targetKey,
        origin: toKeyVec3(plan.origin),
        normal: toKeyVec3(plan.normal),
        keepPositive: plan.keepPositive,
      };
    case 'importedSolid':
      // 内容は原本ごとに一度だけ識別する。同じ文書内連番を持つ別部品とも衝突しない。
      return {
        kind: 'importedSolid',
        shapeRef: plan.shapeRef,
        shapeDigest: importedShapeOf(plan.bytes).shapeDigest,
      };
  }
}

/** visible を決める前の段。消費はすべての段を見終わってから確定する。 */
interface StepDraft {
  readonly featureId: string;
  readonly name: string;
  readonly key: string;
  readonly plan: SolidStepPlan;
}

/** visible を決める前の三角形の形のボディ(段と同じ流儀。FR-802、§2.8)。 */
type MeshBodyDraft = Omit<ResolvedMeshBody, 'visible'>;

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
 * 拘束まで解いたスケッチ(`ConstrainedSketch`)を、外へ返す形(`ResolvedPartSketch`)へ詰め替える。
 * `resolveSketchesAndReferences` の中で2か所(球の基準点の解決 タスク19b、最終の一覧)から
 * 同じ詰め替えが要るので、ここへ1つだけ置く(同じ規則を2か所に書かない)。
 */
function toResolvedPartSketch(sketchId: string, constrained: ConstrainedSketch): ResolvedPartSketch {
  return {
    sketchId,
    resolved: constrained.resolved,
    diagnosis: constrained.diagnosis,
    constraintErrors: constrained.errors,
  };
}

/**
 * スケッチと基準ジオメトリを、互いを頼りながら解く(P4 タスク9)。
 *
 * スケッチは作図面として任意の作業平面(FR-328)を指せて、その作業平面はスケッチの点を
 * 基準にできる。どちらを先に解くかは決められないので、**頼まれたときに解いて覚える**形にする。
 * 解いている最中のスケッチをもう一度頼まれたら null を返し、基準ジオメトリ側が
 * 「循環しています」と断る(FR-504。無限に呼び合わない)。
 */
function resolveSketchesAndReferences(
  document: PartDocument,
  options: Required<Pick<ResolvePartOptions, 'offsetCurves' | 'projectedCurves'>> &
    Pick<ResolvePartOptions, 'subShape'>,
): {
  readonly sketches: readonly ResolvedPartSketch[];
  readonly references: ResolvedReferences;
  readonly workPlane: (planeId: WorkPlaneId) => WorkPlane | null;
  /** 点の参照の解決(拡大縮小の中心 FR-424 が使う。P5 タスク45)。 */
  readonly point: (reference: PointReference) => Vec3 | null;
  readonly axisFrames: ReadonlyMap<string, AxisFrame>;
} {
  const { offsetCurves, projectedCurves, subShape } = options;
  // 拘束まで解いた結果を覚える(FR-313、P4b タスク8)。**スケッチを解く場所は
  // この関数の中の 2 か所だけ**で、どちらも `resolveConstrainedSketch` を通す
  // (片方だけ差し替えると拘束が効かない経路が残る。P4 タスク21 の教訓)。
  const resolvedSketches = new Map<string, ConstrainedSketch>();
  const resolvingSketches = new Set<string>();

  /**
   * 球の基本形状(FR-429)を id で引き、中心と半径にする(球面上の点 FR-431、P5 タスク19b)。
   *
   * 球を引くのは部品文書の側の役目(`resolveCoordinate.ts` の `ResolveContext.sphere` の
   * 注釈)。中心は `resolveSolidOrigin`(基本形状の基準点の正本)、半径は `shape.radius.value`
   * をそのまま使う(同じ規則を2か所に書かない)。
   *
   * **その時点までに解決できたスケッチだけ**を渡す。スケッチの解決はこの関数の中で
   * 「頼まれたときに解いて覚える」形になっており、球の基準点にまだ解けていないスケッチの
   * 点(`SolidOrigin.sketchPoint`)を指していれば `resolveSolidOrigin` が missingProfile を
   * 返し、ここでは null(呼び出し側の「球が見つかりません」)になる。基準点に立体の頂点
   * (`SolidOrigin.vertex`)を指す球も同じ理由で解けない(`bodyKeys` はソリッドの段を作る前
   * なのでまだ空)。どちらも P5 タスク19b の検証範囲(座標で指定した球)には現れない。
   */
  function sphereAt(sphereFeatureId: string): ResolvedSphere | null {
    const feature = document.solids.find((candidate) => candidate.id === sphereFeatureId);
    if (feature === undefined || feature.kind !== 'primitive' || feature.shape.kind !== 'sphere') {
      return null;
    }
    if (feature.suppressed) {
      // 抑制した球は画面に無いので、その球面上の点も置けない(計画書 §2.8.1 の断り)。
      return null;
    }
    const radius = feature.shape.radius.value;
    if (!Number.isFinite(radius) || radius <= 0) {
      return null;
    }
    const knownSketches: readonly ResolvedPartSketch[] = Array.from(
      resolvedSketches.entries(),
    ).map(([sketchId, constrained]) => toResolvedPartSketch(sketchId, constrained));
    const origin = resolveSolidOrigin(
      feature.id,
      feature.origin,
      knownSketches,
      new Map<string, string>(),
    );
    return origin.ok ? { center: origin.value.origin, radius } : null;
  }

  const solveOne = (sketch: SketchDocument): ConstrainedSketch =>
    resolveConstrainedSketch(sketch, {
      workPlane: (planeId) => resolver.workPlane(planeId),
      offsetCurves,
      projectedCurves,
      subShape,
      sphere: sphereAt,
    });

  const resolver = createReferenceResolver(document, {
    sketch: (sketchId) => {
      const remembered = resolvedSketches.get(sketchId);
      if (remembered !== undefined) {
        return remembered.resolved;
      }
      if (resolvingSketches.has(sketchId)) {
        return null;
      }
      const found = document.sketches.find((sketch) => sketch.id === sketchId);
      if (found === undefined) {
        return null;
      }
      resolvingSketches.add(sketchId);
      const constrained = solveOne(found);
      resolvingSketches.delete(sketchId);
      resolvedSketches.set(sketchId, constrained);
      return constrained.resolved;
    },
    // 基準ジオメトリ(FR-328、FR-329)も同じ口で「いまの形」を見る(タスク25)。
    subShape,
  });

  // 基準ジオメトリを先に解く(スケッチが作図面として使うため)。中で必要になった
  // スケッチはその場で解かれ、覚えられる。
  const references = resolver.resolveAll();
  const axisFrames = new Map<string, AxisFrame>(
    references.axes.map((axis) => [axis.featureId, { origin: axis.origin, direction: axis.direction }]),
  );

  const sketches: ResolvedPartSketch[] = document.sketches.map((sketch) => {
    const remembered = resolvedSketches.get(sketch.id);
    const constrained = remembered ?? solveOne(sketch);
    if (remembered === undefined) {
      resolvedSketches.set(sketch.id, constrained);
    }
    return toResolvedPartSketch(sketch.id, constrained);
  });

  return {
    sketches,
    references,
    workPlane: resolver.workPlane,
    point: resolver.point,
    axisFrames,
  };
}

/* ------------------------------------------------------------------ *
 * 投影・交差の解決順序(FR-325、§0.a-0.11、タスク25)
 * ------------------------------------------------------------------ */

/** 軸の指定がスケッチの線分を指しているなら、そのスケッチの id。 */
function axisSketchIds(spec: AxisSpec): readonly string[] {
  return spec.kind === 'line' ? [spec.line.sketchId] : [];
}

/**
 * 点の参照(`PointReference`)が指しているスケッチの id(FR-325 の順序の制約、タスク46)。
 *
 * `PointReference` は**どのスケッチかを持たない**(`{ kind: 'point'; pointId }` のように
 * フィーチャーの id だけ)ので、`resolveReferences.ts` と同じ約束で**全スケッチを id で
 * 探す**。座標の式・立体の頂点・球面上の点はスケッチを見ないので null になる。
 *
 * これが要るのは、拡大縮小の中心(FR-424)と点集合パターンの点(FR-425)だけが
 * 「スケッチを使うのに参照からスケッチ id を読めない」種類だからである。数え上げられないと
 * §0.a-0.11 の順序の制約(投影のもとにできるのは、そのスケッチを使う立体より前の立体だけ)が
 * その 2 種で効かず、**自分より後の立体を投影したスケッチの点で穴を並べられてしまう**
 * (docs/報告記録.md 2026-09-05 19:38 の t43 → t46 への申し送り)。
 */
export function sketchIdOfPointReference(
  reference: PointReference,
  sketches: readonly SketchDocument[],
): string | null {
  let featureId: string | null = null;
  if (reference.kind === 'point') {
    featureId = reference.pointId;
  } else if (reference.kind === 'vertex') {
    featureId = reference.featureId;
  }
  if (featureId === null) {
    return null;
  }
  const owner = sketches.find((sketch) =>
    sketch.features.some((feature) => feature.id === featureId),
  );
  return owner === undefined ? null : owner.id;
}

/** 点の参照の並びから、重複を除かずにスケッチの id を集める(並びは呼び出し側で使わない)。 */
function pointSketchIds(
  references: readonly PointReference[],
  sketches: readonly SketchDocument[],
): readonly string[] {
  return references.flatMap((reference) => {
    const sketchId = sketchIdOfPointReference(reference, sketches);
    return sketchId === null ? [] : [sketchId];
  });
}

/**
 * 1 つのソリッドフィーチャーが使うスケッチの id(FR-325 の順序の制約、タスク25)。
 *
 * 「投影のもとにできるのは、そのスケッチを使う立体より前に作られた立体だけ」(§0.a-0.11)を
 * 機械的に判定するために要る。断面・回転軸・穴の中心・ばねの始点・パターンの向きの
 * どれもスケッチを指しうるので、種類ごとに列挙する(網羅 switch なので、
 * 新しいソリッドフィーチャーを足すとここで型検査が落ちて足し忘れを防げる)。
 */
export function referencedSketchIds(
  feature: SolidFeature,
  sketches: readonly SketchDocument[] = [],
): readonly string[] {
  switch (feature.kind) {
    case 'extrude':
      return [feature.profile.sketchId];
    case 'revolve':
      return [feature.profile.sketchId, ...axisSketchIds(feature.axis)];
    case 'sew':
      return feature.faces.map((face) => face.sketchId);
    case 'boolean':
      return [];
    case 'hole':
    case 'threadHole':
      return feature.centers.map((center) => center.sketchId);
    case 'fillet':
    case 'chamfer':
      // 辺・頂点の指紋しか持たない(スケッチを見ない)。
      return [];
    case 'pattern':
      return patternSketchIds(feature.placement, sketches);
    case 'spring':
      return [feature.origin.sketchId, ...axisSketchIds(feature.axis)];
    case 'primitive':
      // 基本形状(FR-429、タスク15)。スケッチを見るのは中心にスケッチの点を指したときだけで、
      // 座標の式・立体の頂点はスケッチを使わない。向きの軸は他の種類と同じ扱い。
      return [
        ...(feature.origin.kind === 'sketchPoint' ? [feature.origin.ref.sketchId] : []),
        ...axisSketchIds(feature.axis),
      ];
    case 'ruled':
      // 面をつなぐ(FR-430、タスク25)。スケッチを見るのは断面が「スケッチの面」のときだけで、
      // 立体の面・球はスケッチを使わない。
      return sectionSketchIds([feature.first, feature.second]);
    case 'loft':
      return sectionSketchIds(feature.sections);
    /*
      P5 の Should 群(§2.11、タスク43)。**参照の欄はこの段で確定しているので、
      「どのスケッチを使うか」はいまここで正しく数え上げる**(解決の実装を待たない)。
      §0.a-0.11 の順序の制約は解決の成否と無関係に効く判定だからである。
    */
    case 'draft':
    case 'mirror':
    case 'threadShaft':
    case 'shell':
      // 面の指紋とフィーチャーの id しか持たない(スケッチを見ない)。
      // くり抜き(FR-418、§2.12)も同じで、開ける面は指紋で持つ。
      return [];
    case 'emboss':
      // 相手の面は指紋で、輪郭だけがスケッチの面フィーチャー。
      return [feature.profile.sketchId];
    case 'transform':
      return feature.rotationAxis === null ? [] : axisSketchIds(feature.rotationAxis);
    case 'scale':
      // 中心の点はスケッチの点でありうる。`PointReference` は「どのスケッチか」を持たない
      // ので、**スケッチの一覧を渡されたときだけ** id で探して数える(タスク46。
      // 渡されないときは P5 タスク43 のまま空——既存の呼び出しのふるまいを変えないため)。
      return pointSketchIds([feature.origin], sketches);
    case 'sweep':
      return [feature.profile.sketchId, feature.path.sketchId];
    case 'rib':
      return [feature.profile.sketchId];
    case 'surface':
      return surfaceSketchIds(feature.operation);
    case 'cut':
      // 切断(FR-432、タスク27c)。切断面の点がスケッチの点でありうるので、拡大縮小の
      // 中心とまったく同じ扱いで id から探す(スケッチの一覧を渡されたときだけ数える)。
      return planeSketchIds(feature.plane, sketches);
    case 'importedSolid':
    case 'importedMesh':
      // 読み込んだ形(FR-802、P6 §2.8)。**スケッチを 1 本も見ない**(ファイルから入った
      // 形そのものなので、参照の欄が 1 つも無い)。
      return [];
  }
}

/**
 * 平面の指定(`PlaneSpec`)が使うスケッチの id(FR-325 の順序の制約、タスク27c)。
 *
 * 点は `PointReference` で「どのスケッチか」を持たないので、`scale` の中心・点集合
 * パターンと同じく **id で全スケッチから探す**(`pointSketchIds`)。面・辺は指紋なので
 * スケッチを見ない。基準にする作業平面(`workPlane` / `tilted`)が使うスケッチは
 * 基準ジオメトリ側の依存で、ここでは数えない(`referenceDependencies` の役目)。
 */
function planeSketchIds(
  spec: PlaneSpec,
  sketches: readonly SketchDocument[],
): readonly string[] {
  switch (spec.kind) {
    case 'threePoints':
      return pointSketchIds([spec.p1, spec.p2, spec.p3], sketches);
    case 'pointAndEdge':
    case 'pointAndParallelFace':
      return pointSketchIds([spec.point], sketches);
    case 'pointAndAxis':
      return [...pointSketchIds([spec.point], sketches), ...axisSketchIds(spec.axis)];
    case 'face':
    case 'workPlane':
      return [];
    case 'tilted':
      return axisSketchIds(spec.axis);
  }
}

/** パターンの並べ方が使うスケッチの id(FR-411、FR-412、FR-425)。 */
function patternSketchIds(
  placement: PatternPlacement,
  sketches: readonly SketchDocument[],
): readonly string[] {
  switch (placement.kind) {
    case 'linear':
      return axisSketchIds(placement.direction);
    case 'circular':
      return axisSketchIds(placement.axis);
    case 'points':
      // 点集合(FR-425)。`scale` の中心とまったく同じ扱いで、id から探す(タスク46)。
      return pointSketchIds(placement.points, sketches);
  }
}

/** 曲面の作り方が使うスケッチの id(FR-428、タスク43・46)。 */
function surfaceSketchIds(operation: SurfaceOperation): readonly string[] {
  switch (operation.kind) {
    case 'extrude':
    case 'planar':
      return [operation.profile.sketchId];
    case 'revolve':
      return [operation.profile.sketchId, ...axisSketchIds(operation.axis)];
    case 'loft':
      return operation.sections.map((section) => section.sketchId);
    case 'face':
    case 'offset':
      // 立体の面を取り出す(離す)だけなのでスケッチを見ない。
      return [];
  }
}

/** 罫線面・ロフトの断面が使うスケッチの id(スケッチの面を指したものだけ)。 */
function sectionSketchIds(sections: readonly RuledSection[]): readonly string[] {
  return sections.flatMap((section) =>
    section.kind === 'sketchFace' ? [section.ref.sketchId] : [],
  );
}

/**
 * スケッチごとに「そのスケッチを最初に使うソリッドフィーチャーの履歴上の位置」を作る。
 * 使われていないスケッチは表に入らない(= どの立体を参照してもよい)。
 * 抑制されたフィーチャー(FR-503)はボディを作らないので数えない。
 */
function firstSketchUseIndexes(
  solids: readonly SolidFeature[],
  sketches: readonly SketchDocument[],
): ReadonlyMap<string, number> {
  const first = new Map<string, number>();
  solids.forEach((feature, index) => {
    if (feature.suppressed) {
      return;
    }
    for (const sketchId of referencedSketchIds(feature, sketches)) {
      if (!first.has(sketchId)) {
        first.set(sketchId, index);
      }
    }
  });
  return first;
}

/** 参照先の立体が見つからない(未作成・抑制中・上流が失敗・削除された)。 */
function missingProjectionBodyMessage(source: ProjectionSource): string {
  return source.kind === 'subShape'
    ? '投影のもとになる立体が見つかりません。立体を選び直してください。'
    : '断面をとる立体が見つかりません。立体を選び直してください。';
}

/** 順序違反(自分より後に作られる立体を指した)。§0.a-0.11 の制約。 */
function laterProjectionBodyMessage(source: ProjectionSource): string {
  const what = source.kind === 'subShape' ? '投影' : '断面';
  return `${what}のもとにできるのは、このスケッチを使う立体より前に作られた立体だけです。履歴の順序を見直してください。`;
}

/**
 * `resolvePart` へ渡せるもの(P4 タスク21・25、FR-321、FR-325、FR-330)。
 *
 * オフセット(FR-321)と投影・交差(FR-325)の実際の形は OCCT に任せてある(タスク15・26)
 * ので、`resolveSketch` と同じく「計算済みの形を覚え書きから読むだけ」の関数を渡す。
 * まだ計算していないものは `ResolvedSketch.pendingOffsets` / `ResolvedPart.projections` へ
 * 積まれ、カーネルへ頼んで埋めるのは `recomputePart` の役目。
 */
export interface ResolvePartOptions {
  readonly offsetCurves?: (key: string) => readonly ResolvedCurve[] | null;
  /** 計算済みの投影・交差の曲線をフィーチャーの id で引く(タスク25)。 */
  readonly projectedCurves?: (featureId: string) => readonly ResolvedCurve[] | null;
  /**
   * 立体の面・辺・頂点の選び直し(FR-325、FR-328〜330 の上流追従、タスク25)。
   *
   * 渡されなければ保存された指紋の位置・向きをそのまま使う
   * (`geometry/planeSpec.ts` の `subShapeFromFingerprint`)。**渡すと、3D スケッチの
   * 頂点参照・任意の作業平面・基準ジオメトリが「いまの形」を見るようになる**
   * (指紋の位置に固定されなくなる)。選び直しの採点はカーネル側の純関数が正本で、
   * この関数を作るのは `recomputePart`(`kernelBridge.ts` の `selectSubShape`)である。
   */
  readonly subShape?: (reference: SubShapeRef) => ResolvedSubShape | null;
  /**
   * 読み込んだ形(FR-802、P6 §2.8、タスク20)の B-rep のバイト列の置き場。
   * **渡されなければ空**で、`importedSolid` の段は「読み込んだ形が見つかりません」で失敗する。
   *
   * 中身は `.pcad` の ZIP の `shapes/<shapeRef>.brep` をそのまま読んだバイト列で、
   * 表を組み立てるのは `packages/io`(タスク21)、ここまで運ぶのは `recomputePart` である。
   * 曲線の覚え書き(`offsetCurves` / `projectedCurves`)を関数で受けているのと違って表
   * (`ReadonlyMap`)で受けるのは、①中身が読み込んだ時点で全部そろっていて後から埋まる
   * ことがない、②`.pcad` の添付をそのまま持ち回れる、の 2 つによる。
   */
  readonly importedShapes?: ImportedShapeBytes;
}

/**
 * 読み込んだ形のバイト列の置き場(FR-802、P6 §2.8、§0.a-0.9)。
 * 鍵は `ImportedSolidFeature.shapeRef`、値は `shapes/<shapeRef>.brep` の中身。
 */
export type ImportedShapeBytes = ReadonlyMap<string, Uint8Array>;

/** 読み込んだ形が 1 つも無い文書のための、空の置き場(毎回作らずに使い回す)。 */
const NO_IMPORTED_SHAPES: ImportedShapeBytes = new Map<string, Uint8Array>();

/** まだ計算していないオフセットが無いときに使う、常に null を返す関数。 */
function noOffsetCurves(): null {
  return null;
}

/** まだ計算していない投影・交差が無いときに使う、常に null を返す関数。 */
function noProjectedCurves(): null {
  return null;
}

/** 部品文書を解決して、カーネルへ渡す段の一覧を作る。例外を投げない(FR-504)。 */
export function resolvePart(document: PartDocument, options: ResolvePartOptions = {}): ResolvedPart {
  const { sketches, references, workPlane, point, axisFrames } = resolveSketchesAndReferences(
    document,
    {
      offsetCurves: options.offsetCurves ?? noOffsetCurves,
      projectedCurves: options.projectedCurves ?? noProjectedCurves,
      subShape: options.subShape,
    },
  );
  // 面・辺・頂点の位置は、選び直しの関数があればそれ、無ければ保存された指紋から取る
  // (`resolveReferences.ts` の `resolveSubShape` とまったく同じ既定。§0.a-0.33)。
  const context: SolidPlanContext = {
    subShape: options.subShape ?? subShapeFromFingerprint,
    workPlane,
    point,
    axisFrames,
    sketchDocuments: document.sketches,
  };

  const importedShapes = options.importedShapes ?? NO_IMPORTED_SHAPES;

  const drafts: StepDraft[] = [];
  /** 読み込んだ三角形の形(FR-802、§2.8)。段にならないので別の一覧へ積む。 */
  const meshDrafts: MeshBodyDraft[] = [];
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
    if (feature.kind === 'importedMesh') {
      /*
        読み込んだ三角形の形(FR-802、§2.8、§0.a-0.23)。**カーネルの段を作らない**ので
        `bodyKeys` にも入れない——入れると下流の穴・ブーリアンが「あるはずの形」を指して
        しまい、断りがカーネルまで届いてから出ることになる。ここで入れずにおけば、
        対象に指した加工は `importedMeshTargetError` が文書だけを見て理由つきで断る。
      */
      meshDrafts.push({
        featureId: feature.id,
        name: feature.name,
        meshRef: feature.meshRef,
        triangleCount: feature.triangleCount,
        volume: feature.volume ?? null,
      });
      continue;
    }
    const outcome = planSolid(
      feature,
      document.solids,
      sketches,
      bodyKeys,
      consumed,
      context,
      importedShapes,
    );
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

  // 三角形の形も段と同じ規則で `visible` を決める(いまは必ず true。`ResolvedMeshBody` の注釈)。
  const meshBodies: ResolvedMeshBody[] = meshDrafts.map((draft) => ({
    ...draft,
    visible: !consumed.has(draft.featureId),
  }));

  // まだ形の無い投影・交差(FR-325)を、段の鍵がそろったここで組み立てる。
  // 段のループの中ではなくループの後で行うのは、①鍵はループが作るもの、
  // ②順序の制約は「そのスケッチを使う立体より前か」で決まり、履歴全体を見ないと
  // 判定できない、の 2 つによる(§0.a-0.11)。
  const projections = collectProjections(document, sketches, bodyKeys, errors);

  /*
    生きたボディの id を**文書の履歴の順**で並べる(FR-502)。段と三角形の形が混ざるので、
    2 つの一覧を継ぎ足すのではなく文書の並びで拾い直す。三角形の形が 1 つも無い文書では
    段の並び = 文書の並びなので、P2 からの結果と 1 つも変わらない。
  */
  const liveIds = new Set<string>([
    ...steps.filter((step) => step.visible).map((step) => step.featureId),
    ...meshBodies.filter((body) => body.visible).map((body) => body.featureId),
  ]);

  return {
    sketches,
    references,
    steps,
    meshBodies,
    projections,
    errors,
    liveBodyIds: document.solids
      .filter((feature) => liveIds.has(feature.id))
      .map((feature) => feature.id),
  };
}

/**
 * まだ形の無い投影・交差を、カーネルへ頼める形(`ResolvedProjection`)へ組み立てる。
 * 参照先が見つからない・順序違反のものは頼まず、理由を `errors` へ積む(FR-504)。
 */
function collectProjections(
  document: PartDocument,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  errors: PartError[],
): readonly ResolvedProjection[] {
  const anyPending = sketches.some((entry) => entry.resolved.pendingProjections.length > 0);
  if (!anyPending) {
    // 投影・交差を持たない部品(ほとんどの部品)では、表も作らず素通りする(NFR-PF-3)。
    return [];
  }
  const bodyOrder = new Map<string, number>();
  document.solids.forEach((feature, index) => {
    if (!bodyOrder.has(feature.id)) {
      bodyOrder.set(feature.id, index);
    }
  });
  // 点の参照からスケッチを引けるように、スケッチの一覧も渡す(FR-425・FR-424、タスク46)。
  const firstUse = firstSketchUseIndexes(document.solids, document.sketches);

  const requests: ResolvedProjection[] = [];
  for (const entry of sketches) {
    for (const pending of entry.resolved.pendingProjections) {
      const request = planProjection(
        entry.sketchId,
        pending,
        bodyKeys,
        bodyOrder,
        firstUse.get(entry.sketchId),
      );
      if (!request.ok) {
        errors.push(request.error);
        continue;
      }
      requests.push(request.projection);
    }
  }
  return requests;
}

type ProjectionOutcome =
  | { readonly ok: true; readonly projection: ResolvedProjection }
  | { readonly ok: false; readonly error: PartError };

/** 1 件の投影・交差について、参照先と順序を確かめてから鍵を作る。 */
function planProjection(
  sketchId: string,
  pending: PendingProjection,
  bodyKeys: ReadonlyMap<string, string>,
  bodyOrder: ReadonlyMap<string, number>,
  firstUseIndex: number | undefined,
): ProjectionOutcome {
  const bodyFeatureId = projectionBodyFeatureId(pending.source);
  const bodyKey = bodyKeys.get(bodyFeatureId);
  if (bodyKey === undefined) {
    return {
      ok: false,
      error: partError(
        pending.featureId,
        'missingBody',
        missingProjectionBodyMessage(pending.source),
      ),
    };
  }
  // 順序の制約(§0.a-0.11)。そのスケッチをどの立体も使っていなければ制約は無い。
  const bodyIndex = bodyOrder.get(bodyFeatureId);
  if (
    firstUseIndex !== undefined &&
    bodyIndex !== undefined &&
    bodyIndex >= firstUseIndex
  ) {
    return {
      ok: false,
      error: partError(
        pending.featureId,
        'missingBody',
        laterProjectionBodyMessage(pending.source),
      ),
    };
  }
  return {
    ok: true,
    projection: {
      sketchId,
      featureId: pending.featureId,
      key: projectionCacheKey({ bodyKey, source: pending.source, plane: pending.plane }),
      bodyKey,
      source: pending.source,
      plane: pending.plane,
    },
  };
}
