import React, { useState, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber as number, type ExpressionValue } from '@pointercad/expression';
import {
  absoluteCoordinate, appendSolid, appearanceFromPreset, assignBodyAppearance,
  createFunctionSurface, createPrimitiveFeature, createSheetBaseFeature, createSheetFlangeFeature,
  DEFAULT_MATH_GEOMETRY_TOLERANCE, FUNCTION_DEFINITION_FORMAT, replaceSketch,
  type Parameter, type PartDocument,
} from '@pointercad/model';
import { AppearanceSection } from '../appearance/AppearanceSection.js';
import { FunctionSectionProperties } from '../functionPlot/FunctionSectionProperties.js';
import { commitFunctionSection } from '../functionPlot/functionSectionDraft.js';
import { t } from '../i18n/t.js';
import { SheetBendSummary } from '../sheetMetal/SheetBendSummary.js';
import { SheetMetalPanel } from '../sheetMetal/SheetMetalPanel.js';
import { evaluateSheetDraft } from '../sheetMetal/sheetDraft.js';
import * as sheetCommands from '../sheetMetal/sheetCommands.js';
import { ConstraintList } from '../sketch/ConstraintList.js';
import { ConstraintValuePopover } from '../sketch/ConstraintValuePopover.js';
import * as constraintActions from '../sketch/constraintActions.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { NumericInputPopover } from '../sketch/NumericInputPopover.js';
import { commitNumericInput, createNumericInput, evaluateNumericInput, reduceNumericInput } from '../sketch/numericInput.js';
import { acceptNumericMath, evaluateNumericMath, prepareNumericMathCommit } from '../sketch/numericMathValues.js';
import { sphereGridSphereOf } from '../sketch/sketchCommands.js';
import { MassPropertiesSection } from '../solid/MeasurementSections.js';
import { bodyFor, extrudeFeature, partWithPoint, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { evaluateFieldSource, pendingFieldVariables } from './propertyFieldUnits.js';

// Local draft state is seeded; the real consumers, evaluation, store and event handlers run.
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useState: vi.fn(react.useState) };
});
const rendered = vi.hoisted(() => ({ tags: [] as { tag: string; props: Record<string, unknown> }[] }));
vi.mock('react/jsx-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-runtime')>();
  const capture = (factory: typeof runtime.jsx): typeof runtime.jsx => (type, props, key) => {
    if (typeof type === 'string' && props !== null && typeof props === 'object') {
      rendered.tags.push({ tag: type, props: props as Record<string, unknown> });
    }
    return factory(type, props, key);
  };
  return { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) };
});

vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, key, isStatic, source, self) => {
    if (typeof type === 'string' && props !== null && typeof props === 'object') {
      rendered.tags.push({ tag: type, props: props as Record<string, unknown> });
    }
    return runtime.jsxDEV(type, props, key, isStatic, source, self);
  };
  return { ...runtime, jsxDEV };
});

function formula(label: string, id: string): ExpressionValue {
  const source = `coef("${label}")`;
  return { source, value: 10, display: '10', mathDefinition: {
    format: 'pointercad-math/1', source, inputNotation: 'text', angleUnit: 'degree',
    expression: { kind: 'symbol', reference: { role: 'coefficient', id, label } },
  } };
}
const legacy = (source = 'P'): ExpressionValue => ({ ...number(10), source });
function documentWithDerived(): PartDocument {
  const document = appendSolid(partWithPoint(), extrudeFeature('solid'));
  const parameters: readonly Parameter[] = [
    { name: 'P', mathId: 'coefficient:1', value: formula('Measured', 'math-geometry:measure'), unit: 'mm', description: '' },
    { name: 'Q', mathId: 'coefficient:2', value: legacy('P + 1'), unit: 'mm', description: '' },
    { name: 'R', mathId: 'coefficient:3', value: number(5), unit: 'mm', description: '' },
  ];
  return { ...document, parameters, mathGeometry: [{ id: 'measure', documentId: document.id, name: 'Measured',
    quantity: { kind: 'volume', body: { kind: 'body', featureId: 'solid' } }, tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE }] };
}
function install(document = documentWithDerived()): void {
  useAppStore.getState().resetDocument(document);
  const analysis = useAppStore.getState().parameterAnalysis;
  useAppStore.setState({ requestedGeneration: 2, completedGeneration: 1, lastOutcome: 'success', mathGeometryResult: null,
    parameterAnalysis: { ...analysis, variables: new Map([['P', 10], ['Q', 11], ['R', 5]]),
      exactVariables: new Map([['P', '10'], ['Q', '11'], ['R', '5']]),
      geometryDerived: new Map([['P', ['measure']], ['Q', ['measure']]]) } });
}
function current(): void {
  const state = useAppStore.getState();
  useAppStore.setState({ completedGeneration: state.requestedGeneration, mathGeometryResult: {
    document: state.document, generation: state.requestedGeneration, evaluated: true, outcomes: new Map(),
  } });
}
function render(element: ReactElement): string {
  rendered.tags = [];
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(element); } finally { snapshot.mockRestore(); }
}
function tag(name: string, title?: string): Record<string, unknown> {
  const found = rendered.tags.find(item => item.tag === name && (title === undefined || item.props.title === title));
  if (!found) throw new Error(`Missing ${name}: ${title ?? ''}`);
  return found.props;
}
function change(props: Record<string, unknown>, value: string): void {
  const callback = props.onChange as React.ChangeEventHandler<HTMLInputElement> | undefined;
  if (!callback) throw new Error('Missing change handler');
  callback({ target: { value } } as React.ChangeEvent<HTMLInputElement>);
}
function units() {
  const state = useAppStore.getState();
  return { ...state.parameterAnalysis, nonLengthVariables: state.nonLengthVariables, lengthUnit: 'mm' as const,
    pendingVariables: pendingFieldVariables(state) };
}
beforeEach(() => { resetTestStore(); install(); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); resetTestStore(); });

