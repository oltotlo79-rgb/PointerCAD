import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { appearanceFromPreset, DEFAULT_MATH_GEOMETRY_TOLERANCE, DENSITY_MATERIALS } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { MassPropertiesSection, MeasureSection } from './MeasurementSections.js';
import { formatMoments, massPropertiesView, runMeasure } from './measureCommands.js';

beforeEach(() => { resetTestStore(); useAppStore.setState({ massDensityDraft: null, measurementRequest: null }); });
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); useAppStore.setState({ massDensityDraft: null, measurementRequest: null }); });

function render(element: React.ReactElement): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore')
    .mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(element); }
  finally { snapshot.mockRestore(); }
}

describe('P102: 測定の見出しと長い値を共通のプロパティ列へ渡す', () => {
  it('撮影と同じ20mmの鋼の箱で5つの見出しと慣性の全成分・単位を保持する', () => {
    const massProperties = {
      bodyFeatureId: 'box', volume: 8000, area: 2400,
      centreOfMass: [10, 10, 10] as const,
      principalMoments: [8000 * 800 / 12, 8000 * 800 / 12, 8000 * 800 / 12] as const,
    };
    useAppStore.setState({ massProperties });
    const before = useAppStore.getState();
    const markup = render(createElement(MassPropertiesSection, { spec: appearanceFromPreset('steel') }));
    const list = markup.slice(markup.indexOf('<dl'), markup.indexOf('</dl>') + 5);
    expect(list).toMatch(/^<dl class="pcad-properties">/);
    const headings = [...list.matchAll(/<dt class="pcad-properties__key">([^<]+)<\/dt>/g)]
      .map(match => match[1]);
    expect(headings).toEqual([
      t('propertyPanel.massVolume'), t('propertyPanel.massArea'), t('propertyPanel.massMass'),
      t('propertyPanel.massCentre'), t('propertyPanel.massInertia'),
    ]);
    expect(list).toContain('<dd class="pcad-properties__value">62.8 g</dd>');
    const inertia = formatMoments(massPropertiesView(massProperties, 7.85).moments);
    expect(inertia.length).toBeGreaterThan(40);
    expect(list).toContain(`<dd class="pcad-properties__value">${inertia}</dd>`);
    expect([...list.matchAll(/<dd class="pcad-properties__value">/g)]).toHaveLength(5);
    expect(useAppStore.getState()).toBe(before);
  });

  it('測定できない理由が長い場合も見出しと値を同じ共通クラスへ渡す', () => {
    const message = '測定する対象を選び直してください。'.repeat(10);
    const markup = render(createElement(MeasureSection, {
      readiness: { ready: false, message, kinds: [], kind: null, targets: [], reason: null },
    }));
    expect(markup).toContain('<dl class="pcad-properties">');
    expect(markup).toContain(`<dt class="pcad-properties__key">${t('propertyPanel.measureTargets')}</dt>`);
    expect(markup).toContain(`<dd class="pcad-properties__value">${message}</dd>`);
    expect(markup).toContain(t('propertyPanel.measureNotYet'));
    expect(markup).toContain(t('propertyPanel.measurePrecisionSource'));
    expect(markup).toContain(t('propertyPanel.measurePrecisionLimits'));
    expect(markup).toContain('0.01 mm');
    expect(markup).toContain('1e-7 mm');
    expect(markup).toContain('1e-6 mm');
  });
});

