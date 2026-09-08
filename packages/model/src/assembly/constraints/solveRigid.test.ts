import { describe, expect, it } from 'vitest';

import {
  rigidRowTolerance, scaledRigidJacobian, solveRigid, type RigidResidualRow, type RigidSolveInput,
} from './solveRigid.js';

function row(value: number, gradient: readonly number[], unit: 'length' | 'angle' = 'length', scale = 1): RigidResidualRow {
  return { value: value * scale, gradient: new Map(gradient.map((v, j) => [j, v * scale])), unit, scale };
}
function problem(initial: readonly number[], evaluate: (x: readonly number[]) => readonly RigidResidualRow[]): RigidSolveInput<readonly number[]> {
  return { initial, variables: initial.map(() => 'length'),
    evaluate: (base, step) => ({ rows: evaluate(base.map((v, j) => v + step[j])) }),
    retract: (base, step) => base.map((v, j) => v + step[j]), options: { characteristicLength: 1 } };
}

describe('solveRigidの受理/棄却と停止理由', () => {
  const scaleSweep = [...Array.from({ length: 18 }, (_value, i) => 10 ** (i - 20)),
    Number.EPSILON * (1 - Number.EPSILON), Number.EPSILON, Number.EPSILON * (1 + Number.EPSILON)];
  for (const sensitivity of [1e-16, Number.EPSILON * (1 - Number.EPSILON), Number.EPSILON,
    Number.EPSILON * (1 + Number.EPSILON), 1e-15]) {
    it.each(['auto', 'normal', 'qr'] as const)(`%sはEPS境界の独立感度${sensitivity}でもy=1e8へ収束する`, (linearSolver) => {
      const input = problem([0, 0], ([x, y]) => [row(x - 1, [1, 0]),
        row(sensitivity * (y - 1e8), [0, sensitivity])]);
      const result = solveRigid({ ...input, options: { ...input.options, linearSolver } });
      expect(result.stop).toBe('converged');
      expect(Math.abs(result.base[0] - 1)).toBeLessThan(1e-9);
      expect(Math.abs(result.base[1] / 1e8 - 1)).toBeLessThan(1e-9);
      expect(result.maxResidual).toBeLessThan(1e-9);
      expect(result.iterations).toBeLessThanOrEqual(3);
      expect(input.initial).toEqual([0, 0]);
    });
  }
  for (const sensitivity of scaleSweep) {
    it.each(['auto', 'normal', 'qr'] as const)(`%sの尺度sweep独立列s=${sensitivity}は生尺度を保つ`, (linearSolver) => {
      const target = 1 / sensitivity;
      // 軸に沿う行と、強列/弱列を45度回した行で同じ独立な解を持つ。
      for (const rotated of [false, true]) {
        const input = problem([0, 0], ([x, y]) => rotated
          ? [row(x - 1 + sensitivity * (y - target), [1, sensitivity]),
            row(x - 1 - sensitivity * (y - target), [1, -sensitivity])]
          : [row(x - 1, [1, 0]), row(sensitivity * (y - target), [0, sensitivity])]);
        const result = solveRigid({ ...input, options: { ...input.options, linearSolver } });
        expect(result.stop).toBe('converged');
        expect(Math.abs(result.base[0] - 1)).toBeLessThan(1e-9);
        expect(Math.abs(result.base[1] / target - 1)).toBeLessThan(1e-9);
        expect(result.maxResidual).toBeLessThan(1e-9);
        expect(result.iterations).toBeLessThanOrEqual(3);
        expect(input.initial).toEqual([0, 0]);
      }
    });
    it.each(['auto', 'normal', 'qr'] as const)(`%sの尺度sweep従属列s=${sensitivity}は強列の線形包で保護する`, (linearSolver) => {
      const input = problem([0, 0, 0], ([x, y, z]) => [row(x + sensitivity * z - 1, [1, 0, sensitivity]),
        row(y + sensitivity * z - 1, [0, 1, sensitivity])]);
      const result = solveRigid({ ...input, options: { ...input.options, linearSolver } });
      // 最小ノルム解z=2s/(1+2s²)。自由方向がs→0で巨大化しないことを固定する。
      expect(Math.abs(result.base[2])).toBeLessThan(3 * sensitivity);
      expect(result.stop).toBe('converged');
      expect(result.maxResidual).toBeLessThan(1e-9);
      expect(Math.abs(result.base[0] + sensitivity * result.base[2] - 1)).toBeLessThan(1e-9);
      expect(Math.abs(result.base[1] + sensitivity * result.base[2] - 1)).toBeLessThan(1e-9);
      expect(result.iterations).toBeLessThanOrEqual(3);
      expect(input.initial).toEqual([0, 0, 0]);
    });
    it.each(['auto', 'normal', 'qr'] as const)(`%sの尺度sweep真の零列s=${sensitivity}は初期自由値を保つ`, (linearSolver) => {
      const input = problem([0, 0, 17], ([x, y]) => [row(x + sensitivity * y - 1, [1, sensitivity, 0])]);
      const result = solveRigid({ ...input, options: { ...input.options, linearSolver } });
      expect(result.stop).toBe('converged');
      expect(result.base[2]).toBe(17);
      expect(Math.abs(result.base[1])).toBeLessThan(2 * sensitivity);
      expect(result.maxResidual).toBeLessThan(1e-9);
      expect(result.iterations).toBeLessThanOrEqual(3);
      expect(input.initial).toEqual([0, 0, 17]);
    });
  }
  it.each(['normal', 'qr'] as const)('%sで疎な行の項数が減っても前の行の項を足さない', (linearSolver) => {
    const sparse = (value: number, entries: readonly (readonly [number, number])[]): RigidResidualRow =>
      ({ value, gradient: new Map(entries), unit: 'length', scale: 1 });
    const input = problem([0, 0, 0], ([x, y, z]) => [
      sparse(x + 2 * y + 3 * z - 14, [[2, 3], [0, 1], [1, 2]]),
      sparse(y - 2, [[1, 1]]), sparse(z - 3, [[2, 1]]), sparse(0, []),
    ]);
    const result = solveRigid({ ...input, options: { characteristicLength: 1, linearSolver } });
    expect(result.converged).toBe(true);
    for (let i = 0; i < 3; i += 1) expect(Math.abs(result.base[i] - (i + 1))).toBeLessThan(1e-9);
    expect(result.trace.every((entry) => entry.linearSolver === linearSolver)).toBe(true);
    expect(input.initial).toEqual([0, 0, 0]);
  });
  it('1変数の解析解x=7に収束する', () => {
    const result = solveRigid(problem([0], ([x]) => [row(x - 7, [1])]));
    expect(result.stop).toBe('converged');
    expect(result.base[0]).toBeCloseTo(7, 10);
    expect(result.maxResidual).toBeLessThan(1e-9);
    expect(result.iterations).toBeGreaterThanOrEqual(1);
    expect(result.iterations).toBeLessThanOrEqual(8);
  });
  it('2変数の解析解x=2,y=3に収束する', () => {
    const result = solveRigid(problem([0, 0], ([x, y]) => [row(x + y - 5, [1, 1]), row(2 * x - y - 1, [2, -1])]));
    expect(result.base[0]).toBeCloseTo(2, 10);
    expect(result.base[1]).toBeCloseTo(3, 10);
    expect(result.converged).toBe(true);
  });
  it('大きすぎる候補を棄却しても基準と入力を動かさない', () => {
    const initial = Object.freeze([0.1]);
    const calls: { base: readonly number[]; step: readonly number[] }[] = [];
    const accepted: number[][] = [];
    const result = solveRigid({ ...problem(initial, () => []),
      evaluate: (base, step) => {
        calls.push({ base, step: [...step] });
        const x = base[0] + step[0];
        return { rows: [row(x * x - 1, [2 * x])] };
      }, retract: (base, step) => {
        const next = [base[0] + step[0]];
        accepted.push(next);
        return Object.freeze(next);
      } });
    const firstAccepted = result.trace.findIndex((entry) => entry.accepted);
    expect(firstAccepted).toBeGreaterThan(0);
    expect(calls.slice(0, firstAccepted + 2).every((call) => call.base === initial)).toBe(true);
    expect(accepted).toHaveLength(result.trace.filter((entry) => entry.accepted).length);
    expect(initial).toEqual([0.1]);
    expect(result.base[0]).toBeCloseTo(1, 10);
  });
  it('棄却でλを3倍にし、受理の後は次反復へ1/3を持ち越す', () => {
    const result = solveRigid(problem([0.1], ([x]) => [row(x * x - 1, [2 * x])]));
    expect(result.trace.some((entry) => !entry.accepted)).toBe(true);
    for (let j = 1; j < result.trace.length; j += 1) {
      const previous = result.trace[j - 1];
      expect(result.trace[j].damping).toBe(previous.accepted
        ? Math.max(1e-9, previous.damping / 3) : previous.damping * 3);
    }
  });
  it('受理後の線形化は必ず増分ゼロで新しい基準を使う', () => {
    const zeroBases: number[] = [];
    const result = solveRigid({ ...problem([0], () => []), evaluate: (base, step) => {
      if (step[0] === 0) zeroBases.push(base[0]);
      return { rows: [row(base[0] + step[0] - 7, [1])] };
    } });
    expect(zeroBases).toHaveLength(result.iterations + 1);
    expect(zeroBases[0]).toBe(0);
    expect(zeroBases.at(-1)).toBe(result.base[0]);
  });
  it('反復上限はiterationLimitで矛盾と断定しない', () => {
    const input = problem([0], ([x]) => [row(x - 7, [1])]);
    const result = solveRigid({ ...input, options: { ...input.options, maxIterations: 1 } });
    expect(result.stop).toBe('iterationLimit');
    expect(result.limit).toBe('iterations');
    expect(result.iterations).toBe(1);
  });
  it('時間上限を候補の前にも確認する', () => {
    let time = 0;
    const input = problem([0], ([x]) => [row(x - 7, [1])]);
    const result = solveRigid({ ...input, options: { ...input.options, maxTimeMs: 1, now: () => time++ } });
    expect(result.stop).toBe('iterationLimit');
    expect(result.limit).toBe('time');
    expect(result.base).toEqual([0]);
  });
  it('gradient=0の停留点は証明済み矛盾としない', () => {
    const result = solveRigid(problem([0], ([x]) => [row(x * x - 1, [2 * x])]));
    expect(result.stop).toBe('stalled');
    expect(result.converged).toBe(false);
  });
  it('構造的に定数である矛盾はprovenConstantConflict', () => {
    const result = solveRigid(problem([], () => [{ ...row(2, []), constant: true }]));
    expect(result.stop).toBe('provenConstantConflict');
    expect(result.maxResidual).toBe(2);
  });
  it('非有限の定数値を数学的矛盾の証明にしない', () => {
    const result = solveRigid(problem([], () => [{ ...row(NaN, []), constant: true }]));
    expect(result.stop).toBe('stalled');
    expect(result.converged).toBe(false);
  });
  it('改善後に距離10と12が釣り合ったらsuspectedConflict', () => {
    const result = solveRigid(problem([0], ([x]) => [row(x - 10, [1]), row(x - 12, [1])]));
    expect(result.stop).toBe('suspectedConflict');
    expect(result.base[0]).toBeCloseTo(11, 8);
    expect(result.converged).toBe(false);
  });
  it('行ゼロでも分岐違反が残れば収束としない', () => {
    const result = solveRigid({ ...problem([0], () => []),
      evaluate: () => ({ rows: [row(0, [1])], branchViolations: ['mate-1'] }) });
    expect(result.stop).toBe('stalled');
  });
  it('欠けた行を収束としない', () => {
    const result = solveRigid({ ...problem([0], () => []), evaluate: () => ({ rows: [], valid: false }) });
    expect(result.converged).toBe(false);
  });
  it('trialで行が消えたときは基準を採用しない', () => {
    const result = solveRigid({ ...problem([0], () => []),
      evaluate: (_base, step) => ({ rows: step[0] === 0 ? [row(-1, [1])] : [] }) });
    expect(result.base).toEqual([0]);
    expect(result.trace.every((entry) => !entry.accepted)).toBe(true);
  });
});