describe('GR-20b B1 appearance fields', () => {
  it.each(['transmission', 'gloss', 'roughness'] as const)('%s never displays or saves a pending value', field => {
    const document = assignBodyAppearance(documentWithDerived(), 'solid', { ...appearanceFromPreset('steel'), [field]: legacy() });
    install(document);
    const title = t(field === 'transmission' ? 'propertyPanel.appearanceTransmission'
      : field === 'gloss' ? 'propertyPanel.appearanceGloss' : 'propertyPanel.appearanceRoughness');
    const markup = render(<AppearanceSection context={{ document, bodies: [bodyFor('solid')], selection: ['solid'], selectionKind: 'body', matches: [] }} />);
    expect(markup).toContain(t('mathGeometry.appearance.refused'));
    expect(markup).not.toContain('= 10<');
    expect(tag('input', title)['aria-invalid']).toBe(true);
    const apply = vi.spyOn(useAppStore.getState(), 'assignAppearance');
    change(tag('input', title), 'P * 2');
    expect(apply).not.toHaveBeenCalled();
    expect(useAppStore.getState().document).toBe(document);
  });
});

describe('GR-20b B2 density and mass', () => {
  function mass(source: string): string {
    vi.mocked(useState).mockReturnValueOnce(['steel', () => undefined]).mockReturnValueOnce([source, () => undefined]);
    useAppStore.setState({ massProperties: { bodyFeatureId: 'solid', volume: 1000, area: 600,
      centreOfMass: [0, 0, 0], principalMoments: [1, 2, 3] } });
    return render(<MassPropertiesSection spec={appearanceFromPreset('steel')} />);
  }
  it('pending density hides the previous value and mass, including fallback mass', () => {
    const markup = mass('P');
    expect(markup).toContain(t('mathGeometry.status.pending'));
    expect(markup).not.toContain('= 10');
    expect(markup).not.toContain(`<dt class="pcad-properties__key">${t('propertyPanel.massMass')}</dt>`);
    expect(markup).not.toContain('10 g');
    expect(markup).not.toContain('7.85 g');
    expect(markup).not.toContain('pcad-field--error');
  });
  it('unrelated formulas and the normal error fallback retain their density', () => {
    expect(mass('R')).toContain('= 5');
    expect(mass('R')).toContain('5 g');
    expect(mass('unknown')).toContain('7.85 g');
    expect(mass('unknown')).toContain('pcad-field--error');
  });
});

describe('GR-20b A2 function section coordinates', () => {
  it.each([legacy(), formula('P', 'coefficient:1')])('hides legacy and structured saved coordinates: $source', coordinate => {
    const document = documentWithDerived();
    const zero = formula('R', 'coefficient:3');
    if (!zero.mathDefinition) throw new Error('Missing definition');
    const parent = createFunctionSurface(document, { format: FUNCTION_DEFINITION_FORMAT,
      bounds: { X: { min: number(-100), max: number(100) }, Y: { min: number(-100), max: number(100) }, Z: { min: number(-100), max: number(100) } },
      tolerance: number(0.01), formula: { kind: 'coordinate-surface', output: 'Z', expression: zero.mathDefinition } });
    const section = commitFunctionSection(appendSolid(document, parent), parent.id, 'Z', coordinate);
    install(section.document);
    expect(render(<FunctionSectionProperties featureId={section.sectionId} />)).toContain(t('mathGeometry.status.pending'));
    expect(render(<FunctionSectionProperties featureId={section.sectionId} />)).not.toContain('10 mm');
    current();
    expect(render(<FunctionSectionProperties featureId={section.sectionId} />)).toContain('10 mm');
  });
});

