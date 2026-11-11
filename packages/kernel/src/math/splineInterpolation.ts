/** Pure double-precision B-spline arithmetic; no model, OCCT, Worker or runtime imports. */
export type SplineVector3 = readonly [number, number, number];
export interface SplineNumericData {
  readonly poles: readonly SplineVector3[];
  readonly knots: readonly number[];
  readonly multiplicities: readonly number[];
  readonly degree: number;
  readonly periodic: boolean;
}
const MAX_DEGREE = 3;
export const SPLINE_MIN_SPAN_MM = 1e-9;
const MIN_PIVOT = 1e-14;
function distanceSplinePoint(a: SplineVector3, b: SplineVector3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function splineDegree(pointCount: number): number {
  return Math.min(pointCount - 1, MAX_DEGREE);
}

export function hasDuplicateSplinePoint(points: readonly SplineVector3[], closed: boolean): boolean {
  for (let index = 1; index < points.length; index += 1) {
    if (distanceSplinePoint(points[index], points[index - 1]) < SPLINE_MIN_SPAN_MM) {
      return true;
    }
  }
  if (closed && points.length > 0) {
    return distanceSplinePoint(points[0], points[points.length - 1]) < SPLINE_MIN_SPAN_MM;
  }
  return false;
}

export function basisValues(
  span: number,
  parameter: number,
  degree: number,
  knots: readonly number[],
): number[] {
  const values = new Array<number>(degree + 1).fill(0);
  const left = new Array<number>(degree + 1).fill(0);
  const right = new Array<number>(degree + 1).fill(0);
  values[0] = 1;
  for (let step = 1; step <= degree; step += 1) {
    left[step] = parameter - knots[span + 1 - step];
    right[step] = knots[span + step] - parameter;
    let saved = 0;
    for (let index = 0; index < step; index += 1) {
      const share = values[index] / (right[index + 1] + left[step - index]);
      values[index] = saved + right[index + 1] * share;
      saved = left[step - index] * share;
    }
    values[step] = saved;
  }
  return values;
}

export function findSpan(
  knots: readonly number[],
  degree: number,
  lastPole: number,
  parameter: number,
): number {
  if (parameter >= knots[lastPole + 1]) {
    return lastPole;
  }
  if (parameter <= knots[degree]) {
    return degree;
  }
  let low = degree;
  let high = lastPole + 1;
  let middle = Math.floor((low + high) / 2);
  while (parameter < knots[middle] || parameter >= knots[middle + 1]) {
    if (parameter < knots[middle]) {
      high = middle;
    } else {
      low = middle;
    }
    middle = Math.floor((low + high) / 2);
  }
  return middle;
}

function solveLinearSystem(
  matrix: readonly (readonly number[])[],
  rows: readonly SplineVector3[],
): SplineVector3[] | null {
  const size = matrix.length;
  const width = size + 3;
  const work: number[][] = matrix.map((row, index) => [...row, ...rows[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(work[pivot][column]) < MIN_PIVOT) {
      return null;
    }
    if (pivot !== column) {
      const swapped = work[pivot];
      work[pivot] = work[column];
      work[column] = swapped;
    }
    const head = work[column][column];
    for (let index = column; index < width; index += 1) {
      work[column][index] /= head;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) {
        continue;
      }
      const factor = work[row][column];
      if (factor === 0) {
        continue;
      }
      for (let index = column; index < width; index += 1) {
        work[row][index] -= factor * work[column][index];
      }
    }
  }

  return work.map((row): SplineVector3 => [row[size], row[size + 1], row[size + 2]]);
}

function compressKnots(fullKnots: readonly number[]): {
  knots: number[];
  multiplicities: number[];
} {
  const knots: number[] = [];
  const multiplicities: number[] = [];
  for (const value of fullKnots) {
    const last = knots.length - 1;
    if (last >= 0 && Math.abs(knots[last] - value) < 1e-12) {
      multiplicities[last] += 1;
    } else {
      knots.push(value);
      multiplicities.push(1);
    }
  }
  return { knots, multiplicities };
}

function chordLengths(points: readonly SplineVector3[]): number[] {
  const lengths = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distanceSplinePoint(points[index], points[index - 1]);
    lengths.push(total);
  }
  return lengths;
}

