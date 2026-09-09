import type { Point2 } from '../types.js';
import {
  DIMENSION_EXTENSION_GAP_MM,
  DIMENSION_EXTENSION_OVER_MM,
} from '../style/jisStyle.js';
import { createArrowTriangle, shouldUseOutwardArrows, type ArrowTriangle } from './arrow.js';

export interface DimensionLineSegment {
  readonly from: Point2;
  readonly to: Point2;
}

export interface ArcGeometry {
  readonly center: Point2;
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

export interface LinearDimensionGeometry {
  readonly value: number;
  readonly dimensionLine: DimensionLineSegment;
  readonly extensionLines: readonly [DimensionLineSegment, DimensionLineSegment];
  readonly arrows: readonly [ArrowTriangle, ArrowTriangle];
  readonly textPosition: Point2;
  readonly outwardArrows: boolean;
}

function subtract(a: Point2, b: Point2): Point2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function dot(a: Point2, b: Point2): number {
  return a[0] * b[0] + a[1] * b[1];
}

function normalized(vector: Point2): Point2 | null {
  const length = Math.hypot(vector[0], vector[1]);
  return length === 0 ? null : [vector[0] / length, vector[1] / length];
}

function pointOn(center: Point2, radius: number, angle: number): Point2 {
  return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
}

export interface LinearDimensionInput {
  readonly first: Point2;
  readonly second: Point2;
  /** 水平/垂直寸法などの紙上の測定軸。省略時は両点を結ぶ向き。 */
  readonly direction?: Point2;
  /** 寸法線の共通法線座標 h。offset と同時には指定しない。 */
  readonly commonNormalCoordinate?: number;
  /** first から寸法線までの符号つき距離。h を省略した場合に使う。 */
  readonly offset?: number;
  readonly textWidth?: number;
  readonly textMargin?: number;
  readonly gap?: number;
  readonly over?: number;
}

/** 長さ寸法の線・補助線・矢印・文字位置を用紙座標で作る(§2.7)。 */
export function createLinearDimensionGeometry(
  input: LinearDimensionInput,
): LinearDimensionGeometry | null {
  const delta = subtract(input.second, input.first);
  const direction = normalized(input.direction ?? delta);
  if (direction === null || ![...input.first, ...input.second, ...direction].every(Number.isFinite)) {
    return null;
  }
  const signedSpan = dot(delta, direction);
  if (signedSpan === 0) return null;
  const normal: Point2 = [-direction[1], direction[0]];
  const firstNormal = dot(input.first, normal);
  const h = input.commonNormalCoordinate ?? firstNormal + (input.offset ?? 0);
  if (!Number.isFinite(h)) return null;
  const firstShift = h - firstNormal;
  const secondShift = h - dot(input.second, normal);
  const firstEnd: Point2 = [
    input.first[0] + normal[0] * firstShift,
    input.first[1] + normal[1] * firstShift,
  ];
  const secondEnd: Point2 = [
    input.second[0] + normal[0] * secondShift,
    input.second[1] + normal[1] * secondShift,
  ];
  const side = (firstShift + secondShift) / 2 < 0 ? -1 : 1;
  const gap = input.gap ?? DIMENSION_EXTENSION_GAP_MM;
  const over = input.over ?? DIMENSION_EXTENSION_OVER_MM;
  const extensionDirection: Point2 = [normal[0] * side, normal[1] * side];
  const firstExtension: Point2 = [normal[0] * (firstShift < 0 ? -1 : 1), normal[1] * (firstShift < 0 ? -1 : 1)];
  const secondExtension: Point2 = [normal[0] * (secondShift < 0 ? -1 : 1), normal[1] * (secondShift < 0 ? -1 : 1)];
  const extensionLines: readonly [DimensionLineSegment, DimensionLineSegment] = [
    {
      from: [
        input.first[0] + firstExtension[0] * gap,
        input.first[1] + firstExtension[1] * gap,
      ],
      to: [
        firstEnd[0] + firstExtension[0] * over,
        firstEnd[1] + firstExtension[1] * over,
      ],
    },
    {
      from: [
        input.second[0] + secondExtension[0] * gap,
        input.second[1] + secondExtension[1] * gap,
      ],
      to: [
        secondEnd[0] + secondExtension[0] * over,
        secondEnd[1] + secondExtension[1] * over,
      ],
    },
  ];
  const span = Math.hypot(secondEnd[0] - firstEnd[0], secondEnd[1] - firstEnd[1]);
  const outwardArrows = shouldUseOutwardArrows(
    span,
    input.textWidth ?? 0,
    input.textMargin ?? 0,
  );
  const along: Point2 = signedSpan < 0 ? [-direction[0], -direction[1]] : direction;
  const firstArrowDirection: Point2 = outwardArrows
    ? [-along[0], -along[1]]
    : along;
  const secondArrowDirection: Point2 = outwardArrows
    ? along
    : [-along[0], -along[1]];
  return {
    value: input.direction === undefined ? Math.hypot(delta[0], delta[1]) : Math.abs(signedSpan),
    dimensionLine: { from: firstEnd, to: secondEnd },
    extensionLines,
    arrows: [
      createArrowTriangle(firstEnd, firstArrowDirection),
      createArrowTriangle(secondEnd, secondArrowDirection),
    ],
    textPosition: [
      (firstEnd[0] + secondEnd[0]) / 2 + extensionDirection[0],
      (firstEnd[1] + secondEnd[1]) / 2 + extensionDirection[1],
    ],
    outwardArrows,
  };
}

export interface AngleDimensionGeometry {
  readonly valueDegrees: number;
  readonly dimensionArc: ArcGeometry;
  readonly extensionLines: readonly [DimensionLineSegment, DimensionLineSegment];
  readonly arrows: readonly [ArrowTriangle, ArrowTriangle];
  readonly textPosition: Point2;
}

function positiveAngle(angle: number): number {
  const turn = Math.PI * 2;
  return ((angle % turn) + turn) % turn;
}

/** 2方向の交点を中心とする角度寸法。平行なら null。 */
export function createAngleDimensionGeometry(
  center: Point2,
  firstDirection: Point2,
  secondDirection: Point2,
  radius: number,
): AngleDimensionGeometry | null {
  const first = normalized(firstDirection);
  const second = normalized(secondDirection);
  if (
    first === null || second === null ||
    Math.abs(first[0] * second[1] - first[1] * second[0]) < 1e-12
  ) {
    return null;
  }
  let startAngle = positiveAngle(Math.atan2(first[1], first[0]));
  let endAngle = positiveAngle(Math.atan2(second[1], second[0]));
  let sweep = positiveAngle(endAngle - startAngle);
  if (sweep > Math.PI) {
    [startAngle, endAngle] = [endAngle, startAngle];
    sweep = Math.PI * 2 - sweep;
  }
  if (endAngle < startAngle) {
    endAngle += Math.PI * 2;
  }
  const start = pointOn(center, radius, startAngle);
  const end = pointOn(center, radius, endAngle);
  const tangentAtStart: Point2 = [-Math.sin(startAngle), Math.cos(startAngle)];
  const tangentAtEnd: Point2 = [Math.sin(endAngle), -Math.cos(endAngle)];
  const middle = startAngle + sweep / 2;
  return {
    valueDegrees: sweep * 180 / Math.PI,
    dimensionArc: { center, radius, startAngle, endAngle },
    extensionLines: [
      {
        from: pointOn(center, DIMENSION_EXTENSION_GAP_MM, startAngle),
        to: pointOn(center, radius + DIMENSION_EXTENSION_OVER_MM, startAngle),
      },
      {
        from: pointOn(center, DIMENSION_EXTENSION_GAP_MM, endAngle),
        to: pointOn(center, radius + DIMENSION_EXTENSION_OVER_MM, endAngle),
      },
    ],
    arrows: [createArrowTriangle(start, tangentAtStart), createArrowTriangle(end, tangentAtEnd)],
    textPosition: pointOn(center, radius + 1, middle),
  };
}

export interface DiameterDimensionGeometry {
  readonly value: number;
  readonly dimensionLine: DimensionLineSegment;
  readonly arrows: readonly [ArrowTriangle, ArrowTriangle];
  readonly textPosition: Point2;
}

export function createDiameterDimensionGeometry(
  center: Point2,
  radius: number,
  direction: Point2 = [1, 0],
): DiameterDimensionGeometry | null {
  const axis = normalized(direction);
  if (axis === null || radius <= 0) {
    return null;
  }
  const first: Point2 = [center[0] - axis[0] * radius, center[1] - axis[1] * radius];
  const second: Point2 = [center[0] + axis[0] * radius, center[1] + axis[1] * radius];
  return {
    value: radius * 2,
    dimensionLine: { from: first, to: second },
    arrows: [createArrowTriangle(first, axis), createArrowTriangle(second, [-axis[0], -axis[1]])],
    textPosition: [center[0], center[1] + 1],
  };
}

export interface RadiusDimensionGeometry {
  readonly value: number;
  readonly dimensionLine: DimensionLineSegment;
  readonly arrows: readonly [ArrowTriangle];
  readonly textPosition: Point2;
}

export function createRadiusDimensionGeometry(
  center: Point2,
  radius: number,
  direction: Point2 = [1, 0],
): RadiusDimensionGeometry | null {
  const axis = normalized(direction);
  if (axis === null || radius <= 0) {
    return null;
  }
  const end: Point2 = [center[0] + axis[0] * radius, center[1] + axis[1] * radius];
  return {
    value: radius,
    dimensionLine: { from: center, to: end },
    arrows: [createArrowTriangle(end, axis)],
    textPosition: [
      center[0] + axis[0] * (radius / 2),
      center[1] + axis[1] * (radius / 2) + 1,
    ],
  };
}

export interface ArcLengthDimensionGeometry {
  readonly value: number;
  readonly dimensionArc: ArcGeometry;
  readonly arrows: readonly [ArrowTriangle, ArrowTriangle];
  readonly textPosition: Point2;
  readonly symbol: '⌒';
}

export function createArcLengthDimensionGeometry(
  center: Point2,
  radius: number,
  startAngle: number,
  endAngle: number,
): ArcLengthDimensionGeometry | null {
  if (radius <= 0) {
    return null;
  }
  const sweep = positiveAngle(endAngle - startAngle);
  if (sweep === 0) {
    return null;
  }
  const end = startAngle + sweep;
  const startPoint = pointOn(center, radius, startAngle);
  const endPoint = pointOn(center, radius, end);
  return {
    value: radius * sweep,
    dimensionArc: { center, radius, startAngle, endAngle: end },
    arrows: [
      createArrowTriangle(startPoint, [-Math.sin(startAngle), Math.cos(startAngle)]),
      createArrowTriangle(endPoint, [Math.sin(end), -Math.cos(end)]),
    ],
    textPosition: pointOn(center, radius + 1, startAngle + sweep / 2),
    symbol: '⌒',
  };
}
