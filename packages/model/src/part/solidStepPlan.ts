import type { FunctionSurfacePlan as TypeFunctionSurfacePlan } from '../functionGeometry/functionSurfaceFeature.js';
import type { FaceOrigin, HoleCenterAnchor, HolePlacementRole } from '../geometry/subShapeOrigin.js';
import type { SheetSolidPlan } from '../sheetMetal/resolveSheetGeometry.js';
import type { PointReference, ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import type { FaceRotatePlan, HoleTranslatePlan } from './directEditOperations.js';
import type { FaceOffsetPlan } from './directFaceEdit.js';
import type { IndependentCurveProfileOrigin, IndependentProfileOrigin } from './profileOrigins.js';
import type { BlendPlan, OffsetBodyPlan, ThickenPlan } from './surfaceBodyPlan.js';
import type { BooleanOperation, RuledSphereSegments, SubShapeRef, ThicknessSide } from './types.js';

/**
 * 工具全体にかける剛体変換(パターン、FR-411 / FR-412)。
 * kernel の `RigidTransformSpec` と同じ形だが別の型にして、kernelBridge が詰め替える
 * (NFR-MA-1)。回転角はラジアン(度からの換算は model の責務)。
 *
 * 穴・ねじ穴では**必ず空配列**を渡す。並べるのはパターンだけで、
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
 * 当初の案は `SubShapeFingerprint & { index: number }`(kernel の `SubShapeQuery` と
 * 同じ平らな形)としていたが、**保存形の `SubShapeRef` をそのまま持ち回る**形にした。理由は2つ:
 *   - 鍵の材料に混ぜる文字列は `subShapeRef.ts` の `fingerprintKeyText(ref)` が作り、
 *     これが `bodyFeatureId` を必要とする。平らに崩すと鍵を作れない。
 *   - 崩して詰め直すには指紋の種類ごとの分岐を2か所(ここと kernelBridge)に書くことになる。
 * 平らな `SubShapeQuery` へ崩すのは kernelBridgeの1か所だけにする。
 */
export type SubShapeQueryPlan = SubShapeRef;

/**
 * 罫線面・ロフト(FR-430、FR-410)の断面 1 つの解決結果。
 *
 * 種類は kernel の `ThruSectionSpec` と同じ意味で並べる(詰め替えは `kernelBridge.ts`)。
 * スケッチの面は輪郭の座標まで解けるが、**立体の面は指紋のまま段へ乗せる**
 * (輪郭を取り出せるのはカーネルだけ。穴の面とまったく同じ扱い)。
 * 球は縁を持たないので中心と半径で渡す。
 */
export type ThruSectionPlan =
  | { readonly kind: 'curves'; readonly curves: readonly ResolvedCurve[] }
  | { readonly kind: 'sphere'; readonly center: Vec3; readonly radius: number }
  | {
      readonly kind: 'faceQuery';
      /**
       * 面を持つ立体の段の鍵。**この段はその立体を消費しない**ので、
       * 加工フィーチャーの `targetKey` と違い `consumedTargetsOf` には現れない。
       * 鍵に混ぜるのは、上流が変われば輪郭も変わるようにするためだけである(NFR-PF-3)。
       */
      readonly targetKey: string;
      /** 輪郭にする面の指紋。必ず面(`kind: 'face'`)で、選び直しはカーネルが行う。 */
      readonly query: SubShapeQueryPlan;
    };

/**
 * 押し出しの終端(FR-415)を解決した結果。
 *
 * 4 種と欄名は kernel の `ExtrudeEndSpec`(`occt/makeSolidSweep.ts`)と同じで、距離は mm。
 * **`toFace`(選んだ面まで)の距離は model が計算して数値で渡す**ので、
 * カーネルから見ると `distance` と同じ扱いになる。`toNext`(次の面まで)だけは相手の形が
 * 要るので、段の `targetKey` と組で使う。
 *
 * **`distance` と `symmetric` の段は従来のまま**(`SolidStepPlan.extrude` の注釈)なので、
 * ここへ現れるのは `toFace` と `toNext` だけである。4 種を書いてあるのは、カーネルの型と
 * 1 対 1 に保って詰め替えを分岐なしにするためと、鍵の材料(`ExtrudeEndKeyMaterial`)が
 * 同じ 4 種を持つためである。
 */
export type ExtrudeEndPlan =
  | { readonly kind: 'distance'; readonly distance: number }
  | { readonly kind: 'symmetric'; readonly forward: number; readonly backward: number }
  | { readonly kind: 'toFace'; readonly distance: number }
  | { readonly kind: 'toNext' }
  /** 輪郭による貫通切断。`toNext` と同じく段の `targetKey` と組で使う(対象は名指し)。 */
  | { readonly kind: 'throughTarget' };

/** 薄板押し出し(FR-416)。kernel の `ThinExtrudeSpec` と同じ欄名。 */
export interface ThinExtrudePlan {
  /** 壁の厚み(mm)。0 より大きい。 */
  readonly thickness: number;
  readonly side: ThicknessSide;
}

/**
 * 穴・ねじ穴の入口の形(ざぐり・皿もみ。FR-422)を解決した結果。
 *
 * 3 種と欄名は kernel の `HoleEntrySpec`(`occt/makeHole.ts`)と同じで、**皿もみの角度は
 * ラジアン**(文書は度で持ち、換算はここが行う。`HoleEntry` の注釈)。
 * **皿もみの円錐の深さは持たない**——頭径・穴の径・角度からカーネルが導くためである
 * (導出できるものは渡さない)。
 *
 * `plain`(広げない)の段は**この欄そのものを省く**ので、入口を指定していない穴と
 * 「広げない」を明示した穴は段も鍵も 1 ドット違わない(押し出しの終端と同じ決め)。
 */
export type HoleEntryPlan =
  | { readonly kind: 'counterbore'; readonly diameter: number; readonly depth: number }
  /** `angle` は**ラジアン**。 */
  | { readonly kind: 'countersink'; readonly diameter: number; readonly angle: number };

/** 面内X・Yをmmへ解決した配置。面の再照合と世界座標への変換はkernelが行う。 */
interface PlaneFaceHolePlan {
  readonly kind: 'plane-face';
  readonly locations: readonly { readonly x: number; readonly y: number }[];
}
/** 辺からの距離をmmへ解決した配置(M-02)。2本の辺の再照合・材料のある側・交点はkernelが今の形で行う。 */
interface EdgeDistanceHolePlan {
  readonly kind: 'edge-distance';
  readonly edge1: SubShapeQueryPlan;
  readonly edge2: SubShapeQueryPlan;
  readonly locations: readonly { readonly distance1: number; readonly distance2: number }[];
}
export type PlanarHolePlan = PlaneFaceHolePlan | EdgeDistanceHolePlan;

/**
 * 円筒の側面の穴の位置を解決した結果。kernel の `CylindricalHoleSpec` と同じ形なので
 * `kernelBridge` はそのまま渡せる。高さは mm、角度は**ラジアン**(度からの換算は model の責務)。
 * **平面の穴では段にこの欄を載せない**(省略と今までの段を同じ鍵にする)。
 */
export interface CylindricalHolePlan {
  readonly kind: 'cylinder-face';
  readonly locations: readonly { readonly height: number; readonly angle: number }[];
}

/**
 * 丸める半径(FR-407、可変半径は FR-426)を解決した結果。
 *
 * kernel の `FilletRadiusSpec` と同じ形(`number | { start; end }`)にしてあるので、
 * `kernelBridge` はそのまま渡せる。`start` は辺の始点側、`end` は終点側の半径(mm)。
 */
export type FilletRadiusPlan = number | { readonly start: number; readonly end: number };

/**
 * 曲面の作り方(FR-428)を解決した結果。6 種。
 *
 * 種類と欄名は kernel の `SurfaceInput`(`occt/makeSurface.ts`)に揃えてあるので、
 * `kernelBridge` は曲線と指紋を詰め替えるだけで渡せる。角度はラジアン、距離は mm。
 * **`face` と `offset` だけが立体の面を材料にする**が、どちらも借りるだけで消費しない
 * (罫線面の `faceQuery`・基本形状の頂点と同じ扱い)。
 */
export type SurfaceShapePlan =
  | {
      readonly kind: 'extrude';
      readonly profile: readonly ResolvedCurve[];
      readonly curveProfileOrigin?: Extract<FaceOrigin, { readonly kind: 'surface-curve-side' }>['profile'];
      readonly profileOrigins?: readonly Extract<FaceOrigin, { readonly kind: 'surface-side' }>['profile'][];
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
  | {
      readonly kind: 'planar';
      readonly profile: readonly ResolvedCurve[];
      /** Saved owners of a closed straight-line profile, one per curve in order; absent for any other profile. */
      readonly profileOrigins?: readonly Extract<FaceOrigin, { readonly kind: 'surface-side' }>['profile'][];
    }
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

export type SurfaceCutBladePlan =
  | { readonly kind: 'plane'; readonly origin: Vec3; readonly normal: Vec3 }
  | {
      readonly kind: 'extrusion'; readonly profile: readonly ResolvedCurve[];
      readonly planeOrigin: Vec3; readonly planeNormal: Vec3;
    }
  | { readonly kind: 'surface'; readonly sourceKey: string };

/**
 * model 側の「1段の作り方」。kernel の SolidStepSpec とは別の型にして、
 * kernelBridgeが詰め替える(NFR-MA-1。model は kernel の型を再輸出しない)。
 * 向き・反転・両側の平行移動はここまでで済ませてあり、kernel へは断面・向き・長さだけが渡る。
 */
export type SolidStepPlan =
  | ThickenPlan
  | BlendPlan
  | OffsetBodyPlan
  | TypeFunctionSurfacePlan
  | SheetSolidPlan
  // 平らな面の移動(限られた一段)。形は directFaceEdit.ts が持つ。**対象を消費する。**
  | FaceOffsetPlan
  | HoleTranslatePlan
  | FaceRotatePlan
  | {
      readonly kind: 'extrude';
      /** 断面の閉ループ。両側(symmetric)のときは平行移動した後の座標。 */
      readonly profile: readonly ResolvedCurve[];
      readonly holes?: readonly (readonly ResolvedCurve[])[];
      /** Proven saved whole line/spline region, paired with profile curves; legacy four-line IDs are retained. */
      readonly profileOrigin?: IndependentProfileOrigin | IndependentCurveProfileOrigin;
      /** 押し出す向き(単位ベクトル)。反転(reversed)を適用した後の向き。 */
      readonly direction: Vec3;
      /**
       * 押し出す長さ(mm)。正の数。両側でも半分にしない(断面をずらして表す)。
       * 「選んだ面まで」(FR-415)のときは**面まで測った距離**が入る(利用者が入れた長さは
       * 使わない)ので、`end` を見ないカーネルでも同じ形になる。
       */
      readonly distance: number;
      /**
       * どこまで押し出すか(FR-415)。**省略は「距離ぶんを片側へ」と同じ。**
       *
       * **両側(`symmetric`)でも省略する。** 断面を距離の半分だけ逆向きへ動かすのは
       * 以前からの model の役目で、`profile` にその平行移動が入っている。
       * ここへ kernel の `symmetric`(前後の長さ)を重ねて渡すと、カーネルがもう一度
       * 同じぶんだけずらしてしまう。したがって現れるのは `toFace` と `toNext` だけ。
       */
      readonly end?: ExtrudeEndPlan;
      /**
       * 側面の傾き(**ラジアン**、FR-401)。大きさだけを持ち、向きは `taperOutward`。
       * 省略・0 は「傾けない」(従来の押し出しと同じ形)。
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
      /** 既存の面の入力。元参照を保持し、現在形状との照合はカーネルへ渡す。 */
      readonly faces?: readonly { readonly targetKey: string; readonly query: SubShapeRef }[];
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
      /** パターンでは、元の加工結果に追加する工具の配置。空配列は元の結果を引き継ぐ。 */
      readonly transforms?: readonly RigidTransform[];
      /** 和の形から、リブが足した材料だけを写す指定。 */
      readonly patternTool?: 'rib';
      /** 何も削れない差を断るか(`BooleanFeature.requireRemoval`)。立てたときだけ欄がある。 */
      readonly requireRemoval?: true;
    }
  | {
      readonly kind: 'hole';
      /** Cache input evidence, independent of eligibility for semantic naming. */
      readonly pointPlacementReferences?: readonly { readonly slotId: string; readonly reference: PointReference }[];
      readonly centerAnchors?: readonly HoleCenterAnchor[];
      readonly placementRoles?: readonly HolePlacementRole[];
      /** 穴をあける対象のボディの鍵。この段が消費する。 */
      readonly targetKey: string;
      /** 穴をあける面。カーネルが指紋で選び直し、平面と法線を取り出す。 */
      readonly face: SubShapeQueryPlan;
      /** 面へ投影する前の中心点(mm)。投影はカーネルが行う。利用者が選んだ順のまま並べる。 */
      readonly centers: readonly Vec3[];
      readonly diameter: number;
      /** 貫通なら null(長さはカーネルが境界箱から決める)。止まり穴なら深さ(mm)。 */
      readonly depth: number | null;
      /** 面の法線からの傾き(ラジアン)。0 以上 π/2 未満。 */
      readonly tiltAngle: number;
      /** 傾ける向き(面内の方位角、ラジアン)。基準は面の第1軸。 */
      readonly tiltAzimuth: number;
      readonly transforms: readonly RigidTransform[];
      /**
       * 入口の形(ざぐり・皿もみ。FR-422)。**広げないときは省く**
       * (`HoleEntryPlan` の注釈。省略と「広げない」を同じ段・同じ鍵にするため)。
       */
      readonly entry?: HoleEntryPlan;
      /** 円筒の側面の穴。**平面の穴では省く**(`CylindricalHolePlan` の注釈)。 */
      readonly cylindrical?: CylindricalHolePlan;
      readonly planar?: PlanarHolePlan;
    }
  | {
      readonly kind: 'thread';
      /**
       * 下穴の面の由来の材料。穴の段と同じ意味(下穴は穴と同じ手順で掘る)。中心の生成元が分かる時だけ
       * 両方を載せる(無い時は欄ごと省き、今までの段・鍵と 1 字も変えない)。
       */
      readonly centerAnchors?: readonly HoleCenterAnchor[];
      readonly placementRoles?: readonly HolePlacementRole[];
      readonly targetKey: string;
      readonly face: SubShapeQueryPlan;
      readonly centers: readonly Vec3[];
      /** 下穴の径(mm)。既定はめねじ内径 D1。 */
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
      /** 実らせんを切るときだけ入る。簡略表示のときは null。 */
      readonly thread: {
        readonly majorDiameter: number;
        readonly pitch: number;
        readonly length: number;
      } | null;
      /**
       * 3D の簡略表示に使うねじの印(B-rep には触らない)。
       * kernel 側は `ThreadMarkSpec | null` だが、**model は簡略表示でも実らせんでも必ず作る**
       * ので null を取らない(印は実形状のときも出す)。
       */
      readonly mark: { readonly majorDiameter: number; readonly length: number };
      /**
       * 入口の形(ざぐり・皿もみ。FR-422)。**広げないときは省く**
       * (`HoleEntryPlan` の注釈と同じ約束。穴の枝と1文字も違わない扱い)。
       */
      readonly entry?: HoleEntryPlan;
      /** 円筒の側面のねじ穴。**平面のねじ穴では省く**(穴の枝の `cylindrical` と同じ)。 */
      readonly cylindrical?: CylindricalHolePlan;
      readonly planar?: PlanarHolePlan;
    }
  | {
      readonly kind: 'spring';
      /** らせんの軸の始点(mm)。 */
      readonly origin: Vec3;
      /** 軸の向き(単位ベクトル)。傾きを適用した後。 */
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
      /** 丸める対象のボディの鍵。この段が消費する。 */
      readonly targetKey: string;
      /** 丸める辺・頂点の指紋。通し番号の昇順に並べる(鍵を安定させるため)。 */
      readonly targets: readonly SubShapeQueryPlan[];
      /**
       * 丸める半径(mm)。0 より大きい。**可変半径(FR-426)のときは始点と終点の 2 値**
       * (`FilletRadiusPlan`)。一定半径のときは以前と同じ数 1 つで、段も鍵も変わらない。
       */
      readonly radius: FilletRadiusPlan;
    }
  | {
      readonly kind: 'chamfer';
      /** 面を取る対象のボディの鍵。この段が消費する。 */
      readonly targetKey: string;
      /** 面を取る辺の指紋。通し番号の昇順に並べる(fillet と同じ理由)。 */
      readonly targets: readonly SubShapeQueryPlan[];
      readonly size:
        | { readonly kind: 'equal'; readonly distance: number }
        | { readonly kind: 'twoDistances'; readonly distance1: number; readonly distance2: number }
        | { readonly kind: 'distanceAngle'; readonly distance: number; readonly angle: number };
      /** 2距離・距離角度のときの基準面を、辺に接する2面のうち後の方にするか。 */
      readonly swapReferenceFace: boolean;
    }
  | {
      readonly kind: 'primitive';
      /**
       * 基準点(mm)。球・箱・トーラスは中心、円柱・円錐は底面の中心。
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
       * 基準点にする「立体の頂点」の指紋(FR-429)。座標の式・スケッチの点なら null。
       * **選び直しはカーネルが行う**(model は面・辺・頂点の位置を持たないため、穴の面と同じ扱い)。
       */
      readonly originQuery: SubShapeQueryPlan | null;
      /**
       * `originQuery` の頂点を持つ立体の段の鍵。`originQuery` が null なら null。
       * **この段はその立体を消費しない**(頂点の座標を読むだけ)ので、
       * 加工フィーチャーの `targetKey` と違い `consumedTargetsOf` には現れない。
       */
      readonly targetKey: string | null;
    }
  | {
      /**
       * 輪郭をつないで立体にする段(罫線面 FR-430・ロフト FR-410)。
       *
       * **model のフィーチャーは 2 種類(`ruled` / `loft`)だが、段は 1 種類**にまとめる
       * (カーネルでは `ruled` の真偽しか違わないので、同じものを 2 つ作らない)。
       * 対象を取らない「作る」段で、輪郭を貸した立体は消費しない。
       */
      readonly kind: 'thruSections';
      readonly smooth: boolean;
      /** つなぐ断面。2 つ以上。並びが意味を持つ。 */
      readonly sections: readonly ThruSectionPlan[];
      /** true なら直線で結ぶ(罫線面)、false ならなめらかに結ぶ(ロフト)。 */
      readonly ruled: boolean;
      /** 両端に面を張って閉じた立体にするか。いまは常に true。 */
      readonly closed: boolean;
      /** ねじれの補正(整数)。小数は解決のときに断ってあるのでここへは来ない。 */
      readonly twist: number;
      /**
       * 球へつなぐときの近似の点の数。球を含まない段でも
       * 既定(`DEFAULT_RULED_SPHERE_SEGMENTS`)が入る(段の欄を種類で出し分けないため)。
       */
      readonly sphereSegments: RuledSphereSegments;
    }
  | {
      /**
       * 抜き勾配(FR-417)。**対象を消費する。**
       * 面の選び直しはカーネルが行う(model は指紋を渡すだけ。穴の面と同じ扱い)。
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
       * ミラー(FR-419)。平面に対する鏡像のボディを 1 つ作る。
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
       * 移動/回転(FR-424)。**対象を消費する。**
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
       * 拡大縮小(FR-424)。**対象を消費する。**
       * `uniform` と `perAxis` は**どちらか一方だけ**が入る(解決が正規化する)。
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
       * スイープ(FR-409)。断面を経路に沿って掃く。
       * **対象を取らない「作る」段**(押し出し・ばね・基本形状と同じ)。
       */
      readonly kind: 'sweep';
      /** 掃く断面の閉ループ。 */
      readonly profile: readonly ResolvedCurve[];
      /** 経路。並びが意味を持つ(書かれた順につながっている前提)。 */
      readonly path: readonly ResolvedCurve[];
      readonly guide?: readonly ResolvedCurve[];
      /** true で Frenet、false(既定)で「ねじれを抑える」。 */
      readonly frenet: boolean;
      /** M-07。全体で回す角度(ラジアン)。0 の時は欄を持たない。 */
      readonly twist?: number;
      /** M-07。終わりの断面の倍率。1 の時は欄を持たない。 */
      readonly endScale?: number;
      /** M-07。中空の壁の厚み(mm)。中実の時は欄を持たない。 */
      readonly wallThickness?: number;
      /** M-07。穴つきの面を断面にした時の穴の線。穴の無い面では欄を持たない。 */
      readonly holes?: readonly (readonly ResolvedCurve[])[];
    }
  | {
      /**
       * リブ(FR-420)。開いた輪郭に厚みを付けた壁を足す。
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
       * 材料に届くまで伸ばすか(FR-420)。false は伸ばさず輪郭の厚みぶんだけの壁。
       * カーネルの段(`RibStepSpec.extendToBody`)と同じ欄名で、鍵にも必ず混ぜる
       * (`cacheKey.ts` の `RibKeyMaterial.extendToBody` の注釈)。
       */
      readonly extendToBody: boolean;
    }
  | {
      /**
       * エンボス(FR-421)。平らな面へ輪郭を彫る / 浮き出す。
       * **対象を消費する。**
       */
      readonly kind: 'emboss';
      readonly targetKey: string;
      /** 相手の面の指紋。平らな面だけ(選び直しはカーネル)。 */
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
       * 外ねじ(FR-423)。円柱面にねじを切る。**対象を消費する。**
       * 呼び径は規格表(`thread/metricThread.ts`)から引き、軸の実寸との食い違いは
       * 解決が先に断る(`THREAD_SHAFT_DIAMETER_TOLERANCE_MM`)。
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
       * 曲面(FR-428)。**面だけのボディ**を作る。
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
       * くり抜き(シェル。FR-418)。壁の厚さを残して中身を抜く。
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
       * 平面による切断(FR-432)。**対象を消費し、残す側 1 つ**を作る。
       *
       * 平面(`PlaneSpec` の 7 種)は解決が「通る点+単位法線」の数値まで解いてから
       * 載せる。カーネルは平面 1 枚しか要らないので、指紋を段へ運ばない
       * (「カーネルへの往復を増やさない」)。
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
      readonly kind: 'surfaceCut';
      readonly targetKey: string;
      readonly blade: SurfaceCutBladePlan;
      readonly keepPositive: boolean;
    }
  | {
      /**
       * 読み込んだ形(ベースボディ。FR-802)。**対象を取らない「作る」段。**
       *
       * 段がすることは「抱き込んであるバイト列から B-rep を戻す」ことだけである
       * (カーネルの `ImportedSolidStepSpec`)。
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
  /** この段を作ったフィーチャーの id。作られるボディの id でもある。 */
  readonly featureId: string;
  /** 進捗表示とツリーに出す名前(FR-501、NFR-PF-4)。鍵には混ぜない。 */
  readonly name: string;
  /** 形状キャッシュの鍵。同じ鍵なら作り直さない(NFR-PF-3)。 */
  readonly key: string;
  readonly plan: SolidStepPlan;
  /** 画面に出すか。ブーリアンに消費されたボディは false。 */
  readonly visible: boolean;
}
