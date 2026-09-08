import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createAssemblyDocument, type Joint, type JointCoordinate } from '@pointercad/model';
import * as slider from './jointSlider.js';

function joint(kind: Joint['kind'] = 'slider'): Joint {
  return {
    id: 'joint-1', name: 'J', kind,
    a: { kind: 'origin', componentId: 'a', element: 'z' },
    b: { kind: 'origin', componentId: 'b', element: 'z' },
    minValue: null, maxValue: null, suppressed: false,
  };
}

describe('P7-22 joint slider', () => {
  it.each<[Joint['kind'], readonly JointCoordinate[]]>([
    ['revolute', ['angle']], ['slider', ['translation']],
    ['cylindrical', ['angle', 'translation']], ['ball', []],
  ])('lists the named coordinates of %s', (kind, expected) => {
    expect(slider.jointSliderCoordinates(joint(kind))).toEqual(expected);
  });

  it('evaluates saved limits from assembly parameters', () => {
    const base = createAssemblyDocument('a');
    const document = { ...base, parameters: [{ name: '幅', description: '',
      value: expressionValueFromNumber(12), unit: 'mm' as const }] };
    const target = { ...joint(), minValue: { source: '-幅', value: 0, display: '0' },
      maxValue: { source: '幅*2', value: 0, display: '0' } };
    expect(slider.jointSliderBounds(document, target, 'translation'))
      .toEqual({ ok: true, bounds: { min: -12, max: 24 } });
  });

  it('rejects an expression that no longer resolves', () => {
    const target = { ...joint(), maxValue: { source: 'missing', value: 9, display: '9' } };
    expect(slider.jointSliderBounds(createAssemblyDocument('a'), target, 'translation'))
      .toEqual({ ok: false, reason: 'invalidExpression' });
  });

  it('rejects reversed limits', () => {
    const target = { ...joint(), minValue: expressionValueFromNumber(5), maxValue: expressionValueFromNumber(4) };
    expect(slider.jointSliderBounds(createAssemblyDocument('a'), target, 'translation'))
      .toEqual({ ok: false, reason: 'invalidRange' });
  });

  it('rejects a coordinate the joint does not expose', () => {
    expect(slider.jointSliderBounds(createAssemblyDocument('a'), joint('revolute'), 'translation'))
      .toEqual({ ok: false, reason: 'unsupported' });
  });

  it.each([
    [-20, { min: -10, max: 10 }, -10, true],
    [20, { min: -10, max: 10 }, 10, true],
    [3, { min: -10, max: 10 }, 3, false],
    [200, { min: null, max: null }, 200, false],
  ] as const)('clamps %s only when a saved end exists', (value, bounds, expected, atLimit) => {
    expect(slider.jointSliderValue(value, bounds)).toEqual({ ok: true, value: expected,
      atLimit, outOfRange: value !== expected });
  });

  it('uses the exact bounded range and coordinate step', () => {
    expect(slider.jointSliderDomain('translation', 4, { min: -5, max: 15 }))
      .toEqual({ min: -5, max: 15, step: 0.1, disabled: false });
  });

  it('moves an unbounded angular window with the current value', () => {
    expect(slider.jointSliderDomain('angle', 720, { min: null, max: null }))
      .toEqual({ min: 540, max: 900, step: 1, disabled: false });
  });

  it('extends a one-sided range without inventing a saved limit', () => {
    expect(slider.jointSliderDomain('translation', 0, { min: 5, max: null }))
      .toEqual({ min: 5, max: 105, step: 0.1, disabled: false });
  });

  it('disables a range fixed to one value', () => {
    expect(slider.jointSliderDomain('angle', 10, { min: 10, max: 10 })?.disabled).toBe(true);
  });

  it('uses the middle of a two-sided range as the initial angle revolution', () => {
    expect(slider.jointSliderReference({ min: 300, max: 420 })).toBe(360);
    expect(slider.jointSliderReference({ min: null, max: 720 })).toBe(720);
    expect(slider.jointSliderReference({ min: null, max: null })).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite input %s', (value) => {
    expect(slider.jointSliderValue(value, { min: null, max: null }))
      .toEqual({ ok: false, reason: 'invalidValue' });
    expect(slider.jointSliderDomain('angle', value, { min: null, max: null })).toBeNull();
  });
});
