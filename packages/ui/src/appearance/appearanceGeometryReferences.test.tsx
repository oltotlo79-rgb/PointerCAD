import React, { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber as number, type ExpressionValue } from '@pointercad/expression';
import { appendSolid, appearanceFromPreset, appearanceOf, assignBodyAppearance,
  DEFAULT_MATH_GEOMETRY_TOLERANCE, type AppearanceSpec, type PartDocument } from '@pointercad/model';
import * as THREE from 'three';
import { t, type MessageKey } from '../i18n/t.js';
import { type DraftVersionState } from '../shell/fieldDraft.js';
import { bodyFor, extrudeFeature, partWithPoint, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { AppearanceSection } from './AppearanceSection.js';
import { appearanceExpressionRefusalFor, assignAppearanceToSelection, buildAppearanceInput,
  type AppearanceContext } from './appearanceCommands.js';
import type { AppearanceFieldDraft } from './appearancePropertyValues.js';
import { buildFaceGroups } from './buildFaceGroups.js';
import { createAppearanceMaterialStore } from './createAppearanceMaterial.js';

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useState: vi.fn(react.useState) };
});
const rendered = vi.hoisted(() => ({ inputs: [] as React.InputHTMLAttributes<HTMLInputElement>[] }));
vi.mock('react/jsx-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-runtime')>();
  const capture = (factory: typeof runtime.jsx): typeof runtime.jsx => (type, props, key) => {
    if (type === 'input') rendered.inputs.push(props as React.InputHTMLAttributes<HTMLInputElement>);
    return factory(type, props, key);
  };
  return { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, key, isStatic, source, self) => {
    if (type === 'input') rendered.inputs.push(props as React.InputHTMLAttributes<HTMLInputElement>);
    return runtime.jsxDEV(type, props, key, isStatic, source, self);
  };
  return { ...runtime, jsxDEV };
});

const REFUSAL = 'mathGeometry.appearance.refused';
const FIELDS = ['transmission', 'gloss', 'roughness', 'spacing', 'color'] as const;
type Field = typeof FIELDS[number];
const LABELS: Readonly<Record<Field, MessageKey>> = {
  transmission: 'propertyPanel.appearanceTransmission', gloss: 'propertyPanel.appearanceGloss',
  roughness: 'propertyPanel.appearanceRoughness', spacing: 'propertyPanel.appearanceSpacing', color: 'propertyPanel.appearanceColor',
};
const legacy = (source: string, value = 10): ExpressionValue => ({ ...number(value), source });
function formula(label: string, id: string, value = 10): ExpressionValue {
  const source = `coef("${label}")`;
  return { source, value, display: String(value), mathDefinition: {
    format: 'pointercad-math/1', source, inputNotation: 'text', angleUnit: 'degree',
    expression: { kind: 'symbol', reference: { role: 'coefficient', id, label } },
  } };
}
function documentWithDerived(): PartDocument {
  const document = appendSolid(partWithPoint(), extrudeFeature('solid'));
  return { ...document, parameters: [
    { name: 'P', mathId: 'coefficient:1', value: formula('Measured', 'math-geometry:measure'), unit: 'mm', description: '' },
    { name: 'Q', mathId: 'coefficient:2', value: legacy('P + 1'), unit: 'mm', description: '' },
    { name: 'R', mathId: 'coefficient:3', value: number(5), unit: 'mm', description: '' },
    { name: 'Prefix', mathId: 'coefficient:4', value: number(8), unit: 'mm', description: '' },
  ], mathGeometry: [{ id: 'measure', documentId: document.id, name: 'Measured',
    quantity: { kind: 'volume', body: { kind: 'body', featureId: 'solid' } }, tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE }] };
}
function contextOf(document = useAppStore.getState().document): AppearanceContext {
  return { document, bodies: [bodyFor('solid')], selection: ['solid'], selectionKind: 'body', matches: [] };
}
function install(document = documentWithDerived(), current = true): void {
  useAppStore.getState().resetDocument(document);
  const analysis = useAppStore.getState().parameterAnalysis;
  useAppStore.setState({ bodies: [bodyFor('solid')], selection: ['solid'], selectionKind: 'body',
    requestedGeneration: 2, completedGeneration: current ? 2 : 1, isComputing: !current, lastOutcome: 'success',
    mathGeometryResult: current ? { document, generation: 2, evaluated: true, outcomes: new Map() } : null,
    parameterAnalysis: { ...analysis, variables: new Map([['P', 10], ['Q', 11], ['R', 5], ['Prefix', 8]]),
      exactVariables: new Map([['P', '10'], ['Q', '11'], ['R', '5'], ['Prefix', '8']]) } });
}
function specWith(field: Field, value: ExpressionValue): AppearanceSpec {
  const spec = appearanceFromPreset('checkerPlate');
  if (field === 'spacing') return { ...spec, pattern: { kind: 'checkerPlate', spacing: value } };
  if (field === 'color') return { ...spec, color: value.source };
  return { ...spec, [field]: value };
}
function render(draft?: DraftVersionState<AppearanceFieldDraft>, setDraft = vi.fn()): string {
  rendered.inputs = [];
  if (draft !== undefined) vi.mocked(useState).mockReturnValueOnce([draft, setDraft]);
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(<AppearanceSection context={contextOf()} />); }
  finally { snapshot.mockRestore(); }
}
function input(field: Field): React.InputHTMLAttributes<HTMLInputElement> {
  const found = rendered.inputs.find(item => item.title === t(LABELS[field]));
  if (found === undefined) throw new Error(`Missing ${field}`);
  return found;
}
function change(field: Field, value: string): void {
  const handler = input(field).onChange;
  if (handler === undefined) throw new Error(`Missing change handler: ${field}`);
  handler({ target: { value } } as React.ChangeEvent<HTMLInputElement>);
}
beforeEach(() => { resetTestStore(); install(assignBodyAppearance(documentWithDerived(), 'solid', appearanceFromPreset('checkerPlate'))); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); resetTestStore(); });

