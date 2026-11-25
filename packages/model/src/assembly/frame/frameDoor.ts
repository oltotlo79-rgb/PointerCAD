/**
 * パネルと扉(E-10 第 2 段): 選んだ部材 4 本の枠の開口に付ける扉の計画を決める純関数。扉は、扉の枠(パネル用のフレームの外周 4 本、角は留め)・
 * 扉の板(扉の枠の内側にはめる)・ヒンジ 2 つ。形は作らない。
 *
 * - 扉の外形: 開口の内側から各辺の隙間を引いた長方形。扉の枠の中心線は、外形から枠の断面の幅の半分だけ内側の長方形(閉じた 4 本の線)で、
 *   断面の局所 +Y を面の法線 n へ向けて置く(一括配置の道で留めにすると、長い側の面の長さが外形の辺の長さになる)。
 * - 扉の板: 扉の枠の内側(外形から枠の幅を両側から引いた寸法)で、開口の面の位置に置く(パネルと同じ置き方)。
 * - ヒンジ: 開口の片側(u の向きの始まりか終わり)の内側の線の上に、上下の端から offset の所を中心にして 2 つ。ヒンジの形は外形を包む箱
 *   (幅 × 奥行 × 高さ、原点は外形の中心で下の面)で、高さを v、幅を u、奥行を n に向ける(資料の寸法が箱だけなので、置き方は簡略)。
 * - 第 3 段: 板の押さえ(外形を包む箱)を、扉の板の各辺(縁)に等間隔に並べる。数は max(2, ceil(辺の長さ ÷ 間隔))で、中心を辺の長さの
 *   (2i + 1) / (2 × 数) の所に置く(間隔は利用者が欄で決める。資料に決まりが無いので規格の値ではない)。箱の高さを辺の向き、奥行を n へ向け、
 *   中心を板の縁の線の上(板の厚さの中央の面)に置く。収まらない(数 × 高さ > 辺の長さ)時は断る。
 * - 第 3 段: 平たいつなぎ(外形を包む箱)を、扉の枠の 4 隅(中心線の角)の裏の面(n の負の側。枠の断面の奥行の半分)に 1 つずつ、
 *   高さを -n、幅を u、奥行を v の向きに置く(角の 2 本にまたがる)。
 * - 開閉のジョイント・取っ手は作らない(ジョイントの対象にずれが無く、ヒンジの軸の線を原点の軸に持つ扉の部品が無いため。取っ手は行が無い)。
 * - 枠付きパーティションではヒンジを省き、枠・板・指定した固定部材を同じ方法で計画する。固定した組への追加は置く側(ui)が行う。
 */
import { addVec3, crossVec3, scaleVec3, type Vec3 } from '../../sketch/vec3.js';
import { quaternionFromBasis, type RigidPlacement } from '../placementMath.js';
import type { FrameLine } from './frameMembers.js';
import type { PlacedFrameMember } from './frameJoints.js';
import { openingFrame, openingPoint, type FrameOpening, type FramePanelRejection } from './framePanelOpening.js';

interface FrameDoorInput {
  /** 開口の内側と扉の外形の間の隙間(各辺、mm)。 */
  readonly clearance: number;
  /** 扉の枠の断面の幅(面の中の向き)。 */
  readonly frameWidth: number;
  /** 扉の板の板厚。 */
  readonly boardThickness: number;
  /** ヒンジの箱(幅・奥行・高さ)と、付ける側(u の向きの始まり・終わり)と、上下の端からヒンジの中心までの距離。 */
  readonly hinge: { readonly width: number; readonly depth: number; readonly height: number; readonly side: 'start' | 'end'; readonly offset: number };
  /** 板の押さえの箱(幅・奥行・高さ)と並べる間隔(mm)。null か無い時は置かない。 */
  readonly holder?: { readonly width: number; readonly depth: number; readonly height: number; readonly pitch: number } | null;
  /** 平たいつなぎの箱の高さ(裏の面から外へ出る向き)と、扉の枠の断面の奥行(面の法線の向き)。null か無い時は置かない。 */
  readonly connector?: { readonly height: number; readonly frameDepth: number } | null;
}

