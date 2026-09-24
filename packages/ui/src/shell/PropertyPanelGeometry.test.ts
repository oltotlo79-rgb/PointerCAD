import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expressionValueFromNumber as number } from '@pointercad/expression';
import { appendSolid, DEFAULT_MATH_GEOMETRY_TOLERANCE, type SpringFeature } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { partWithPoint, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { PropertyPanel } from './PropertyPanel.js';

function install(derived: SpringFeature['derived'] = 'length', source = 'P * 2'): void {
  const spring: SpringFeature = {
    id: 'spring', name: 'Spring', kind: 'spring', suppressed: false,
    origin: { sketchId: 'sketch-1', pointFeatureId: 'point-1' }, axis: { kind: 'world', axis: 'z' },
    tiltAngle: number(0), tiltAzimuth: number(0), coilDiameter: number(20), wireDiameter: number(2),
    length: number(20), pitch: number(5), turns: number(4), handedness: 'right', derived,
    [derived]: { ...number(9876), source },
  };
  const base = appendSolid(partWithPoint(), spring);
  const formula = 'coef("Measured")';
  const document = { ...base, parameters: [{ name: 'P', unit: 'mm' as const, description: '', value: {
    ...number(10), source: formula, mathDefinition: { format: 'pointercad-math/1' as const, source: formula,
      inputNotation: 'text' as const, angleUnit: 'degree' as const,
      expression: { kind: 'symbol' as const, reference: { role: 'coefficient' as const, id: 'math-geometry:g', label: 'Measured' } },
    },
  } }], mathGeometry: [{ id: 'g', name: 'Measured', documentId: base.id,
    quantity: { kind: 'coordinate' as const, component: 'X' as const,
      point: { kind: 'sketch-point' as const, sketchId: 'sketch-1', reference: { kind: 'point' as const, pointId: 'point-1' } } },
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE }] };
  const store = useAppStore.getState();
  store.resetDocument(document);
  store.recordRecomputeRequest(1);
  store.applyRecompute(document, { ...resultFor(document), generation: 1, mathGeometry: [] });
  store.recordRecomputeCompletion(1, 'success');
  const analysis = useAppStore.getState().parameterAnalysis;
  useAppStore.setState({ selection: ['spring'], parameterAnalysis: { ...analysis,
    variables: new Map([['P', 25.4]]), exactVariables: new Map([['P', '25.4']]),
    geometryDerived: new Map([['P', ['g']]]) } });
}

function readOnlyMarkup(): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try {
    const markup = renderToStaticMarkup(createElement(PropertyPanel));
    const fields = markup.match(/<div class="pcad-field pcad-field--readonly"[\s\S]*?<\/div>/g);
    expect(fields).toHaveLength(1);
    return fields?.[0] ?? '';
  } finally { snapshot.mockRestore(); }
}

beforeEach(() => { resetTestStore(); useAppStore.setState({ drawing: null }); });
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('GR-20 A1: read-only derived property fields', () => {
  it.each(['length', 'pitch', 'turns'] as const)('%s reevaluates the source instead of displaying its saved number', derived => {
    install(derived);
    const before = useAppStore.getState().document;
    const markup = readOnlyMarkup();
    expect(markup).toContain('value="50.8"');
    expect(markup).toContain('= 50.8');
    expect(markup).not.toContain('9876');
    expect(useAppStore.getState().document).toBe(before);
  });

  it('converts the reevaluated length to inches in both places', () => {
    install();
    useAppStore.getState().setDisplaySettings({ ...useAppStore.getState().displaySettings, lengthUnit: 'inch' });
    const markup = readOnlyMarkup();
    expect(markup).toContain('value="2"');
    expect(markup).toContain('= 2 in');
    expect(markup).not.toContain('9876');
  });

  it.each(['generation', 'cancelled', 'timeline', 'missingSnapshot'] as const)('%s hides the old value and shows pending', status => {
    install();
    if (status === 'generation') useAppStore.setState({ requestedGeneration: 2 });
    if (status === 'cancelled') useAppStore.setState({ recomputeCancelled: true });
    if (status === 'timeline') useAppStore.setState({ timelineIndex: 0 });
    if (status === 'missingSnapshot') useAppStore.setState({ mathGeometryResult: null });
    const markup = readOnlyMarkup();
    expect(markup).toContain('value=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-invalid="false"');
    expect(markup).toContain(t('mathGeometry.status.pending'));
    expect(markup).not.toContain('50.8');
    expect(markup).not.toContain('9876');
  });

  it('leaves constant derived expressions readable during geometry computation', () => {
    install('length', '3 * 7');
    useAppStore.setState({ requestedGeneration: 2 });
    expect(readOnlyMarkup()).toContain('value="21"');
  });

  it('shows an evaluation error without falling back to the stored number', () => {
    install('length', '1 / 0');
    const markup = readOnlyMarkup();
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('value=""');
    expect(markup).not.toContain('9876');
    expect(markup).not.toContain(t('mathGeometry.status.pending'));
  });
});
