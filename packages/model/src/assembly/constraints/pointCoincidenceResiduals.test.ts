import { describe, expect, it } from 'vitest';
import { crossVec3, dotVec3, scaleVec3 } from '../../sketch/vec3.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import type { AssemblyComponent } from '../types.js';
import { collectMateVariables, MATE_VARIABLE_AXES } from './mateVariables.js';
import {
  CARTESIAN_AXES, pointCoincidenceResiduals, pointSpan, rotationDerivativeAxes, type TrialGeometry,
} from './rigidResidualGeometry.js';

describe('点一致の3座標をまとめる微分', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])(
    '固定a=%s/b=%sでも一般の方向微分と全列が一致する', (fixedA, fixedB) => {
      const components: AssemblyComponent[] = [fixedA, fixedB].map((fixed, index) => ({
        id: index === 0 ? 'a' : 'b', name: String(index), fixed, visible: true, suppressed: false,
        source: { kind: 'part', partRef: 'part' }, placement: DEFAULT_COMPONENT_PLACEMENT,
      }));
      const variables = collectMateVariables({ ...createAssemblyDocument('微分'), components });
      for (const omega of [[0, 0, 0], [0.1, -0.3, 0.2], [1e-14, 2e-14, -1e-14]] as const) {
        const axes = rotationDerivativeAxes(omega);
        const a: TrialGeometry = { componentId: 'a', center: [1e12, -1e12, 0], delta: [1e-8, -2e-8, 3e-8],
          arm: [3, -5, 7], rotationAxes: axes };
        const b: TrialGeometry = { componentId: 'b', center: [1e12, -1e12, 0], delta: [0, 0, 0],
          arm: [-2, 4, 6], rotationAxes: axes };
        const span = pointSpan(a, b);
        const expected = CARTESIAN_AXES.map((g) => {
          const gradient = new Map<number, number>();
          for (const [target, direction] of [[a, g], [b, scaleVec3(g, -1)]] as const) {
            MATE_VARIABLE_AXES.forEach((axis, index) => {
              const column = variables.columnOf(target.componentId, axis);
              const derivative = index < 3 ? direction[index]
                : dotVec3(direction, crossVec3(target.rotationAxes[index - 3], target.arm));
              if (column !== null && derivative !== 0) gradient.set(column, (gradient.get(column) ?? 0) + derivative);
            });
          }
          return { value: dotVec3(span, g) * 0.01, scale: 0.01,
            gradient: new Map([...gradient].map(([column, value]) => [column, value * 0.01] as const).filter(([, value]) => value !== 0)) };
        });
        for (const cached of [false, true]) {
          const withColumns = (target: TrialGeometry): TrialGeometry => cached
            ? { ...target, columns: MATE_VARIABLE_AXES.map((axis) => variables.columnOf(target.componentId, axis)) } : target;
          expect(pointCoincidenceResiduals(withColumns(a), withColumns(b), variables, 0.01)).toEqual(expected);
        }
      }
    },
  );
  it('回転軸は3座標で共有し、部品ごと3列だけを読む', () => {
    const variables = collectMateVariables(createAssemblyDocument('空'));
    let reads = 0;
    const axes = CARTESIAN_AXES.map((value) => value);
    const observed = new Proxy(axes, { get: (target, property, receiver): unknown => {
      if (typeof property === 'string' && /^[0-2]$/u.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    } });
    const target: TrialGeometry = { componentId: 'a', center: [0, 0, 0], delta: [0, 0, 0],
      arm: [3, 5, 7], rotationAxes: observed, columns: [0, 1, 2, 3, 4, 5] };
    const other: TrialGeometry = { ...target, componentId: 'b', columns: [6, 7, 8, 9, 10, 11] };
    expect(pointCoincidenceResiduals(target, other, variables, 1).map((row) => row.value)).toEqual([0, 0, 0]);
    expect(reads).toBe(6);
  });
});
