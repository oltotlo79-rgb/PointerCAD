/**
 * 配置の数学(四元数と剛体変換)。計画書 P7 §2.4、タスク2。FR-601 / NFR-RE-3 / NFR-RE-4。
 *
 * アセンブリに置いた部品 1 つの「どこに・どちら向きに」を、**位置 3 数 + 四元数 4 数**で
 * 持つ(§0.5)。4×4 行列で持たないのは、反復のたびに正規化 1 回で回転へ戻せて、
 * 行列を直に入れたときのような「回転でなくなる」丸め誤差の漏れが起きないため。
 *
 * **すべて純関数で、OCCT にも three にも触れない**(Node の Vitest だけで検査できる)。
 * kernel の `RigidTransformSpec` へは model 側の `RigidTransform`(`part/resolvePart.ts`)
 * を経由して渡す。model は `kernelBridge.ts` 以外から `@pointercad/kernel` を輸入しない
 * 約束(rules/04-設計の規律.md の依存方向)なので、ここは model の型だけを使う。
 *
 * **四元数の規約**(§2.4): `q = (x, y, z, w)`、`w = cos(θ/2)`、`(x, y, z) = 軸 × sin(θ/2)`。
 * `q` と `−q` は同じ回転なので、**`w >= 0` へ符号を揃える**(§0.54 の決定性。同じ文書を
 * 2 回解いて配置が完全に一致することを、この 1 か所の正規化で担保する)。
 *
 * **数値精度**(rules/04): 長さ・角度の比較はすべて `QUATERNION_TOLERANCE` を明示して行い、
 * 割り算の前に必ず分母を確かめる。NaN・∞ が来たら**投げずに**恒等へ落とす(FR-504
 * 「止めずに警告する」。断りの文言は上位の層が出す)。−0 は +0 へ揃える(`vec3.ts` の
 * `cleanZeroVec3` と同じ理由: 比較・表示・保存の文字列を揺らさないため)。
 */

import type { RigidTransform } from '../part/resolvePart.js';
import { addVec3, cleanZeroVec3, ORIGIN, type Vec3 } from '../sketch/vec3.js';

/**
 * 向きを表す四元数 `(qx, qy, qz, qw)`。**長さ 1・`w >= 0`** に揃えたものだけを持ち回る
 * (揃えるのは `normalizeQuaternion` の 1 か所)。
 */
export type Quaternion = readonly [number, number, number, number];

/**
 * 剛体の配置(位置 + 向き)。点は `p' = R(q)·p + t` で写る。
 *
 * 保存形の `Placement`(タスク1 の `assembly/types.ts`)は位置を**式**
 * (`ExpressionValue`)で持つが、ここは式を数へ解いた後の値だけを扱う。式から数へ
 * 直すのはアセンブリの解決(タスク6 `resolveAssembly.ts`)の役目。
 */
export interface RigidPlacement {
  readonly position: Vec3;
  readonly rotation: Quaternion;
}

/** 軸と角の組。既存の `RigidTransform`(軸+角)との橋渡しに使う。 */
export interface AxisAngle {
  /** 長さ 1 の回転軸。角が 0 のときは軸が決まらないので `[0, 0, 1]`(§1.4-8)。 */
  readonly axis: Vec3;
  /** 回転角(ラジアン)。`w >= 0` へ揃えてあるので必ず `0 <= θ <= π`。 */
  readonly angleRadians: number;
}

/**
 * 四元数・軸の長さの許容誤差。
 *
 * `1e-12` は「これ未満の長さは 0 とみなす」線引きで、`exponentialMap` の 1 次近似へ
 * 切り替える境目(§2.4 の手順3)と同じ値を使う。倍精度の刻み(2.2e-16)より 4 桁大きく、
 * 検査で要求される往復の精度(1e-12)を割らない位置に置いてある。
 */
export const QUATERNION_TOLERANCE = 1e-12;

/** 何も回さない向き。`w = cos(0) = 1`。 */
export const IDENTITY_QUATERNION: Quaternion = [0, 0, 0, 1];

/** 何も動かさない配置。 */
export const IDENTITY_PLACEMENT: RigidPlacement = {
  position: ORIGIN,
  rotation: IDENTITY_QUATERNION,
};

/** −0 を +0 へ揃える(`vec3.ts` の `cleanZeroVec3` の四元数版)。 */
function cleanZeroQuaternion(rotation: Quaternion): Quaternion {
  return [
    rotation[0] === 0 ? 0 : rotation[0],
    rotation[1] === 0 ? 0 : rotation[1],
    rotation[2] === 0 ? 0 : rotation[2],
    rotation[3] === 0 ? 0 : rotation[3],
  ];
}

function isFiniteQuaternion(rotation: Quaternion): boolean {
  return (
    Number.isFinite(rotation[0]) &&
    Number.isFinite(rotation[1]) &&
    Number.isFinite(rotation[2]) &&
    Number.isFinite(rotation[3])
  );
}

