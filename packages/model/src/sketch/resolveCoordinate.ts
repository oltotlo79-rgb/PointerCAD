/**
 * 1 点の指定(絶対・相対・極)をワールド座標へ直す(計画書 docs/plans/P1-式とスケッチ.md タスク10)。
 *
 * 例外を投げず、失敗も戻り値(ResolveOutcome)で返す。1 つの点が解決できなくても
 * 残りのフィーチャーの解決を続け、理由をツリーへ出せるようにするため(FR-504、NFR-RE-1)。
 *
 * 履歴全体をたどるのはタスク11 の担当で、ここは「そこまでに解決できたもの」を
 * ResolveContext で受け取るだけにする。前方参照・自己参照が手掛かりに含まれないのは
 * その組み立て方の当然の帰結で、ここでは他の見つからない参照と同じ missingBase になる。
 *
 * P4 タスク10(FR-330、3D スケッチ)で 2 つ広げた。①作図面は無いことがある
 * (`ResolveContext.plane` が null。絶対・相対はそのまま解け、極座標だけ断る)。
 * ②基準に立体の部分形状(頂点・辺・面)を選べる(`PointReference` の `subShape`)。
 *
 * P5 タスク19(FR-431、球面グリッド)でもう 1 つ広げた。③基準に球面上の点を選べる
 * (`PointReference` の `sphereGrid`)。球は立体の側にしか無いので、`subShape` と同じく
 * 「引く口」(`ResolveContext.sphere`)を外から渡してもらう。
 */

import { subShapeFromFingerprint, type ResolvedSubShape } from '../geometry/planeSpec.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { degreesToRadians, polarOffset, type WorkPlane } from './planeMath.js';
import type { CoordinateInput, PointReference, ResolvedPoint, SketchError } from './types.js';
import { addVec3, ORIGIN, type Vec3 } from './vec3.js';

/**
 * 球面上の点(FR-431)の土台になる球。**中心と半径だけ**を見る。
 *
 * 基本形状の向き(`PrimitiveFeature.axis`)を持たないのは、緯度・経度の基準を世界の軸に
 * 固定すると決めたため(`PointReference` の `sphereGrid` の注釈、計画書 §2.8.1)。
 */
export interface ResolvedSphere {
  readonly center: Vec3;
  readonly radius: number;
}

/**
 * 球面上の点の断り(FR-431、計画書 §2.8.1)。球が消えた・球でない・まだ作られていない
 * (前方参照)のどれも、利用者から見れば「選び直す」で直るので 1 つの文言にまとめる。
 */
export const MISSING_SPHERE_MESSAGE = '球が見つかりません。球を選び直してください。';

/** 緯度が範囲外のときの断り(FR-431、計画書 タスク19 の断り方の表)。 */
export const LATITUDE_RANGE_MESSAGE = '緯度は −90 度から 90 度の間で指定してください。';

/**
 * 球面上の点の位置(FR-431、計画書 §2.8.1)。
 *
 *   点 = C + r(cos φ cos λ, cos φ sin λ, sin φ)   φ = 緯度、λ = 経度(どちらも度)
 *
 * 中心 C と半径 r を掛け合わせるだけなので、**球を動かす・大きさを変えると点も追従する**
 * (要件 FR-431)。経度は剰余を取らずそのまま三角関数へ渡す(450 度は 90 度と同じ点になる)。
 */
export function sphereGridPosition(
  sphere: ResolvedSphere,
  latitudeDegrees: number,
  longitudeDegrees: number,
): Vec3 {
  const latitude = degreesToRadians(latitudeDegrees);
  const longitude = degreesToRadians(longitudeDegrees);
  const ring = sphere.radius * Math.cos(latitude);
  return addVec3(sphere.center, [
    ring * Math.cos(longitude),
    ring * Math.sin(longitude),
    sphere.radius * Math.sin(latitude),
  ]);
}

/** 端点の手掛かりを引く鍵。ResolveContext.vertices を組み立てる側もこれを使う。 */
export function vertexKey(featureId: string, vertex: 'start' | 'end' | 'center'): string {
  return `${featureId}:${vertex}`;
}

