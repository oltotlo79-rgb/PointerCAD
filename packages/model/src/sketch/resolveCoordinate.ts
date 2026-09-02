/**
 * 1 点の指定(絶対・相対・極)をワールド座標へ直す(計画書 docs/plans/P1-式とスケッチ.md タスク10)。
 *
 * 例外を投げず、失敗も戻り値(ResolveOutcome)で返す。1 つの点が解決できなくても
 * 残りのフィーチャーの解決を続け、理由をツリーへ出せるようにするため(FR-504、NFR-RE-1)。
 *
 * 履歴全体をたどるのはタスク11 の担当で、ここは「そこまでに解決できたもの」を
 * ResolveContext で受け取るだけにする。前方参照・自己参照が手掛かりに含まれないのは
 * その組み立て方の当然の帰結で、ここでは他の見つからない参照と同じ missingBase になる。
 */

import { polarOffset, type WorkPlane } from './planeMath.js';
import type { CoordinateInput, PointReference, ResolvedPoint, SketchError } from './types.js';
import { addVec3, ORIGIN, type Vec3 } from './vec3.js';

/** 端点の手掛かりを引く鍵。ResolveContext.vertices を組み立てる側もこれを使う。 */
export function vertexKey(featureId: string, vertex: 'start' | 'end' | 'center'): string {
  return `${featureId}:${vertex}`;
}

/** 解決に使える手掛かり。フィーチャーを履歴順にたどりながら育てる。 */
export interface ResolveContext {
  /** そのフィーチャーの作図面。極座標の角度と仰角の基準(§2.8)。 */
  readonly plane: WorkPlane;
  /** ここまでに解決できた点。id は点フィーチャーなら featureId、点列の n 番目なら `featureId#n`。 */
  readonly points: readonly ResolvedPoint[];
  /**
   * そのフィーチャーより前で最後に作られた点(FR-302 の「直前の点」)。無ければ null。
   * 点列の直後なら末尾の点を渡す。どれが直前かの判断は履歴をたどる側が行う。
   */
  readonly previous: Vec3 | null;
  /** 要素の端点・中心。鍵は vertexKey() の形。 */
  readonly vertices: ReadonlyMap<string, Vec3>;
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