describe('R21 result-bound measurement provenance', () => {
  it('shows the triangle source from a mesh body through runMeasure without changing its volume', async () => {
    const volume = 16387.064;
    const outcome = await runMeasure({ document: useAppStore.getState().document,
      selection: ['mesh-1'], measurer: null,
      bodies: [{ featureId: 'mesh-1', bodyKind: 'mesh', volume,
        mesh: { edgePositions: new Float32Array() }, faces: [], edges: [], vertices: [] }] });
    if (!outcome.ok) throw new Error('mesh measurement refused');
    useAppStore.setState({ measurement: outcome.measurement });
    expect(section()).toContain(t('measureProvenance.triangles'));
    expect(section()).not.toContain(t('measureProvenance.brep'));
    useAppStore.setState({ selection: ['unrelated-solid'] });
    useAppStore.getState().setDisplaySettings({ ...useAppStore.getState().displaySettings, lengthUnit: 'inch' });
    expect(section()).toContain(t('measureProvenance.triangles'));
    expect(section()).toContain('1.000 in');
    expect(useAppStore.getState().measurement?.result.value).toBe(volume);
  });
  const readiness = { ready: false, message: 'Another selection', kinds: [], kind: null, targets: [], reason: null } as const;
  const section = (): string => render(createElement(MeasureSection, { readiness }));

  it.each([
    ['brep', 'measureProvenance.brep'],
    ['sketch', 'measureProvenance.sketch'],
    ['sketch-brep', 'measureProvenance.sketchBrep'],
    ['triangles', 'measureProvenance.triangles'],
    [undefined, 'measureProvenance.unknown'],
  ] as const)('retains %s provenance when selection and display units change', (provenance, key) => {
    useAppStore.setState({ measurement: {
      result: { kind: 'pointDistance', value: 25.4, unit: 'mm', segment: null,
        ...(provenance === undefined ? {} : { provenance }) },
      text: '25.400 mm', angle: null, anchor: null, targetNames: ['Captured A', 'Captured B'],
    } });
    expect(section()).toContain(t(key));
    useAppStore.setState({ selection: ['unrelated-body'] });
    useAppStore.getState().setDisplaySettings({ ...useAppStore.getState().displaySettings, lengthUnit: 'inch' });
    const markup = section();
    expect(markup).toContain(t(key));
    expect(markup).toContain('1.000 in');
    expect(markup).toContain('Captured A / Captured B');
    expect(markup).toContain(t('propertyPanel.measurePrecisionLimits'));
    expect(useAppStore.getState().measurement?.result.value).toBe(25.4);
    expect(useAppStore.getState().measurement?.result.provenance).toBe(provenance);
  });

  it('distinguishes kernel mass properties from legacy results without changing values', () => {
    const mass = { bodyFeatureId: 'box', volume: 1000, area: 600,
      centreOfMass: [0, 0, 0] as const, principalMoments: [1, 2, 3] as const };
    const renderMass = (): string => render(createElement(MassPropertiesSection, { spec: appearanceFromPreset('steel') }));
    useAppStore.setState({ massProperties: mass });
    expect(renderMass()).toContain(t('measureProvenance.unknown'));
    useAppStore.setState({ massProperties: { ...mass, provenance: 'brep' } });
    const markup = renderMass();
    expect(markup).toContain(t('measureProvenance.brep'));
    expect(markup).not.toContain(t('measureProvenance.unknown'));
    expect(markup).toContain('1000 mm');
    expect([...markup.matchAll(/<dd class="pcad-properties__value">/g)]).toHaveLength(5);
    expect(useAppStore.getState().massProperties?.volume).toBe(1000);
  });
});

