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
 */

import { subShapeFromFingerprint, type ResolvedSubShape } from '../geometry/planeSpec.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { polarOffset, type WorkPlane } from './planeMath.js';
import type { CoordinateInput, PointReference, ResolvedPoint, SketchError } from './types.js';
import { addVec3, ORIGIN, type Vec3 } from './vec3.js';

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