describe('診断と共有する行許容差', () => {
  it('長さの許容へ行尺度を一度だけ掛ける', () => {
    expect(rigidRowTolerance(row(2, [1], 'length', 0.01))).toBeCloseTo(1e-11, 20);
  });
  it('方向行はradの正弦許容を使う', () => {
    expect(rigidRowTolerance(row(0, [1], 'angle'))).toBe(Math.sin(1e-9));
    expect(rigidRowTolerance(row(0, [1], 'angle'), { angleTolerance: 0.01 })).toBe(Math.sin(0.01));
  });
  it('余弦残差の特殊許容を上書きせず共有する', () => {
    const tolerance = 2 * Math.sin(1e-9 / 2) * Math.sin(Math.PI / 3 - 1e-9 / 2);
    expect(rigidRowTolerance({ ...row(0, [1], 'angle'), tolerance })).toBe(tolerance);
  });
  it.each([0.5, 1, 2])('正規化残差%gの充足境界がsolverと一致する', (ratio) => {
    const residual = row(ratio * 1e-9, [1], 'length', 0.01);
    const result = solveRigid({ initial: 0, variables: ['length'], evaluate: () => ({ rows: [residual] }),
      retract: (base) => base, options: { maxIterations: 0 } });
    expect(Math.abs(residual.value) / rigidRowTolerance(residual)).toBe(ratio);
    expect(result.converged).toBe(ratio < 1);
  });
});

