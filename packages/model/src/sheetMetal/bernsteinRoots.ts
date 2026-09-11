/** 6次以下のBernstein多項式の実根。導関数の根で単調区間へ分け、偶数重根も調べる。 */
export function bernsteinValue(coefficients: readonly number[], at: number): number {
  const row = [...coefficients];
  for (let width = row.length - 1; width > 0; width--)
    for (let i = 0; i < width; i++) row[i] = row[i] * (1 - at) + row[i + 1] * at;
  return row[0];
}
export function bernsteinRoots(coefficients: readonly number[]): readonly number[] | null {
  if (coefficients.length === 0 || coefficients.length > 7 || !coefficients.every(Number.isFinite)) return null;
  const magnitude = Math.max(...coefficients.map(Math.abs));
  if (magnitude === 0) return null; // 全区間が重なる。有限個の交点へ勝手に置き換えない。
  if (coefficients.length === 1) return [];
  const values = coefficients.map((value) => value / magnitude), degree = values.length - 1;
  const derivative = values.slice(1).map((value, i) => degree * (value - values[i]));
  const critical = bernsteinRoots(derivative) ?? [];
  const cuts = [0, ...critical.filter((value) => value > 0 && value < 1), 1].sort((a, b) => a - b), roots: number[] = [];
  const evaluate = (at: number) => bernsteinValue(values, at);
  for (const cut of cuts) if (Math.abs(evaluate(cut)) <= 2e-14) roots.push(cut);
  for (let i = 1; i < cuts.length; i++) {
    let left = cuts[i - 1], right = cuts[i], a = evaluate(left);
    const b = evaluate(right);
    if (Math.abs(a) <= 2e-14 || Math.abs(b) <= 2e-14 || a * b >= 0) continue;
    for (let iteration = 0; iteration < 60; iteration++) {
      const middle = (left + right) / 2, value = evaluate(middle);
      if (value === 0 || middle === left || middle === right) { left = middle; right = middle; break; }
      if (Math.sign(value) === Math.sign(a)) { left = middle; a = value; } else right = middle;
    }
    roots.push((left + right) / 2);
  }
  return roots.sort((a, b) => a - b).filter((root, index, sorted) => index === 0 || root - sorted[index - 1] > 16 * Number.EPSILON);
}

function binomial(n: number, k: number): number {
  let value = 1;
  for (let i = 1; i <= k; i++) value = value * (n - i + 1) / i;
  return value;
}
/** Bernstein基底の積。円への距離二乗や有理曲線の分母を多項式のまま扱う。 */
export function multiplyBernstein(first: readonly number[], second: readonly number[]): readonly number[] {
  const m = first.length - 1, n = second.length - 1;
  return Array.from({ length: m + n + 1 }, (_, k) => {
    let sum = 0;
    for (let i = Math.max(0, k - n); i <= Math.min(m, k); i++)
      sum += first[i] * second[k - i] * binomial(m, i) * binomial(n, k - i) / binomial(m + n, k);
    return sum;
  });
}