type FramePartitionInput = Omit<FrameDoorInput, 'hinge'> & { readonly hinge: null };

/** 枠の開口の理由と、扉の枠の内側が無い・ヒンジが開口に収まらない。 */
type FrameDoorRejection = Exclude<FramePanelRejection, 'noRoom'> | 'noRoom' | 'hingeNoRoom' | 'holderNoRoom';

export type FrameDoorResult =
  | {
    readonly ok: true;
    /** 扉の枠の中心線(閉じた 4 本)と、断面の局所 +Y を向ける向き(面の法線)。 */
    readonly frameLines: readonly FrameLine[];
    readonly frameUp: Vec3;
    readonly board: { readonly width: number; readonly height: number; readonly placement: RigidPlacement };
    readonly hinges: readonly RigidPlacement[];
    /** 板の押さえの置き方(下・上・始まり・終わりの辺の順に、辺の向きへ)。置かない時は空。 */
    readonly holders: readonly RigidPlacement[];
    /** 平たいつなぎの置き方(扉の枠の 4 隅)。置かない時は空。 */
    readonly connectors: readonly RigidPlacement[];
    /** 扉の外形の幅・高さ(予告に出す)。 */
    readonly outer: { readonly width: number; readonly height: number };
  }
  | { readonly ok: false; readonly reason: FrameDoorRejection };

/** 長さと位置を丸める桁(mm の 1e-6。一括配置と同じ)。 */
const ROUNDING = 1e6;
const round = (value: number): number => Math.round(value * ROUNDING) / ROUNDING + 0;
const roundPoint = (point: Vec3): Vec3 => [round(point[0]), round(point[1]), round(point[2])];
const refused = (reason: FrameDoorRejection): FrameDoorResult => ({ ok: false, reason });
const positive = (...values: readonly number[]): boolean => values.every((value) => Number.isFinite(value) && value > 0);

/** 辺 1 本: 始まり(開口の u・v)・向き(u か v)・長さ。 */
interface BoardEdge { readonly along: number; readonly up: number; readonly direction: 'u' | 'v'; readonly length: number }

/** 板の押さえを辺に並べる。収まらない辺があれば null。 */
function holderPlacements(opening: FrameOpening, edges: readonly BoardEdge[], holder: NonNullable<FrameDoorInput['holder']>):
readonly RigidPlacement[] | null {
  const placements: RigidPlacement[] = [];
  for (const edge of edges) {
    const count = Math.max(2, Math.ceil(edge.length / holder.pitch - 1e-9));
    if (count * holder.height > edge.length + 1e-9) return null;
    const direction = edge.direction === 'u' ? opening.u : opening.v;
    // 局所 Z = 辺の向き・Y = n・X = n × 辺の向き(右手系)。
    const rotation = quaternionFromBasis(crossVec3(opening.n, direction), opening.n, direction, 1e-9);
    if (rotation === null) return null;
    for (let index = 0; index < count; index++) {
      const offset = edge.length * (2 * index + 1) / (2 * count);
      const center = edge.direction === 'u' ? openingPoint(opening, edge.along + offset, edge.up) : openingPoint(opening, edge.along, edge.up + offset);
      // 箱の原点は下の面(局所 -Z の側)の中心なので、中心から辺の向きへ高さの半分戻す。
      placements.push({ position: roundPoint(addVec3(center, scaleVec3(direction, -holder.height / 2))), rotation });
    }
  }
  return placements;
}

