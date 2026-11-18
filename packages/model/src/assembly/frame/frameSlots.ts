/**
 * 置いた部材の溝の中心線(J-02 P6a。フレームの締結で、ブラケットの穴が溝の上にあるかを照らすための線)。
 *
 * 溝は断面の局所の座標(作図面 XY、押し出しは +Z で長さ L)で、族が `sectionSlots` で渡す(位置は行の欄だけから出した物)。
 * ここでは、その溝の口の中心を長さの向きに伸ばした線を、部品の配置で世界の座標にする。留めで切った端では、外の面の上の
 * 口の中心が切る面より外へ出ない所までに縮める(切った端の外へ溝の線を出さない)。
 */
import type { RigidPlacement } from '../placementMath.js';
import { applyPlacementToDirection, applyPlacementToPoint } from '../placementMath.js';
import { miterKeptRange, type ProfileMiterEnd } from '../standard/profileMiter.js';
import type { Vec3 } from '../../sketch/vec3.js';
import type { FrameSectionBounds } from './frameMembers.js';

/** 断面の溝 1 本(局所の座標。外の面の上の口の中心・内向きの法線・面に沿う向き、口の幅と肩の厚さは行の値)。 */
export interface FrameSectionSlot {
  readonly face: 'top' | 'left' | 'bottom' | 'right';
  readonly center: readonly [number, number];
  readonly inward: readonly [number, number];
  readonly across: readonly [number, number];
  readonly opening: number;
  readonly shoulder: number;
  /** 肩の裏の部屋の深さ d(行の値。ボルトの先が部屋の底に当たらない長さの上限に使う)。 */
  readonly slotDepth: number;
  /** 肩の裏の部屋の形が簡略形状か(溝用のナットを置く深さが簡略になる事を予告に出すため)。 */
  readonly roomSimplified: boolean;
  /**
   * 溝幅の呼び(溝用のナットの記録の `slot` と照らす。行の dims.slotWidth と同じ単位と意味)。数: 族が溝ごとに決めた呼び(締結は行の
   * 呼びより先に使う。呼びの違う溝が混ざる行のため)。null: 溝はあるが呼びが決まらない(標準の溝の組に当たらない。締結は行の呼びに
   * 戻らず、専用の理由で断る)。持たない: 行の呼びを使う(今までの族)。
   */
  readonly nominalWidth?: number | null;
}

/** 置いた部材の溝 1 本の中心線(世界の座標。口の中心を長さの向きに伸ばした線)。 */
export interface FrameSlotLine {
  readonly face: FrameSectionSlot['face'];
  readonly start: Vec3;
  readonly end: Vec3;
  readonly inward: Vec3;
  readonly across: Vec3;
  readonly opening: number;
  readonly shoulder: number;
  readonly slotDepth: number;
  readonly roomSimplified: boolean;
  /** 溝の呼び(断面の溝の `nominalWidth` を null も含めてそのまま写す。持たない溝は持たない)。 */
  readonly nominalWidth?: number | null;
}

/**
 * 部材(長さ `length`、留めの端 `cuts`、断面の外形 `bounds`)の溝の中心線を、配置 `placement` で世界の座標にする。
 * 留めで切った端は切る面までに縮め、材料の残らない溝は入れない。
 */
export function frameSlotLines(slots: readonly FrameSectionSlot[], placement: RigidPlacement, length: number,
  bounds: FrameSectionBounds | null, cuts: readonly ProfileMiterEnd[]): readonly FrameSlotLine[] {
  const whole: readonly [number, number] = [0, length];
  return slots.flatMap((slot): FrameSlotLine[] => {
    const range = cuts.length === 0 ? whole : bounds === null ? null : miterKeptRange(bounds, cuts, slot.center, length);
    if (range === null || !(length > 0)) return [];
    const [x, y] = slot.center;
    return [{
      face: slot.face, start: applyPlacementToPoint(placement, [x, y, range[0]]), end: applyPlacementToPoint(placement, [x, y, range[1]]),
      inward: applyPlacementToDirection(placement, [slot.inward[0], slot.inward[1], 0]),
      across: applyPlacementToDirection(placement, [slot.across[0], slot.across[1], 0]),
      opening: slot.opening, shoulder: slot.shoulder, slotDepth: slot.slotDepth, roomSimplified: slot.roomSimplified,
      ...(slot.nominalWidth === undefined ? {} : { nominalWidth: slot.nominalWidth }),
    }];
  });
}