/** 解決に使える手掛かり。フィーチャーを履歴順にたどりながら育てる。 */
export interface ResolveContext {
  /**
   * そのフィーチャーの作図面。極座標の角度と仰角の基準(§2.8)。
   * **3D スケッチ(FR-330、`planeId` が `FREE_WORK_PLANE_ID`)では null**。
   * 絶対・相対の指定は作図面を見ないのでそのまま解けるが、極座標は基準になる
   * 第1軸・第2軸が無いので断る(§0.a-0.5。UI も 3D スケッチでは極を出さない)。
   */
  readonly plane: WorkPlane | null;
  /** ここまでに解決できた点。id は点フィーチャーなら featureId、点列の n 番目なら `featureId#n`。 */
  readonly points: readonly ResolvedPoint[];
  /**
   * そのフィーチャーより前で最後に作られた点(FR-302 の「直前の点」)。無ければ null。
   * 点列の直後なら末尾の点を渡す。どれが直前かの判断は履歴をたどる側が行う。
   */
  readonly previous: Vec3 | null;
  /** 要素の端点・中心。鍵は vertexKey() の形。 */
  readonly vertices: ReadonlyMap<string, Vec3>;
  /**
   * 立体の部分形状(頂点・辺・面)の選び直し(FR-330、タスク10)。
   * 渡されなければ保存された指紋の位置をそのまま使う(`subShapeFromFingerprint`)。
   *
   * スケッチ 1 本は立体を知らないので、**上流の立体の変化への追従は部品文書の側**
   * (`resolvePart.ts`。タスク25 で配線する)がこの口へ選び直しの関数を渡して行う。
   * `geometry/planeSpec.ts` の `PlaneResolveContext.subShape` と同じ形にしてあるので、
   * 部品文書側は同じ関数を両方へそのまま渡せる。
   */
  readonly subShape?: (reference: SubShapeRef) => ResolvedSubShape | null;
  /**
   * 球の基本形状(FR-429)を id から引く(球面上の点 FR-431、P5 タスク19)。
   *
   * `subShape` と同じ理由でここを口にしてある。**スケッチ 1 本は立体を知らない**ので、
   * 球の中心・半径を解けるのは部品文書の側(`part/resolveReferences.ts`・`part/resolvePart.ts`)
   * だけである。渡されなければ球を 1 つも知らない扱いになり、球面上の点は
   * `MISSING_SPHERE_MESSAGE` で断る(黙って原点へ落とさない、FR-504)。
   *
   * **前方参照を断るのは渡す側の役目**。まだ作られていない球を口が返さなければ、
   * ここは「球が見つかりません」になる(履歴の順序を知っているのは部品文書の側だから)。
   */
  readonly sphere?: (sphereFeatureId: string) => ResolvedSphere | null;
}

export type ResolveOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SketchError };

function failure(
  featureId: string,
  code: SketchError['code'],
  message: string,
): ResolveOutcome<never> {
  return { ok: false, error: { featureId, code, message } };
}