describe('GR-20b A6 sphere grids', () => {
  it.each(['radius', 'x', 'y', 'z'] as const)('pending %s cannot supply a stale sphere to display or snapping', key => {
    const document = documentWithDerived();
    const center = { ...absoluteCoordinate(1, 2, 3), [key]: legacy() };
    const feature = { ...createPrimitiveFeature(document, 'sphere', { kind: 'coordinate', value: center }),
      shape: { kind: 'sphere' as const, radius: key === 'radius' ? legacy() : number(10) } };
    install(appendSolid(document, feature));
    expect(sphereGridSphereOf(feature, useAppStore.getState().resolvedSketch)).toBeNull();
    current();
    expect(sphereGridSphereOf(feature, useAppStore.getState().resolvedSketch)?.radius).toBe(10);
  });
});

describe('GR-20b B3 constraints', () => {
  it('constraint popover hides stale values and blocks the button and Enter', () => {
    useAppStore.setState({ constraintPrompt: { kind: 'distance', targets: [], defaultSource: 'P', anchor: [0, 0] } });
    const commit = vi.spyOn(constraintActions, 'commitConstraintPrompt');
    const markup = render(<ConstraintValuePopover />);
    expect(markup).toContain(t('mathGeometry.status.pending'));
    expect(markup).not.toContain('= 10');
    const button = tag('button', t('controlGuide.button.constraintApply'));
    const click = button.onClick as React.MouseEventHandler<HTMLButtonElement>;
    click({} as React.MouseEvent<HTMLButtonElement>);
    const dialog = rendered.tags.find(item => item.props.role === 'dialog');
    const key = dialog?.props.onKeyDown as React.KeyboardEventHandler<HTMLDivElement>;
    key({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {}, stopPropagation() {} } as React.KeyboardEvent<HTMLDivElement>);
    expect(commit).not.toHaveBeenCalled();
  });
  it('constraint list presents pending neutrally and refuses a stale update', () => {
    useAppStore.setState({ constraintSummaries: [{ id: 'constraint', kind: 'distance', label: 'distance', detail: '', symbol: '',
      value: legacy(), valueText: '10 mm', anchors: [], state: 'ok', stateMessage: null }] });
    const commit = vi.spyOn(constraintActions, 'changeConstraintValue');
    const markup = render(<ConstraintList />);
    expect(markup).toContain(t('mathGeometry.status.pending'));
    expect(markup).not.toContain('10 mm');
    expect(tag('input')['aria-invalid']).toBe(false);
    change(tag('input'), 'Q');
    expect(commit).not.toHaveBeenCalled();
  });
});

it('ordinary constraint errors keep the existing commit error path', () => {
  useAppStore.setState({ constraintPrompt: { kind: 'distance', targets: [], defaultSource: 'unknown', anchor: [0, 0] } });
  const commit = vi.spyOn(constraintActions, 'commitConstraintPrompt');
  const markup = render(<ConstraintValuePopover />);
  expect(markup).toContain('aria-invalid="true"');
  const click = tag('button', t('controlGuide.button.constraintApply')).onClick as React.MouseEventHandler<HTMLButtonElement>;
  click({} as React.MouseEvent<HTMLButtonElement>);
  expect(commit).toHaveBeenCalledOnce();
  expect(useAppStore.getState().constraintErrorMessage).toBe(t('constraint.error.invalidValue'));
});

