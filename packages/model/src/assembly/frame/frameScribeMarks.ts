/**
 * ケガキの位置(E-14): 部材ごとに、ほかの部材や溝のナットが取り付く位置(組立の基準線)を、部材の始点の端からの距離と面で求める。
 * 加工する人がその位置にケガキ線を引いてから組み立てられるよう、一覧と CSV に書き出す元になる。形を作らない純関数。
 *
 * - 途中に当たる相手の部材(部材が接続の 'side' の時。T・十字・交差): 相手の外形の箱を部材の軸へ写した範囲の両端 2 つ。面は接続の面。
 * - 溝に入れたナット: めねじの軸の上の点が部材の溝の中(溝の口の幅・深さの内)にある時、その点を軸へ写した位置。面は溝の面。
 * - 位置は 0.1 mm に丸める。端(0 と長さ)の位置は出さない(切断の長さで足りる)。同じ面の同じ位置は 1 つにまとめる。
 * 部材と接続は frameJoints.ts の `placedFrameMembers`・`classifyFrameJoints`、ナットは frameJointCheck.ts の `slotFastenerParts` から渡す。
 */
import { withinMagnitude } from '../../numericTolerance.js';
import { dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import type { FrameJoint, PlacedFrameMember } from './frameJoints.js';

type ScribeFace = NonNullable<FrameJoint['members'][number]['face']>;

/** ケガキの位置 1 つ: 面・始点の端からの距離(mm、0.1 mm に丸めた値)・何が取り付くか(相手の部材かナット)と、その部品。 */
interface FrameScribeMark {
  readonly face: ScribeFace | null;
  readonly positionMm: number;
  readonly kind: 'member' | 'nut';
  readonly otherComponentId: string;
}

/** 部材 1 本のケガキの位置(面の順〔上・左・下・右・面の無い物〕、同じ面では距離の順)。 */
export interface FrameScribeMember {
  readonly componentId: string;
  readonly lengthMm: number;
  readonly marks: readonly FrameScribeMark[];
}

/** 溝の中とみなす余り(mm)。置く処理は同じ点から作るので、丸めの桁より大きく、溝の寸法より十分小さい。 */
const SLOT_TOLERANCE_MM = 0.01;
/** 丸めの桁(1 mm を 10 に分ける = 0.1 mm)と、端とみなす距離(丸めの半分)。 */
const STEPS_PER_MM = 10;
const STEP_MM = 1 / STEPS_PER_MM;
const FACE_ORDER: readonly (ScribeFace | null)[] = ['top', 'left', 'bottom', 'right', null];

/** 0.1 mm に丸める(10 倍して丸めてから 10 で割る。0.1 を掛けると 490.00000000000006 のような端数が残る)。-0 は 0 にする。 */
const rounded = (value: number): number => Math.round(value * STEPS_PER_MM) / STEPS_PER_MM + 0;

interface Axis {
  readonly start: Vec3;
  readonly direction: Vec3;
  readonly length: number;
}

function axisOf(member: PlacedFrameMember): Axis {
  const span = subVec3(member.end, member.start), length = lengthVec3(span);
  return { start: member.start, direction: length > 0 ? scaleVec3(span, 1 / length) : [0, 0, 1], length };
}

const along = (axis: Axis, point: Vec3): number => dotVec3(subVec3(point, axis.start), axis.direction);

/** 相手の部材の外形の箱(8 つの角)を、部材の軸へ写した範囲。 */
function projectedRange(axis: Axis, other: PlacedFrameMember): readonly [number, number] {
  const values = [other.start, other.end].flatMap((end) => [other.bounds.minX, other.bounds.maxX].flatMap((x) =>
    [other.bounds.minY, other.bounds.maxY].map((y) => along(axis, [
      end[0] + other.xAxis[0] * x + other.yAxis[0] * y, end[1] + other.xAxis[1] * x + other.yAxis[1] * y,
      end[2] + other.xAxis[2] * x + other.yAxis[2] * y]))));
  return [Math.min(...values), Math.max(...values)];
}

/** ナットの点が、部材の溝の線のどれかの中にあれば、その溝の面(無ければ undefined)。 */
function slotFaceOf(member: PlacedFrameMember, point: Vec3): ScribeFace | undefined {
  return member.slotLines.find((line) => {
    const offset = subVec3(point, line.start), span = subVec3(line.end, line.start), length = lengthVec3(span);
    const t = length > 0 ? dotVec3(offset, span) / length : -1;
    const depth = dotVec3(offset, line.inward);
    return t >= -SLOT_TOLERANCE_MM && t <= length + SLOT_TOLERANCE_MM && withinMagnitude(dotVec3(offset, line.across), line.opening / 2 + SLOT_TOLERANCE_MM)
      && depth >= -SLOT_TOLERANCE_MM && depth <= line.slotDepth + SLOT_TOLERANCE_MM;
  })?.face;
}

/** 部材ごとのケガキの位置。位置の無い部材は入れない。並びは部材の並び。 */
export function frameScribeMarks(members: readonly PlacedFrameMember[], joints: readonly FrameJoint[],
  nuts: readonly { readonly componentId: string; readonly point: Vec3 }[]): readonly FrameScribeMember[] {
  const byId = new Map(members.map((member) => [member.componentId, member]));
  return members.flatMap((member): FrameScribeMember[] => {
    const axis = axisOf(member);
    const raw: FrameScribeMark[] = [];
    for (const joint of joints) {
      const own = joint.members.find((entry) => entry.componentId === member.componentId && entry.part === 'side');
      if (own === undefined) continue;
      for (const entry of joint.members) {
        const other = entry.componentId === member.componentId ? undefined : byId.get(entry.componentId);
        if (other === undefined) continue;
        for (const value of projectedRange(axis, other)) raw.push({ face: own.face, positionMm: value, kind: 'member', otherComponentId: other.componentId });
      }
    }
    for (const nut of nuts) {
      const face = slotFaceOf(member, nut.point);
      if (face !== undefined) raw.push({ face, positionMm: along(axis, nut.point), kind: 'nut', otherComponentId: nut.componentId });
    }
    const seen = new Set<string>();
    const marks = raw.map((mark) => ({ ...mark, positionMm: rounded(mark.positionMm) }))
      .filter((mark) => mark.positionMm >= STEP_MM / 2 && mark.positionMm <= axis.length - STEP_MM / 2)
      .filter((mark) => {
        const key = `${mark.face ?? ''}:${mark.positionMm.toFixed(1)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => FACE_ORDER.indexOf(left.face) - FACE_ORDER.indexOf(right.face) || left.positionMm - right.positionMm);
    return marks.length === 0 ? [] : [{ componentId: member.componentId, lengthMm: rounded(axis.length), marks }];
  });
}
