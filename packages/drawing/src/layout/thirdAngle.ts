import type { Point2, Vector3 } from '../types.js';

export type OrthographicViewName = 'front' | 'top' | 'right' | 'left' | 'rear' | 'bottom';

export interface ViewDirection {
  readonly normal: Vector3;
  readonly xDir: Vector3;
}

/** Z-up の第三角法。normal は物体を見る向き、xDir は用紙の +u(FR-702)。 */
export const THIRD_ANGLE_DIRECTIONS: Readonly<Record<OrthographicViewName, ViewDirection>> = {
  front: { normal: [0, 1, 0], xDir: [1, 0, 0] },
  top: { normal: [0, 0, -1], xDir: [1, 0, 0] },
  right: { normal: [-1, 0, 0], xDir: [0, 1, 0] },
  left: { normal: [1, 0, 0], xDir: [0, -1, 0] },
  rear: { normal: [0, -1, 0], xDir: [-1, 0, 0] },
  bottom: { normal: [0, 0, 1], xDir: [1, 0, 0] },
};

export interface SheetLayoutArea {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
  /** 希望する正面図の中心。省略時は配置全体を領域の中央に置く。 */
  readonly frontCenter?: Point2;
}

export interface ThirdAngleLayoutInput {
  readonly extents: readonly [number, number, number];
  readonly scale: number;
  readonly gap: number;
  readonly sheet: SheetLayoutArea;
}

export interface ThirdAngleLayout {
  readonly front: Point2;
  readonly top: Point2;
  readonly right: Point2;
}

function translationToFit(minimum: number, maximum: number, low: number, high: number): number {
  const size = maximum - minimum;
  const available = high - low;
  if (size > available) {
    return (low + high - minimum - maximum) / 2;
  }
  if (minimum < low) {
    return low - minimum;
  }
  if (maximum > high) {
    return high - maximum;
  }
  return 0;
}

/** 正面図を基準に平面図を上、右側面図を右へ並べる(FR-702)。 */
export function thirdAngleLayout(input: ThirdAngleLayoutInput): ThirdAngleLayout {
  const [width, depth, height] = input.extents;
  const scaledWidth = width * input.scale;
  const scaledDepth = depth * input.scale;
  const scaledHeight = height * input.scale;
  const topOffset: Point2 = [0, scaledHeight / 2 + input.gap + scaledDepth / 2];
  const rightOffset: Point2 = [scaledWidth / 2 + input.gap + scaledDepth / 2, 0];

  const groupMinX = -scaledWidth / 2;
  const groupMaxX = rightOffset[0] + scaledDepth / 2;
  const groupMinY = -scaledHeight / 2;
  const groupMaxY = topOffset[1] + scaledDepth / 2;
  const requestedFront: Point2 = input.sheet.frontCenter ?? [
    (input.sheet.left + input.sheet.right - groupMinX - groupMaxX) / 2,
    (input.sheet.bottom + input.sheet.top - groupMinY - groupMaxY) / 2,
  ];
  const shiftX = translationToFit(
    requestedFront[0] + groupMinX,
    requestedFront[0] + groupMaxX,
    input.sheet.left,
    input.sheet.right,
  );
  const shiftY = translationToFit(
    requestedFront[1] + groupMinY,
    requestedFront[1] + groupMaxY,
    input.sheet.bottom,
    input.sheet.top,
  );
  const origin: Point2 = [requestedFront[0] + shiftX, requestedFront[1] + shiftY];
  return {
    front: origin,
    top: [origin[0] + topOffset[0], origin[1] + topOffset[1]],
    right: [origin[0] + rightOffset[0], origin[1] + rightOffset[1]],
  };
}