export function interpolateOpen(points: readonly SplineVector3[], degree: number): SplineNumericData | null {
  const count = points.length;
  const last = count - 1;
  const chords = chordLengths(points);
  const total = chords[last];
  const parameters = chords.map((value) => value / total);
  parameters[last] = 1;

  const fullKnots = new Array<number>(count + degree + 1).fill(0);
  for (let index = last + 1; index < fullKnots.length; index += 1) {
    fullKnots[index] = 1;
  }
  for (let start = 1; start <= last - degree; start += 1) {
    let sum = 0;
    for (let index = start; index <= start + degree - 1; index += 1) {
      sum += parameters[index];
    }
    fullKnots[start + degree] = sum / degree;
  }

  const matrix: number[][] = [];
  for (let row = 0; row < count; row += 1) {
    const coefficients = new Array<number>(count).fill(0);
    const span = findSpan(fullKnots, degree, last, parameters[row]);
    const values = basisValues(span, parameters[row], degree, fullKnots);
    for (let offset = 0; offset <= degree; offset += 1) {
      coefficients[span - degree + offset] = values[offset];
    }
    matrix.push(coefficients);
  }

  const poles = solveLinearSystem(matrix, points);
  if (poles === null) {
    return null;
  }
  const { knots, multiplicities } = compressKnots(fullKnots);
  return { poles, knots, multiplicities, degree, periodic: false };
}

export function interpolateClosed(points: readonly SplineVector3[], degree: number): SplineNumericData | null {
  const count = points.length;
  const chords = chordLengths(points);
  const period = chords[count - 1] + distanceSplinePoint(points[0], points[count - 1]);
  // 1 周ぶんの節点(先頭 0 から、1 周して period まで)。
  const knots = [...chords, period];

  const fullKnots = periodicFullKnots(knots, count, degree, period);

  const matrix: number[][] = [];
  for (let row = 0; row < count; row += 1) {
    const coefficients = new Array<number>(count).fill(0);
    const span = degree + row;
    const values = basisValues(span, knots[row], degree, fullKnots);
    for (let offset = 0; offset <= degree; offset += 1) {
      const pole = (((span - degree + offset) % count) + count) % count;
      coefficients[pole] += values[offset];
    }
    matrix.push(coefficients);
  }

  const poles = solveLinearSystem(matrix, points);
  if (poles === null) {
    return null;
  }
  return {
    poles,
    knots,
    multiplicities: knots.map(() => 1),
    degree,
    periodic: true,
  };
}

export function controlPointData(
  points: readonly SplineVector3[],
  degree: number,
  closed: boolean,
): SplineNumericData {
  const count = points.length;
  if (closed) {
    // 周期曲線は「節点の重なりがすべて 1、節点の数 = 極の数 + 1」。
    const knots: number[] = [];
    for (let index = 0; index <= count; index += 1) {
      knots.push(index);
    }
    return {
      poles: [...points],
      knots,
      multiplicities: knots.map(() => 1),
      degree,
      periodic: true,
    };
  }
  // 端を固定する曲線は「両端の重なりが 次数 + 1、内側は 1、重なりの合計 = 極の数 + 次数 + 1」。
  const interior = count - degree - 1;
  const knots: number[] = [];
  const multiplicities: number[] = [];
  for (let index = 0; index <= interior + 1; index += 1) {
    knots.push(index);
    multiplicities.push(index === 0 || index === interior + 1 ? degree + 1 : 1);
  }
  return { poles: [...points], knots, multiplicities, degree, periodic: false };
}

function periodicFullKnots(
  knots: readonly number[],
  count: number,
  degree: number,
  period: number,
): number[] {
  const fullKnots = new Array<number>(count + 1 + 2 * degree).fill(0);
  for (let index = 0; index <= count; index += 1) {
    fullKnots[index + degree] = knots[index];
  }
  for (let step = 1; step <= degree; step += 1) {
    fullKnots[degree - step] = knots[count - step] - period;
    fullKnots[count + degree + step] = knots[step] + period;
  }
  return fullKnots;
}

export function expandKnots(data: SplineNumericData): number[] {
  const count = data.poles.length;
  if (data.periodic) {
    const period = data.knots[data.knots.length - 1] - data.knots[0];
    return periodicFullKnots(data.knots, count, data.degree, period);
  }
  const fullKnots: number[] = [];
  for (let index = 0; index < data.knots.length; index += 1) {
    for (let repeat = 0; repeat < data.multiplicities[index]; repeat += 1) {
      fullKnots.push(data.knots[index]);
    }
  }
  return fullKnots;
}

/** Construct the already-validated explicit C1 cubic; each adapter owns its refusal semantics. */
export function explicitCubicData(points: readonly SplineVector3[], knots: readonly number[]): SplineNumericData {
  return { poles: [...points], knots: [...knots],
    multiplicities: knots.map((_, index) => (index === 0 || index === knots.length - 1 ? 4 : 2)),
    degree: 3, periodic: false };
}