describe('GR-20c A5 appearance command boundary', () => {
  it.each(FIELDS)('refuses direct geometry provenance in %s without changing the document', field => {
    const document = useAppStore.getState().document;
    const before = JSON.stringify(document);
    expect(assignAppearanceToSelection(contextOf(), specWith(field, legacy('P')))).toEqual({ ok: false, reasonKey: REFUSAL });
    expect(JSON.stringify(document)).toBe(before);
    expect(useAppStore.getState().document).toBe(document);
  });
  it.each(FIELDS)('refuses transitive provenance in %s after recomputation is current', field => {
    expect(assignAppearanceToSelection(contextOf(), specWith(field, legacy('Q / 2')))).toEqual({ ok: false, reasonKey: REFUSAL });
  });
  it.each(['expandedMetal', 'checkerPlate', 'woodGrain'] as const)('checks %s spacing', kind => {
    const pattern = kind === 'woodGrain' ? { kind, spacing: legacy('Q'), species: 'oak' as const } : { kind, spacing: legacy('Q') };
    expect(assignAppearanceToSelection(contextOf(), { ...appearanceFromPreset('custom'), pattern })).toEqual({ ok: false, reasonKey: REFUSAL });
  });
  it.each([
    ['P', 'coefficient:1'], ['Q', 'coefficient:2'], ['OldName', 'coefficient:2'], ['Measured', 'math-geometry:measure'],
  ])('checks stored coefficient identity %s / %s', (label, id) => {
    expect(assignAppearanceToSelection(contextOf(), specWith('gloss', formula(label, id)))).toEqual({ ok: false, reasonKey: REFUSAL });
  });
  it('still refuses after the measurement definition is deleted', () => {
    const document = { ...useAppStore.getState().document, mathGeometry: [] };
    expect(assignAppearanceToSelection(contextOf(document), specWith('roughness', legacy('Q')))).toEqual({ ok: false, reasonKey: REFUSAL });
  });
  it('keeps the document and undo history when the store command refuses', () => {
    const before = useAppStore.getState();
    const serialized = JSON.stringify(before.document);
    before.assignAppearance(specWith('gloss', legacy('Q')));
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document);
    expect(JSON.stringify(after.document)).toBe(serialized);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.appearanceErrorKey).toBe(REFUSAL);
  });
  it.each(['R * 2', 'Prefix', '10', '1in'])('preserves ordinary expression %s', source => {
    expect(appearanceExpressionRefusalFor(useAppStore.getState().document, { source })).toBeNull();
    expect(assignAppearanceToSelection(contextOf(), specWith('gloss', legacy(source))).ok).toBe(true);
  });
  it('preserves a structured coefficient unrelated to geometry', () => {
    expect(assignAppearanceToSelection(contextOf(), specWith('roughness', formula('R', 'coefficient:3'))).ok).toBe(true);
  });
});