describe('尺度とQR', () => {
  it.each(['auto', 'normal', 'qr'] as const)('%sはrank候補から落ちる小列でも独立な感度を保つ', (linearSolver) => {
    const sensitivity = 1e-15;
    const input = problem([0, 0], ([x, y]) => [row(x - 1, [1, 0]), row(sensitivity * y - 1, [0, sensitivity])]);
    const result = solveRigid({ ...input, options: { ...input.options, linearSolver } });
    expect(result.converged).toBe(true);
    expect(result.maxResidual).toBeLessThan(1e-9);
    expect(Math.abs(result.base[0] - 1)).toBeLessThan(1e-9);
    expect(Math.abs(result.base[1] / (1 / sensitivity) - 1)).toBeLessThan(1e-9);
    expect(result.iterations).toBeLessThanOrEqual(3);
    expect(input.initial).toEqual([0, 0]);
  });
  for (const epsilon of [1e-7, 1e-12]) {
    it.each(['auto', 'normal', 'qr'] as const)(`%sは複数強列の線形包にある弱列ε=${epsilon}を巨大なzへ増幅しない`, (linearSolver) => {
      const solve = (coupling: number) => {
        const input = problem([0, 0, 0], ([x, y, z]) => [
          row(x + coupling * z - 1, [1, 0, coupling]),
          row(y + coupling * z - 1, [0, 1, coupling]),
        ]);
        const result = solveRigid({ ...input, options: { ...input.options, linearSolver } });
        expect(input.initial).toEqual([0, 0, 0]);
        return result;
      };
      const baseline = solve(0), result = solve(epsilon);
      expect(Math.abs(result.base[2] - baseline.base[2])).toBeLessThan(3 * epsilon);
      for (const outcome of [baseline, result]) {
        expect(outcome.converged).toBe(true);
        expect(outcome.maxResidual).toBeLessThan(1e-9);
        expect(Math.abs(outcome.base[0] - 1)).toBeLessThan(1e-9);
        expect(Math.abs(outcome.base[1] - 1)).toBeLessThan(1e-9);
        expect(outcome.iterations).toBeLessThanOrEqual(3);
      }
    });
  }
  for (const sensitivity of [1e-5, 1e-6]) {
    it.each(['auto', 'normal', 'qr'] as const)(`%sは小さい独立列${sensitivity}の解析解を減衰で失わない`, (linearSolver) => {
      const input = problem([0, 0], ([x, y]) => [row(x - 1, [1, 0]), row(sensitivity * (y - 1), [0, sensitivity])]);
      const result = solveRigid({ ...input, options: { ...input.options, linearSolver } });
      expect(result.stop).toBe('converged');
      expect(result.maxResidual).toBeLessThan(1e-9);
      expect(Math.abs(result.base[0] - 1)).toBeLessThan(1e-9);
      expect(Math.abs(result.base[1] - 1)).toBeLessThan(1e-9);
      expect(result.iterations).toBeLessThanOrEqual(3);
      expect(input.initial).toEqual([0, 0]);
    });
  }
  it.each(['auto', 'normal', 'qr'] as const)('%sはf=x+εy−1の微小自由列を巨大なyへ増幅しない', (linearSolver) => {
    const results = [0, 1e-20].map((epsilon) => {
      const input = problem([0, 0], ([x, y]) => [row(x + epsilon * y - 1, [1, epsilon])]);
      return solveRigid({ ...input, options: { ...input.options, linearSolver } });
    });
    for (const result of results) {
      expect(result.converged).toBe(true);
      expect(Math.abs(result.base[0] - 1)).toBeLessThan(1e-9);
      expect(Math.abs(result.base[1])).toBeLessThan(1e-9);
      expect(result.iterations).toBeLessThanOrEqual(3);
    }
    expect(Math.abs(results[0].base[1] - results[1].base[1])).toBeLessThan(1e-9);
  });
  it('行尺度を二重に掛けずΔt/L₀で列を尺度化する', () => {
    const matrix = scaledRigidJacobian([row(2, [3, 4], 'length', 0.01)], ['length', 'angle'],
      { characteristicLength: 100, lengthTolerance: 1e-7, angleTolerance: 1e-9 });
    expect(matrix[0][0]).toBeCloseTo(3, 12);
    expect(matrix[0][1]).toBeCloseTo(0.04, 12);
  });
  it('長さと角度の許容を別々に判定する', () => {
    const result = solveRigid({ initial: [0, 0], variables: ['length', 'angle'],
      evaluate: (base, step) => ({ rows: [row(base[0] + step[0] + 1e-8, [1, 0]),
        row(base[1] + step[1] + 1e-8, [0, 1], 'angle')] }),
      retract: (base, step) => base.map((v, j) => v + step[j]),
      options: { lengthTolerance: 1e-7, angleTolerance: 1e-10 } });
    expect(result.iterations).toBeGreaterThan(0);
    expect(Math.abs(result.base[1] + 1e-8)).toBeLessThan(1e-10);
  });
  it.each([1e-6, 1, 1e6])('代表長さ%gでも解析解に収束する', (length) => {
    const input = problem([0], ([x]) => [row(x - 3 * length, [1], 'length', 1 / length)]);
    const result = solveRigid({ ...input, options: { characteristicLength: length } });
    expect(Math.abs(result.base[0] - 3 * length)).toBeLessThan(1e-9);
    expect(result.converged).toBe(true);
  });
  it('QRでも同じ2変数の解析解へ収束する', () => {
    const input = problem([0, 0], ([x, y]) => [row(x + y - 5, [1, 1]), row(2 * x - y - 1, [2, -1])]);
    const result = solveRigid({ ...input, options: { ...input.options, linearSolver: 'qr' } });
    expect(result.converged).toBe(true);
    expect(result.base[0]).toBeCloseTo(2, 10);
    expect(result.base[1]).toBeCloseTo(3, 10);
    expect(result.trace.every((entry) => entry.linearSolver === 'qr')).toBe(true);
  });
  it('ほぼ従属な列は自動でQRへ切り替える', () => {
    const input = problem([0, 0], ([x, y]) => [row(x + y - 2, [1, 1]), row(1e-5 * (x - y), [1e-5, -1e-5])]);
    const result = solveRigid(input);
    expect(result.trace[0].linearSolver).toBe('qr');
    expect(result.converged).toBe(true);
    expect(result.base[0]).toBeCloseTo(1, 8);
    expect(result.base[1]).toBeCloseTo(1, 8);
  });
  it('非有限trialは棄却する', () => {
    const result = solveRigid({ ...problem([0], () => []), evaluate: (_base, step) => ({
      rows: [row(step[0] === 0 ? -1 : NaN, [1])],
    }) });
    expect(result.base).toEqual([0]);
    expect(result.converged).toBe(false);
  });
});