/** 基準点を求める(FR-302、FR-303)。featureId は失敗を報せるフィーチャー。 */
export function resolvePointReference(
  reference: PointReference,
  context: ResolveContext,
  featureId: string,
): ResolveOutcome<Vec3> {
  switch (reference.kind) {
    case 'origin':
      // ワールド原点。P1 の作図面はすべて原点を通るので平面の原点とも一致する(§2.8)。
      return { ok: true, value: ORIGIN };
    case 'previous':
      if (context.previous === null) {
        return failure(featureId, 'missingBase', '基準になる直前の点がありません。');
      }
      return { ok: true, value: context.previous };
    case 'point': {
      const found = context.points.find((point) => point.id === reference.pointId);
      if (found === undefined) {
        return failure(featureId, 'missingBase', `基準の点が見つかりません: ${reference.pointId}`);
      }
      return { ok: true, value: found.position };
    }
    case 'vertex': {
      const found = context.vertices.get(vertexKey(reference.featureId, reference.vertex));
      if (found === undefined) {
        return failure(
          featureId,
          'missingBase',
          `基準の端点が見つかりません: ${reference.featureId}`,
        );
      }
      return { ok: true, value: found };
    }
    case 'subShape': {
      // 選び直しの口が渡されていなければ、選んだ瞬間の指紋の位置をそのまま使う。
      // 位置は頂点ならその点、辺なら中点、面なら重心(`SubShapeFingerprint` の約束)。
      const resolve = context.subShape ?? subShapeFromFingerprint;
      const found = resolve(reference.ref);
      if (found === null) {
        return failure(
          featureId,
          'missingSubShape',
          '基準にする立体の形が見つかりません。形が大きく変わったため、選び直してください。',
        );
      }
      return { ok: true, value: found.position };
    }
    case 'sphereGrid': {
      // 球が無いことは値の不備より先に伝える(他の基準と同じ順。土台が決まらなければ
      // 緯度・経度の良し悪しを言っても直しようがないため)。
      const sphere = context.sphere?.(reference.sphereFeatureId) ?? null;
      if (sphere === null) {
        return failure(featureId, 'missingBase', MISSING_SPHERE_MESSAGE);
      }
      const invalid = checkFinite(featureId, [
        ['緯度', reference.latitude.value],
        ['経度', reference.longitude.value],
      ]);
      if (invalid !== null) {
        return { ok: false, error: invalid };
      }
      // 緯度は極を越えると裏側へ回り込んでしまい、利用者の意図と一致しない。
      // 経度は 1 周回れば同じ点なので範囲を制限しない(計画書 タスク19 の手順 4)。
      if (reference.latitude.value < -90 || reference.latitude.value > 90) {
        return failure(featureId, 'invalidValue', LATITUDE_RANGE_MESSAGE);
      }
      return {
        ok: true,
        value: sphereGridPosition(sphere, reference.latitude.value, reference.longitude.value),
      };
    }
  }
}

/** 値が数になっているか。式が 1/0 や 0/0 を返した場合をここで捕まえる。 */
function checkFinite(
  featureId: string,
  labeled: readonly (readonly [string, number])[],
): SketchError | null {
  for (const [label, value] of labeled) {
    if (!Number.isFinite(value)) {
      return { featureId, code: 'invalidValue', message: `${label}の値が数になっていません。` };
    }
  }
  return null;
}

/** 1 点の指定をワールド座標へ直す(FR-301〜303)。 */
export function resolveCoordinate(
  input: CoordinateInput,
  context: ResolveContext,
  featureId: string,
): ResolveOutcome<Vec3> {
  if (input.mode === 'absolute') {
    const invalid = checkFinite(featureId, [
      ['X', input.x.value],
      ['Y', input.y.value],
      ['Z', input.z.value],
    ]);
    if (invalid !== null) {
      return { ok: false, error: invalid };
    }
    return { ok: true, value: [input.x.value, input.y.value, input.z.value] };
  }

  // 基準が無いことは値の不備より先に伝える。基準が決まらなければ足す先が無いため。
  const base = resolvePointReference(input.base, context, featureId);
  if (!base.ok) {
    return base;
  }

  if (input.mode === 'relative') {
    const invalid = checkFinite(featureId, [
      ['ΔX', input.dx.value],
      ['ΔY', input.dy.value],
      ['ΔZ', input.dz.value],
    ]);
    if (invalid !== null) {
      return { ok: false, error: invalid };
    }
    return {
      ok: true,
      value: addVec3(base.value, [input.dx.value, input.dy.value, input.dz.value]),
    };
  }

  // 3D スケッチには角度の基準になる作図面が無い(§0.a-0.5、FR-330)。
  // 値の不備より先に伝える。基準が無ければ角度の意味自体が決まらないため。
  if (context.plane === null) {
    return failure(
      featureId,
      'missingBase',
      '3D スケッチでは角度と距離での指定は使えません。座標かずれで指定してください。',
    );
  }

  const invalid = checkFinite(featureId, [
    ['距離', input.distance.value],
    ['角度', input.azimuth.value],
    ['仰角', input.elevation.value],
  ]);
  if (invalid !== null) {
    return { ok: false, error: invalid };
  }
  // 角度は作図面の第1軸から第2軸へ向かう向きが正、仰角は法線側が正(§2.6、§2.8)。
  const offset = polarOffset(
    context.plane,
    input.distance.value,
    input.azimuth.value,
    input.elevation.value,
  );
  return { ok: true, value: addVec3(base.value, offset) };
}