describe('FIX-02 density and measurement display', () => {
  const mass = { bodyFeatureId: 'box', volume: 1000, area: 600,
    centreOfMass: [25.4, 0, 0] as const, principalMoments: [1, 2, 3] as const };
  const section = (): string => render(createElement(MassPropertiesSection, { spec: appearanceFromPreset('steel') }));
  function density(source: string): void {
    useAppStore.getState().setMassDensityDraft({ documentId: useAppStore.getState().document.id,
      bodyFeatureId: 'box', materialId: 'steel', source });
  }

  it.each(['unknown_name', '1/0', '', '0', '-1', '-1/2', 'Infinity', '1+'])('does not substitute the material density for %s', source => {
    useAppStore.setState({ massProperties: mass });
    density('1/2');
    expect(section()).toContain('>0.5 g</dd>');
    density(source);
    const invalid = section();
    expect(invalid).toContain('aria-invalid="true"');
    expect(invalid).toContain(t('propertyPanel.massDensityInvalid'));
    expect(invalid.match(new RegExp(`>${t('propertyPanel.massUncomputed')}</dd>`, 'g'))).toHaveLength(2);
    expect(invalid).not.toContain('>7.85 g</dd>');
    expect(invalid).toContain('>1000 mm³</dd>');
    expect(invalid).toContain('>25.4, 0, 0 mm</dd>');
    density('1/2');
    expect(section()).toContain('>0.5 g</dd>');
    expect(section()).not.toContain('aria-invalid="true"');
  });

  it.each(DENSITY_MATERIALS)('accepts the listed density for $id', material => {
    useAppStore.setState({ massProperties: mass });
    density(String(material.density));
    const markup = section();
    expect(markup).not.toContain('aria-invalid="true"');
    expect(markup).not.toContain(`>${t('propertyPanel.massUncomputed')}</dd>`);
  });

  it('does not combine the previous body measurements with another selected material', () => {
    useAppStore.setState({ massProperties: mass, selection: ['other-box'] });
    expect(section()).toContain(t('propertyPanel.massOtherTarget'));
    expect(section()).not.toContain('>7.85 g</dd>');
  });

  it('keeps density pending without displaying the previous or material mass', () => {
    const state = useAppStore.getState();
    const source = 'coef("Measured")';
    useAppStore.setState({ document: { ...state.document,
      parameters: [{ name: 'P', mathId: 'coefficient:1', unit: 'mm', description: '', value: {
        source, value: 10, display: '10', mathDefinition: { format: 'pointercad-math/1', source,
          inputNotation: 'text', angleUnit: 'degree',
          expression: { kind: 'symbol', reference: { role: 'coefficient', id: 'math-geometry:measurement', label: 'Measured' } } },
      } }],
      mathGeometry: [{ id: 'measurement', documentId: state.document.id, name: 'Measured',
        quantity: { kind: 'volume', body: { kind: 'body', featureId: 'box' } }, tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE }],
    }, massProperties: mass, requestedGeneration: 2, completedGeneration: 1,
      mathGeometryResult: null, parameterAnalysis: { ...state.parameterAnalysis,
        variables: new Map([['P', 10]]), exactVariables: new Map([['P', '10']]),
        geometryDerived: new Map([['P', ['measurement']]]) } });
    density('P');
    const markup = section();
    expect(markup).toContain(t('mathGeometry.status.pending'));
    expect(markup).not.toContain('aria-invalid="true"');
    expect(markup).not.toContain('>10 g</dd>');
    expect(markup).not.toContain('>7.85 g</dd>');
    expect(markup.match(new RegExp(`>${t('propertyPanel.massUncomputed')}</dd>`, 'g'))).toHaveLength(2);
  });

  it('uses current units and the captured target name for a retained result', () => {
    useAppStore.setState({ massProperties: mass, measurement: {
      result: { kind: 'pointDistance', value: 25.4, unit: 'mm', segment: [[0, 0, 0], [25.4, 0, 0]] },
      text: '25.400 mm', angle: null, anchor: null, targetNames: ['A', 'B'],
    } });
    const readiness = { ready: false, message: 'C', kinds: [], kind: null, targets: [], reason: null } as const;
    expect(render(createElement(MeasureSection, { readiness }))).toContain('25.4 mm');
    useAppStore.getState().setDisplaySettings({ ...useAppStore.getState().displaySettings, lengthUnit: 'inch' });
    const markup = render(createElement(MeasureSection, { readiness }));
    expect(markup).toContain('1.000 in');
    expect(markup).toContain('A / B');
    expect(markup).toContain('>C</dd>');
    expect(useAppStore.getState().measurement?.text).toBe('1.000 in');
    expect(section()).toContain('1.000, 0.000, 0.000 in');
    expect(section()).toContain('g/cm³');
    expect(section()).toContain('g·mm²');
  });
});