/**
 * 符号を揃えるための係数(+1 か −1)。
 *
 * `w > 0` なら +1、`w < 0` なら −1(§0.54 の「`w >= 0` へ揃える」)。**`w` がちょうど 0
 * のとき**(180° 回転)は `w` だけでは `q` と `−q` を区別できないので、`x → y → z` の順で
 * 最初に 0 でない成分が正になる側を選ぶ。ここまで決めておかないと、同じ 180° の回転が
 * 実行のたびに違う符号で保存されうる(§0.54 が求める決定性が崩れる)。
 */
function leadingSign(rotation: Quaternion): number {
  const [x, y, z, w] = rotation;
  if (w !== 0) {
    return w > 0 ? 1 : -1;
  }
  if (x !== 0) {
    return x > 0 ? 1 : -1;
  }
  if (y !== 0) {
    return y > 0 ? 1 : -1;
  }
  if (z !== 0) {
    return z > 0 ? 1 : -1;
  }
  return 1;
}

/**
 * 長さ 1・`w >= 0` へ揃える(§0.54)。**符号の反転はここ 1 か所だけで行う。**
 *
 * 長さが取れない(0 に近い)ときと、NaN・∞ が混ざっているときは恒等を返す。投げないのは
 * FR-504(止めずに警告する)の流儀で、`vec3.ts` の `normalizeVec3` が長さ 0 で原点を返すのと
 * 同じ約束。値が壊れていることは呼び出し側(配置を作る層)が先に断る。
 */
export function normalizeQuaternion(rotation: Quaternion): Quaternion {
  if (!isFiniteQuaternion(rotation)) {
    return IDENTITY_QUATERNION;
  }
  const size = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (size <= QUATERNION_TOLERANCE) {
    return IDENTITY_QUATERNION;
  }
  const factor = leadingSign(rotation) / size;
  return cleanZeroQuaternion([
    rotation[0] * factor,
    rotation[1] * factor,
    rotation[2] * factor,
    rotation[3] * factor,
  ]);
}

/**
 * 「軸と角度」から四元数を作る(§2.4)。`q = (a·sin(θ/2), cos(θ/2))`、`a` は長さ 1 の軸。
 *
 * 軸の長さが 0(向きが決まらない)ときは恒等を返す。回しようがないので、`vec3.ts` の
 * `rotateDirection` が長さ 0 の軸で元の向きをそのまま返すのと同じ扱いにしてある。
 * **利用者に四元数は見せない**(§0.5)。画面の欄はこの「軸と角度」のまま。
 */
export function quaternionFromAxisAngle(axis: Vec3, angleRadians: number): Quaternion {
  const size = Math.hypot(axis[0], axis[1], axis[2]);
  if (!Number.isFinite(size) || size <= QUATERNION_TOLERANCE || !Number.isFinite(angleRadians)) {
    return IDENTITY_QUATERNION;
  }
  const half = angleRadians / 2;
  const scale = Math.sin(half) / size;
  return normalizeQuaternion([axis[0] * scale, axis[1] * scale, axis[2] * scale, Math.cos(half)]);
}

/**
 * 四元数から「軸と角度」へ戻す(§2.4)。`θ = 2·acos(clamp(w, −1, 1))`、`a = (x,y,z)/sin(θ/2)`。
 *
 * 先に `normalizeQuaternion` を通すので `w >= 0`、つまり返す角は必ず `0 <= θ <= π` になる。
 * `θ > π` の回転を渡すと、同じ回転を表す「逆向きの軸まわりの `2π − θ`」として返る
 * (回転としては同じもの。§0.54 の符号揃えの当然の帰結)。
 *
 * **`θ = 0`(`|w| ≈ 1`)のときは軸が決まらない**ので `[0, 0, 1]` を入れる。既存の
 * `IDENTITY_TRANSFORM`(kernel の `transformShape.ts`)が Z 軸を入れているのと同じ流儀で、
 * 長さ 0 の軸を返すと下流の「軸が決まりません」の検査に引っかかるため(§1.4-8)。
 */
export function quaternionToAxisAngle(rotation: Quaternion): AxisAngle {
  const [x, y, z, w] = normalizeQuaternion(rotation);
  // acos の外側へ出た丸め(|w| がわずかに 1 を超える)で NaN にならないよう挟み込む。
  const clamped = Math.min(1, Math.max(-1, w));
  const angleRadians = 2 * Math.acos(clamped);
  // sin(θ/2) は正規化済みなので √(1 − w²) と等しい。ここが 0 に近いと軸が決まらない。
  const sinHalf = Math.sqrt(Math.max(0, 1 - clamped * clamped));
  if (sinHalf <= QUATERNION_TOLERANCE) {
    return { axis: [0, 0, 1], angleRadians: 0 };
  }
  return {
    axis: cleanZeroVec3([x / sinHalf, y / sinHalf, z / sinHalf]),
    angleRadians,
  };
}

/**
 * 向きを四元数で回す(§2.4 の回転行列 `R` をそのまま展開したもの)。
 *
 * 渡された四元数は長さ 1 とは限らない(反復の途中の値が来る)ので、必ず正規化してから使う。
 * 正規化を省くと長さの 2 乗ぶんだけ拡大縮小が混ざり、剛体変換でなくなる。
 */
