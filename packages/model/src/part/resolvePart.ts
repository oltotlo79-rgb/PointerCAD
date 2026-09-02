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
 */

import { degreesToRadians } from '../sketch/planeMath.js';
import { arcPointAt, fitPlaneNormal, resolveSketch } from '../sketch/resolveSketch.js';
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
import { cacheKeyFor, type KeyCurve, type KeyVec3, type SolidStepKeyMaterial } from './cacheKey.js';
import type {
  BooleanFeature,
  BooleanOperation,
  ExtrudeFeature,
  PartDocument,
  RevolveAxis,
  RevolveFeature,
  SewFeature,
  SketchFaceRef,
  SolidFeature,
} from './types.js';

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

/** ワールド軸の向き(§0.a-0.9)。既定は z。 */
const WORLD_AXIS_DIRECTIONS: Readonly<Record<'x' | 'y' | 'z', Vec3>> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** 平面の当てはめに使う円弧の標本点の数(両端を含む)。resolveSketch の平面判定と揃える。 */
const ARC_PLANE_SAMPLES = 5;

/** 角度の上限(度)。全周を超える回転は受け付けない(§0.a-0.9)。 */
const MAX_REVOLVE_DEGREES = 360;

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
  if (curve.kind === 'segment') {
    return [curve.from, curve.to];
  }
  const span = curve.endAngle - curve.startAngle;
  const samples: Vec3[] = [curve.center];
  for (let index = 0; index < ARC_PLANE_SAMPLES; index += 1) {
    samples.push(arcPointAt(curve, curve.startAngle + (span * index) / (ARC_PLANE_SAMPLES - 1)));
  }
  return samples;
}

/** 曲線をベクトルぶん平行移動する(押し出しの「両側へ」に使う、§0.a-0.8)。 */
export function translateCurve(curve: ResolvedCurve, offset: Vec3): ResolvedCurve {
  if (curve.kind === 'segment') {
    return { ...curve, from: addVec3(curve.from, offset), to: addVec3(curve.to, offset) };
  }
  // 円弧は中心だけを動かす。法線・第1軸・半径・角度は平行移動で変わらない。
  return { ...curve, center: addVec3(curve.center, offset) };
}

/** 回転軸を解決する。world 軸は原点+単位ベクトル、スケッチの線分は始点+向き(§0.a-0.9)。 */
export function resolveRevolveAxis(
  axis: RevolveAxis,
  sketches: readonly ResolvedPartSketch[],
): RevolveAxisFrame | null {
  if (axis.kind === 'world') {
    return { origin: ORIGIN, direction: WORLD_AXIS_DIRECTIONS[axis.axis] };
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

function fail(featureId: string, code: PartErrorCode, message: string): PlanOutcome {
  return { ok: false, error: { featureId, code, message } };
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
function planRevolve(feature: RevolveFeature, sketches: readonly ResolvedPartSketch[]): PlanOutcome {
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
  const frame = resolveRevolveAxis(feature.axis, sketches);
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

function planSolid(
  feature: SolidFeature,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): PlanOutcome {
  switch (feature.kind) {
    case 'extrude':
      return planExtrude(feature, sketches);
    case 'revolve':
      return planRevolve(feature, sketches);
    case 'sew':
      return planSew(feature, sketches);
    case 'boolean':
      return planBoolean(feature, bodyKeys, consumed);
  }
}

function toKeyVec3(vector: Vec3): KeyVec3 {
  return [vector[0], vector[1], vector[2]];
}

/**
 * 解決済みの曲線を鍵の材料へ詰め替える(cacheKey.ts の KeyCurve)。
 * featureId は形に関わらないので落とす。詰め替えを省いて渡さないのは、
 * 材料の型が「鍵に混ぜる欄」の定義そのものであり、偶然の構造の一致に頼らないため。
 */
function toKeyCurve(curve: ResolvedCurve): KeyCurve {
  if (curve.kind === 'segment') {
    return { kind: 'segment', from: toKeyVec3(curve.from), to: toKeyVec3(curve.to) };
  }
  return {
    kind: 'arc',
    center: toKeyVec3(curve.center),
    normal: toKeyVec3(curve.normal),
    xAxis: toKeyVec3(curve.xAxis),
    radius: curve.radius,
    startAngle: curve.startAngle,
    endAngle: curve.endAngle,
  };
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
  }
}

/** visible を決める前の段。消費はすべての段を見終わってから確定する。 */
interface StepDraft {
  readonly featureId: string;
  readonly name: string;
  readonly key: string;
  readonly plan: SolidStepPlan;
}

/** 部品文書を解決して、カーネルへ渡す段の一覧を作る。例外を投げない(FR-504)。 */
export function resolvePart(document: PartDocument): ResolvedPart {
  const sketches: ResolvedPartSketch[] = document.sketches.map((sketch) => ({
    sketchId: sketch.id,
    resolved: resolveSketch(sketch),
  }));

  const drafts: StepDraft[] = [];
  const errors: PartError[] = [];
  /** 作成に成功したボディの鍵。ここに無い id は下流から参照できない。 */
  const bodyKeys = new Map<string, string>();
  /** すでにブーリアンが消費したボディ。同じものを2度は使えない(§2.2)。 */
  const consumed = new Set<string>();

  for (const feature of document.solids) {
    // 抑制は失敗ではない(FR-503)。ボディを作らず、errors にも入れない。
    if (feature.suppressed) {
      continue;
    }
    const outcome = planSolid(feature, sketches, bodyKeys, consumed);
    if (!outcome.ok) {
      errors.push(outcome.error);
      continue;
    }
    const key = cacheKeyFor(keyMaterialFor(outcome.plan));
    drafts.push({ featureId: feature.id, name: feature.name, key, plan: outcome.plan });
    bodyKeys.set(feature.id, key);
    if (feature.kind === 'boolean') {
      consumed.add(feature.targetFeatureId);
      consumed.add(feature.toolFeatureId);
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
    steps,
    errors,
    liveBodyIds: steps.filter((step) => step.visible).map((step) => step.featureId),
  };
}