/** 選んだ 4 本の枠の開口に付ける扉の計画。作れない時は理由。 */
export function planFrameDoor(members: readonly PlacedFrameMember[], input: FrameDoorInput | FramePartitionInput): FrameDoorResult {
  if (members.length !== 4) return refused('notFour');
  const { hinge } = input;
  const { holder = null, connector = null } = input;
  if (!positive(input.frameWidth, input.boardThickness) || !(input.clearance >= 0)
    || (hinge !== null && (!positive(hinge.width, hinge.depth, hinge.height) || !(hinge.offset >= 0)))
    || (holder !== null && !positive(holder.width, holder.depth, holder.height, holder.pitch))
    || (connector !== null && !positive(connector.height, connector.frameDepth))) return refused('invalidNumber');
  const opening = openingFrame(members);
  if (typeof opening === 'string') return refused(opening);
  const [u0, u1] = opening.width, [v0, v1] = opening.height;
  const outerW = u1 - u0 - 2 * input.clearance, outerH = v1 - v0 - 2 * input.clearance;
  const innerW = round(outerW - 2 * input.frameWidth), innerH = round(outerH - 2 * input.frameWidth);
  if (!(innerW > 0 && innerH > 0)) return refused('noRoom');
  // ヒンジの中心は上下の端から offset。2 つが重ならず、開口からはみ出さない時だけ。
  if (hinge !== null && (hinge.offset < hinge.height / 2 || v1 - v0 - 2 * hinge.offset < hinge.height)) return refused('hingeNoRoom');
  const inset = input.clearance + input.frameWidth / 2;
  const corners = [[u0 + inset, v0 + inset], [u1 - inset, v0 + inset], [u1 - inset, v1 - inset], [u0 + inset, v1 - inset]] as const;
  const points = corners.map(([along, up]) => roundPoint(openingPoint(opening, along, up)));
  const frameLines = points.map((start, index): FrameLine => ({ start, end: points[(index + 1) % points.length] ?? start }));
  const boardRotation = quaternionFromBasis(opening.u, opening.v, opening.n, 1e-9);
  // ヒンジの箱: 高さを v、幅を u、奥行を n へ(局所 X = -u・Y = n・Z = v で右手系)。原点は外形の中心の下の面なので、中心から v × 高さ / 2 下げる。
  const hingeRotation = quaternionFromBasis(scaleVec3(opening.u, -1), opening.n, opening.v, 1e-9);
  if (boardRotation === null || hingeRotation === null) return refused('notRectangle');
  const centerU = (u0 + u1) / 2, centerV = (v0 + v1) / 2;
  const boardOrigin = openingPoint(opening, centerU, centerV, -input.boardThickness / 2);
  const hingeU = hinge?.side === 'start' ? u0 : u1;
  const hinges = hinge === null ? [] : [v0 + hinge.offset, v1 - hinge.offset].map((up): RigidPlacement => ({
    position: roundPoint(addVec3(openingPoint(opening, hingeU, up), scaleVec3(opening.v, -hinge.height / 2))), rotation: hingeRotation }));
  // 板の縁(扉の枠の内側): 下・上・始まり・終わりの辺。
  const edgeInset = input.clearance + input.frameWidth;
  const [left, bottom] = [u0 + edgeInset, v0 + edgeInset];
  const edges: readonly BoardEdge[] = [
    { along: left, up: bottom, direction: 'u', length: innerW }, { along: left, up: v1 - edgeInset, direction: 'u', length: innerW },
    { along: left, up: bottom, direction: 'v', length: innerH }, { along: u1 - edgeInset, up: bottom, direction: 'v', length: innerH }];
  const holders = holder === null ? [] : holderPlacements(opening, edges, holder);
  if (holders === null) return refused('holderNoRoom');
  // 平たいつなぎ: 局所 Z = -n(裏の面から外へ)・X = u・Y = -v(右手系)。原点(下の面の中心)を裏の面の角に置く。
  const connectorRotation = quaternionFromBasis(opening.u, scaleVec3(opening.v, -1), scaleVec3(opening.n, -1), 1e-9);
  if (connectorRotation === null) return refused('notRectangle');
  const connectors = connector === null ? [] : corners.map(([along, up]): RigidPlacement =>
    ({ position: roundPoint(openingPoint(opening, along, up, -connector.frameDepth / 2)), rotation: connectorRotation }));
  return { ok: true, frameLines, frameUp: opening.n,
    board: { width: innerW, height: innerH, placement: { position: roundPoint(boardOrigin), rotation: boardRotation } },
    hinges, holders, connectors, outer: { width: round(outerW), height: round(outerH) } };
}