describe('GR-20b B4 numeric input and neutral status', () => {
  const numeric = () => reduceNumericInput(createNumericInput('circle', 'circleRadius'), { type: 'edit', index: 0, source: 'P' });
  it('evaluation and commit reject stale values still present in the current table', () => {
    const state = numeric(), analysis = useAppStore.getState().parameterAnalysis;
    const result = evaluateNumericInput(state, analysis.variables, analysis);
    expect(result).toMatchObject({ canCommit: false, results: [{ value: null, error: { pending: true } }] });
    expect(commitNumericInput(state, analysis).kind).toBe('blocked');
    current();
    expect(commitNumericInput(state, analysis).kind).toBe('committed');
  });
  it('a carried pending stage cannot finish with stale or default values', () => {
    current();
    const analysis = useAppStore.getState().parameterAnalysis;
    const first = reduceNumericInput(createNumericInput('spring', 'springShape'), { type: 'edit', index: 0, source: 'P' });
    const next = commitNumericInput(first, analysis);
    if (next.kind !== 'open') throw new Error('Expected second stage');
    useAppStore.setState({ requestedGeneration: 3 });
    expect(commitNumericInput(next.state, analysis)).toMatchObject({ kind: 'blocked', evaluation: { carriedError: { pending: true } } });
  });
  it('NumericInputPopover supplies pending state for display and confirmation', () => {
    useAppStore.setState({ numericInput: numeric(), numericInputAnchor: [0, 0] });
    const markup = render(<NumericInputPopover viewportWidth={800} viewportHeight={600} />);
    expect(markup).toContain(t('mathGeometry.status.pending'));
    expect(markup).not.toContain('= 10');
    expect(markup).not.toContain('pcad-field--error');
  });
  it('an accepted formula cannot evaluate or commit across a shape generation change', () => {
    current();
    const document = useAppStore.getState().document;
    const accepted = acceptNumericMath(formula('P', 'coefficient:1'), document, [{ id: 'coefficient:1', label: 'P', decimal: '10' }]);
    useAppStore.setState({ requestedGeneration: 3 });
    const analysis = useAppStore.getState().parameterAnalysis;
    expect(evaluateNumericMath(accepted, analysis.variables, analysis.exactVariables)).toMatchObject({ ok: false, error: { pending: true } });
    expect(prepareNumericMathCommit(document, { accepted })).toEqual({ ok: false, message: t('mathGeometry.status.pending') });
    const state = numeric();
    expect(evaluateNumericInput({ ...state, fields: [{ ...state.fields[0], source: accepted.source, mathValue: accepted }] },
      analysis.variables, analysis).canCommit).toBe(false);
  });
  it('a pending coefficient formula cannot be accepted', () => {
    expect(() => acceptNumericMath(formula('P', 'coefficient:1'), useAppStore.getState().document,
      [{ id: 'coefficient:1', label: 'P', decimal: '10' }])).toThrow(t('mathGeometry.status.pending'));
  });
  it('pending ExpressionField is neutral while a syntax error remains red and invalid', () => {
    const field = numeric().fields[0];
    const result = evaluateFieldSource('P', 'mm', false, units());
    if (result.ok) throw new Error('Expected pending');
    const props = { field, focused: false, onChange: () => undefined, onFocus: () => undefined };
    const markup = render(<ExpressionField {...props} result={{ key: field.key, value: null, error: result.error }} />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-invalid="false"');
    expect(markup).not.toContain('pcad-field__message--error');
    const invalid = evaluateFieldSource('P *', 'mm', false, units());
    if (invalid.ok) throw new Error('Expected syntax error');
    const error = render(<ExpressionField {...props} field={{ ...field, source: 'P *' }} result={{ key: field.key, value: null, error: invalid.error }} />);
    expect(error).toContain('aria-invalid="true"');
    expect(error).toContain('pcad-field__message--error');
  });
  it('ExpressionField hides a stale evaluated result supplied by a caller', () => {
    const field = numeric().fields[0];
    const markup = render(<ExpressionField field={field} result={{ key: field.key, value: legacy(), error: null }}
      focused={false} onChange={() => undefined} onFocus={() => undefined} />);
    expect(markup).toContain(t('mathGeometry.status.pending'));
    expect(markup).not.toContain('= 10');
  });
});

describe('GR-20b B5 sheet metal', () => {
  it.each([true, false])('both drafted input and unedited stored values wait: drafted=%s', drafted => {
    const document = useAppStore.getState().document;
    const feature = createSheetBaseFeature(document, { sketchId: document.activeSketchId, faceFeatureId: 'face' });
    const candidate = { ...feature, rule: { ...feature.rule, thickness: legacy() } };
    expect(evaluateSheetDraft(candidate, drafted ? { sheetThickness: 'P' } : {}, 'mm', units())).toMatchObject({
      ok: false, pending: true, field: 'sheetThickness', message: t('mathGeometry.status.pending'),
    });
  });
  it.each(['angle', 'length', 'rule'] as const)('pending %s hides bend allowance and straight length', key => {
    const document = useAppStore.getState().document;
    const base = createSheetBaseFeature(document, { sketchId: document.activeSketchId, faceFeatureId: 'face' });
    const flange = createSheetFlangeFeature(document, base.id, []);
    const feature = { ...flange, ...(key === 'angle' ? { angle: legacy() } : key === 'length' ? { length: legacy() } : {}) };
    const rule = key === 'rule' ? { ...base.rule, thickness: legacy() } : base.rule;
    const markup = render(<SheetBendSummary feature={feature} rule={rule} sources={{}} lengthUnit="mm" />);
    expect(markup).toContain(t('mathGeometry.status.pending'));
    expect(markup).not.toContain(t('sheetMetal.bendAllowance'));
    current();
    expect(render(<SheetBendSummary feature={feature} rule={rule} sources={{}} lengthUnit="mm" />)).toContain(t('sheetMetal.bendAllowance'));
  });
  it('SheetMetalPanel cannot preview or save pending thickness after cancellation', () => {
    const document = documentWithDerived(), sketch = document.sketches[0];
    const part = replaceSketch(document, { ...sketch, features: [
      { kind: 'rectangle', id: 'rect', name: 'rect', planeId: 'xy', construction: false,
        corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(50, 30, 0) },
      { kind: 'face', id: 'face', name: 'face', planeId: 'xy', boundary: [{ featureId: 'rect' }], color: '#ffffff' },
    ] });
    install(part);
    const state = useAppStore.getState();
    const session = { id: 'sheet', kind: 'sheetBase' as const, document: part, documentId: state.activeDocumentId,
      defaultSources: { sheetThickness: 'P' } };
    const build = vi.spyOn(sheetCommands, 'buildSheetCreation');
    const compute = vi.fn();
    state.setSheetMetalComputer(compute);
    useAppStore.setState({ sheetMetalTool: session, isComputing: false, recomputeCancelled: true });
    render(<SheetMetalPanel session={session} />);
    const submit = tag('form').onSubmit as React.FormEventHandler<HTMLFormElement>;
    submit({ preventDefault() {} } as React.FormEvent<HTMLFormElement>);
    expect(build).toHaveBeenCalledOnce();
    expect(build).toHaveReturnedWith(expect.objectContaining({ ok: false, message: t('mathGeometry.status.pending') }));
    expect(compute).not.toHaveBeenCalled();
    expect(useAppStore.getState().document).toBe(part);
    expect(useAppStore.getState().sheetMetalPreview).toBeNull();
  });
});

describe('GR-20b documents without geometry-derived parameters', () => {
  function plain(): PartDocument {
    const original = documentWithDerived();
    return { ...original, mathGeometry: [], parameters: original.parameters.map(parameter => ({ ...parameter,
      value: number(parameter.name === 'P' ? 10 : parameter.name === 'Q' ? 11 : 5) })) };
  }
  it('keeps appearance display, numeric commit and sheet draft values while shape recomputation is pending', () => {
    const document = assignBodyAppearance(plain(), 'solid', { ...appearanceFromPreset('steel'), gloss: legacy() });
    install(document);
    const markup = render(<AppearanceSection context={{ document, bodies: [bodyFor('solid')], selection: ['solid'], selectionKind: 'body', matches: [] }} />);
    expect(markup).toContain('= 10');
    expect(markup).not.toContain(t('mathGeometry.status.pending'));
    const state = reduceNumericInput(createNumericInput('circle', 'circleRadius'), { type: 'edit', index: 0, source: 'P' });
    expect(commitNumericInput(state, useAppStore.getState().parameterAnalysis).kind).toBe('committed');
    const base = createSheetBaseFeature(document, { sketchId: document.activeSketchId, faceFeatureId: 'face' });
    expect(evaluateSheetDraft(base, { sheetThickness: 'P' }, 'mm', units())).toMatchObject({ ok: true,
      feature: { rule: { thickness: { value: 10 } } } });
  });
  it('does not reject a separate ordinary document with the same id and coefficient names', () => {
    const document = plain();
    expect(document.id).toBe(useAppStore.getState().document.id);
    const value = acceptNumericMath(formula('P', 'coefficient:1'), document, [{ id: 'coefficient:1', label: 'P', decimal: '10' }]);
    expect(evaluateNumericMath(value, new Map([['P', 10]]), new Map([['P', '10']]))).toMatchObject({ ok: true, value: { value: 10 } });
    expect(prepareNumericMathCommit(document, { value }).ok).toBe(true);
  });
});