describe('GR-20c A5 appearance fields', () => {
  it.each(FIELDS)('keeps %s draft input, shows the refusal, and never commits it', field => {
    const document = useAppStore.getState().document;
    const seenVersion = useAppStore.getState().documentVersion;
    const setDraft = vi.fn<(value: DraftVersionState<AppearanceFieldDraft>) => void>();
    render({ draft: null, seenVersion }, setDraft);
    const assign = vi.spyOn(useAppStore.getState(), 'assignAppearance');
    change(field, 'Q +');
    expect(setDraft).toHaveBeenCalledWith({ draft: { key: field, source: 'Q +' }, seenVersion });
    expect(assign).not.toHaveBeenCalled();
    const markup = render({ draft: { key: field, source: 'Q +' }, seenVersion });
    expect(markup).toContain(t(REFUSAL));
    expect(input(field).value).toBe('Q +');
    expect(input(field)['aria-invalid']).toBe(true);
    expect(markup).not.toContain(t('mathGeometry.status.pending'));
    change(field, 'Q * 2');
    expect(assign).not.toHaveBeenCalled();
    expect(useAppStore.getState().document).toBe(document);
  });
  it.each(FIELDS.filter(field => field !== 'color'))('shows refusal for an opened %s formula while keeping its saved value', field => {
    const document = assignBodyAppearance(documentWithDerived(), 'solid', specWith(field, formula('Q', 'coefficient:2', 17)));
    const serialized = JSON.stringify(document);
    for (const current of [false, true]) {
      install(document, current);
      const markup = render();
      expect(input(field).value).toBe('coef("Q")');
      expect(input(field)['aria-invalid']).toBe(true);
      expect(markup).toContain(t(REFUSAL));
      expect(markup).not.toContain('= 17');
      expect(markup).not.toContain(t('mathGeometry.status.pending'));
      expect(JSON.stringify(useAppStore.getState().document)).toBe(serialized);
    }
  });
  it.each(FIELDS.filter(field => field !== 'color'))('commits ordinary coefficients in %s while geometry is pending', field => {
    install(useAppStore.getState().document, false);
    render();
    change(field, 'R * 2');
    const spec = appearanceOf(useAppStore.getState().document).entries[0].appearance;
    const value = field === 'spacing' ? (spec.pattern.kind === 'none' ? null : spec.pattern.spacing) : spec[field];
    expect(value?.source).toBe('R * 2');
    expect(value?.value).toBe(10);
  });
  it('keeps inch conversion for ordinary pattern spacing', () => {
    const state = useAppStore.getState();
    useAppStore.setState({ displaySettings: { ...state.displaySettings, lengthUnit: 'inch' } });
    render();
    change('spacing', '2');
    const pattern = appearanceOf(useAppStore.getState().document).entries[0].appearance.pattern;
    expect(pattern.kind === 'none' ? null : pattern.spacing.value).toBe(50.8);
  });
  it('continues accepting hexadecimal colors', () => {
    render();
    change('color', '#ABCDEF');
    expect(appearanceOf(useAppStore.getState().document).entries[0].appearance.color).toBe('#abcdef');
  });
});

it('GR-20c A5 opened document renders saved material values and preserves all formulas', () => {
  const saved: AppearanceSpec = { ...appearanceFromPreset('custom', '#123456'),
    transmission: formula('P', 'coefficient:1', 25), gloss: legacy('Q', 40), roughness: legacy('Q / 2', 60),
    pattern: { kind: 'checkerPlate', spacing: formula('Q', 'coefficient:2', 20) } };
  const document = assignBodyAppearance(documentWithDerived(), 'solid', saved);
  const before = JSON.stringify(document);
  install(document);
  const input = buildAppearanceInput(appearanceOf(document), []);
  const body = input.byBody.get('solid');
  const plan = buildFaceGroups(bodyFor('solid').faces, body?.faceAppearances ?? new Map(), body?.bodyAppearance ?? null, input.defaultAppearance);
  expect(plan?.appearances[0]).toBe(saved);
  const texture = new THREE.Texture();
  const materials = createAppearanceMaterialStore({ create: () => ({ texture, alphaTexture: null }), disposeAll: () => texture.dispose() });
  try {
    const material = materials.materialFor(saved, null);
    expect(material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    if (!(material instanceof THREE.MeshPhysicalMaterial)) throw new Error('Expected physical material');
    expect(material.transmission).toBe(0.25);
    expect(material.metalness).toBe(0.4);
    expect(material.roughness).toBe(0.6);
    expect(material.map?.repeat.toArray()).toEqual([0.05, 0.05]);
    expect(material.color.getHexString()).toBe('123456');
    const analysis = useAppStore.getState().parameterAnalysis;
    useAppStore.setState({ parameterAnalysis: { ...analysis, variables: new Map([['P', 70], ['Q', 71]]) } });
    expect(materials.materialFor(saved, null)).toBe(material);
    expect(render()).toContain(t(REFUSAL));
    expect(JSON.stringify(useAppStore.getState().document)).toBe(before);
  } finally { materials.dispose(); }
});