export function rotateVector(rotation: Quaternion, vector: Vec3): Vec3 {
  const [x, y, z, w] = normalizeQuaternion(rotation);
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  const [vx, vy, vz] = vector;
  return cleanZeroVec3([
    (1 - 2 * (yy + zz)) * vx + 2 * (xy - wz) * vy + 2 * (xz + wy) * vz,
    2 * (xy + wz) * vx + (1 - 2 * (xx + zz)) * vy + 2 * (yz - wx) * vz,
    2 * (xz - wy) * vx + 2 * (yz + wx) * vy + (1 - 2 * (xx + yy)) * vz,
  ]);
}

/**
 * 四元数の積 `q₁·q₂`。**「先に `q₂` で回し、次に `q₁` で回す」**合成
 * (`R(q₁·q₂) = R(q₁)·R(q₂)`)。
 *
 * 計画書 §2.4 が挙げる関数一覧には無いが、`composePlacement` が回転の合成に要る。
 * 積の式を `composePlacement` の中へ埋め込むとサブアセンブリの入れ子(§2.11)や
 * ジョイントの駆動(タスク20)から使えず、同じ式を書き写すことになるので独立させた。
 */
export function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return normalizeQuaternion([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

/**
 * 配置の合成 `(q₁, t₁) ∘ (q₂, t₂) = (q₁·q₂, R(q₁)·t₂ + t₁)`(§2.4)。
 *
 * **「外側 ∘ 内側」の順**で、点には内側から掛かる(`合成(p) = 外側(内側(p))`)。
 * サブアセンブリの入れ子(§2.11)で、親の配置を `outer`、子の配置を `inner` に渡す。
 */
export function composePlacement(outer: RigidPlacement, inner: RigidPlacement): RigidPlacement {
  return {
    position: addVec3(rotateVector(outer.rotation, inner.position), outer.position),
    rotation: multiplyQuaternion(outer.rotation, inner.rotation),
  };
}

/** 点へ配置をかける。`p' = R(q)·p + t`(§2.4)。 */
export function applyPlacementToPoint(placement: RigidPlacement, point: Vec3): Vec3 {
  return cleanZeroVec3(addVec3(rotateVector(placement.rotation, point), placement.position));
}

/**
 * 向きへ配置をかける。**平行移動は向きを変えないので使わない**(`transformShape.ts` の
 * `applyTransformToDirection` と同じ約束)。入れた向きの長さはそのまま保たれる。
 */
export function applyPlacementToDirection(placement: RigidPlacement, direction: Vec3): Vec3 {
  return rotateVector(placement.rotation, direction);
}

/**
 * 配置を既存の `RigidTransform`(平行移動 + 回転軸 + 回転角)へ写す(§1.4-8)。
 *
 * `RigidTransform` は「原点まわりに回してから平行移動する」形なので、`rotationOrigin` に
 * 原点を入れれば `p' = R(q)·p + t` とぴったり一致する(kernel の `applyTransformToPoint` /
 * `makeTransform` がこの順序であることを、あちらの検査が固定している)。
 * 回転角が 0 のときの軸は `[0, 0, 1]`(`quaternionToAxisAngle` が入れる)。
 */
export function placementToRigidTransform(placement: RigidPlacement): RigidTransform {
  const { axis, angleRadians } = quaternionToAxisAngle(placement.rotation);
  return {
    translation: cleanZeroVec3(placement.position),
    rotationOrigin: ORIGIN,
    rotationAxis: axis,
    rotationAngle: angleRadians,
  };
}

/**
 * 回転ベクトル(向き = 軸、長さ = 角)から四元数へ(指数写像、§2.4 の手順3)。
 *
 * 合致のソルバ(タスク13〜15)が回転の増分をこの 3 数で持つため、反復のたびに
 * ここで四元数へ直す。`θ = |ω|` として
 *   - `θ < QUATERNION_TOLERANCE` のときは `(ω/2, 1)`(`sin(θ/2)/θ → 1/2` の 1 次近似)、
 *   - そうでなければ `(ω/θ · sin(θ/2), cos(θ/2))`。
 *
 * **分岐の目的は 0 割りを避けること。** `θ` が 0 のとき `ω/θ` は NaN になるが、1 次近似の
 * 側は割り算を含まないので、どんなに小さい `ω` でも NaN にならない(検査で固定した)。
 */
export function exponentialMap(rotationVector: Vec3): Quaternion {
  const theta = Math.hypot(rotationVector[0], rotationVector[1], rotationVector[2]);
  if (!Number.isFinite(theta)) {
    return IDENTITY_QUATERNION;
  }
  if (theta < QUATERNION_TOLERANCE) {
    return normalizeQuaternion([
      rotationVector[0] / 2,
      rotationVector[1] / 2,
      rotationVector[2] / 2,
      1,
    ]);
  }
  const scale = Math.sin(theta / 2) / theta;
  return normalizeQuaternion([
    rotationVector[0] * scale,
    rotationVector[1] * scale,
    rotationVector[2] * scale,
    Math.cos(theta / 2),
  ]);
}
