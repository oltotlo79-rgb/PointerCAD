/**
 * GR-19c: regression tests for three product bugs `w15a` found while writing the math-geometry panel's
 * e2e script (`scratchpad/claude/plans/geomref-plan.md` §5.2 GR-19c,
 * `scratchpad/claude/instructions/w17b-gr19c-panel-fixes.md`).
 *
 * 1. The panel's "使用中" (usage) count and its delete refusal double-counted a coefficient's own
 *    current value against the active configuration's mirrored copy of that same formula
 *    (`mathGeometryUsage`, `packages/model/src/measure/mathGeometryIdentity.ts`) — every new document
 *    starts with exactly one configuration ("既定") that `synchronizeConfigurations` keeps mirroring
 *    `document.parameters` on every edit, so this was not an edge case.
 * 2. Confirming the comparison-margin ("比べる幅") editor after touching only one field re-parsed the
 *    *other*, untouched field's 12-significant-digit display text, drifting its stored value (e.g. the
 *    default 1e-6 rad angular margin became 1.0000000000003087e-6) — `ToleranceEditor`, `MathGeometryPanel.tsx`.
 * 3. The margin editor's per-field error text lived inside the `<label>`, so it leaked into the input's
 *    accessible name (and Playwright's `getByLabel`) instead of being tied to it only as a description
 *    via `aria-describedby`, like every other field's error display (`sketch/ExpressionField.tsx`).
 */
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExpressionValue } from '@pointercad/expression';
import { MATH_INPUT_FORMAT, type StoredMathExpression } from '@pointercad/expression/math/contracts';
import {
  createEmptyPartDocument, DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId,
  mathGeometryUsage, removeMathGeometryDefinition, synchronizeConfigurations,
  type MathGeometryDefinition, type MathGeometryOutcome, type MathGeometryTolerance,
  type Parameter, type PartDocument,
} from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import type { MathGeometryCommandResult } from './mathGeometryCommands.js';
import { ToleranceEditor } from './MathGeometryPanel.js';
import { mathGeometryRows } from './mathGeometryRows.js';
import {
  mathGeometryToleranceFields, readMathGeometryTolerance, resolveMathGeometryTolerance,
  type MathGeometryToleranceFields,
} from './mathGeometryTolerance.js';

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useState: vi.fn(react.useState) };
});
interface Control {
  readonly title?: string;
  readonly children?: unknown;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}
const rendered = vi.hoisted(() => ({ controls: [] as Control[] }));
vi.mock('react/jsx-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-runtime')>();
  const capture = (factory: typeof runtime.jsx): typeof runtime.jsx => (type, props, key) => {
    if (type === 'button' && props !== null && typeof props === 'object') rendered.controls.push(props);
    return factory(type, props, key);
  };
  return { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, key, isStatic, source, self) => {
    if (type === 'button' && props !== null && typeof props === 'object') rendered.controls.push(props);
    return runtime.jsxDEV(type, props, key, isStatic, source, self);
  };
  return { ...runtime, jsxDEV };
});

/* ---------------------------------------------------------------------------
 * Shared fixtures
 * ------------------------------------------------------------------------- */

const DEFINITION_ID = 'g1';
const DEFINITION_NAME = '箱1体積';

function definition(): MathGeometryDefinition {
  return { id: DEFINITION_ID, documentId: 'part-1', name: DEFINITION_NAME,
    quantity: { kind: 'volume', body: { kind: 'body', featureId: 'box' } }, tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}

function documentWithTolerance(tolerance: MathGeometryTolerance): PartDocument {
  return { ...createEmptyPartDocument(), mathGeometry: [{ ...definition(), tolerance }] };
}

/** The `coef("箱1体積")` formula, matching `mathGeometryParameterDraft`'s output (GR-31). */
function geometryFormula(source = `coef("${DEFINITION_NAME}")`): StoredMathExpression {
  return { format: MATH_INPUT_FORMAT, source, inputNotation: 'text', angleUnit: 'degree',
    expression: { kind: 'symbol', reference: { role: 'coefficient', id: mathGeometryCoefficientId(DEFINITION_ID), label: DEFINITION_NAME } } };
}

/** A parameter's current value `coef("箱1体積")`, matching `mathGeometryParameterDraft`'s output (GR-31). */
function derivedParameterValue(value = 24): ExpressionValue {
  const formula = geometryFormula();
  return { source: formula.source, value, display: String(value), mathDefinition: formula };
}

/**
 * One parameter referencing the measured definition, in a document whose only configuration is the
 * active default ("既定") — the everyday case. Every new document starts with exactly this one
 * configuration (`createDefaultConfigurations`), and `synchronizeConfigurations` keeps it mirroring
 * `document.parameters` on every edit (every `parameterCommands.ts` command calls it via `applied`).
 */
function documentWithMirroredUsage(): PartDocument {
  const base = createEmptyPartDocument();
  const parameter: Parameter = { name: '幅B', value: derivedParameterValue(), unit: 'none', description: '' };
  return synchronizeConfigurations({ ...base, mathGeometry: [definition()], parameters: [parameter] });
}

function installDocument(document: PartDocument): void {
  const store = useAppStore.getState();
  store.resetDocument(document);
  store.recordRecomputeRequest(1);
  const outcome: MathGeometryOutcome = { id: DEFINITION_ID, documentId: document.id, generation: 1, status: 'value',
    kind: 'real', value: 24000, unit: 'mm3', representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
  store.applyRecompute(document, { ...resultFor(document), generation: 1, mathGeometry: [outcome], bodies: [] });
  store.recordRecomputeCompletion(1, 'success');
}

function click(children: unknown): void {
  const button = rendered.controls.find(item => item.children === children);
  if (button === undefined || button.onClick === undefined) throw new Error(`Missing button: ${String(children)}`);
  expect(button.disabled).not.toBe(true);
  button.onClick();
}

/** Injects `ToleranceEditor`'s one `usePanelDraft` state directly, bypassing onChange simulation. */
function renderTolerance(owner: PartDocument, draft: Partial<MathGeometryToleranceFields> | null,
  onResult: (result: MathGeometryCommandResult) => void = vi.fn(), version = 1): string {
  rendered.controls = [];
  vi.mocked(useState).mockReturnValueOnce([{ draft, seenVersion: version }, vi.fn()]);
  return renderToStaticMarkup(createElement(ToleranceEditor, { owner, id: DEFINITION_ID, version, onResult }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every `<label>...</label>` block's own text content, so a test can assert none of them grew extra text. */
function labelContents(markup: string): readonly string[] {
  return [...markup.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map(match => match[1].trim());
}

beforeEach(() => { resetTestStore(); useAppStore.setState({ drawing: null }); });
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/* ---------------------------------------------------------------------------
 * Bug 1: usage count / delete refusal must not double-count the active configuration's mirrored copy
 * ------------------------------------------------------------------------- */

describe('bug 1: usage counting must match parameterUsageCounts (skip the active configuration)', () => {
  it('mirrors the parameter into the active "既定" configuration (sanity check on the fixture itself)', () => {
    const document = documentWithMirroredUsage();
    const active = document.configurations.find(item => item.id === document.activeConfigurationId);
    expect(active?.name).toBe('既定');
    expect(active?.mathDefinitions?.['幅B']?.source).toBe('coef("箱1体積")');
  });

  it('counts a coefficient once, not once more for the mirrored active configuration', () => {
    const document = documentWithMirroredUsage();
    expect(mathGeometryUsage(document).get(DEFINITION_ID)).toEqual(
      { parameterNames: ['幅B'], configurationNames: [], unresolvedProblemNames: [] });
  });

  it('still counts a genuinely different, non-active configuration', () => {
    const mirrored = documentWithMirroredUsage();
    const alternative = { id: 'alternative', name: '別案', values: { 幅B: 'coef("箱1体積")*2' },
      mathDefinitions: { 幅B: geometryFormula('coef("箱1体積")*2') } };
    const document = { ...mirrored, configurations: [...mirrored.configurations, alternative] };
    expect(mathGeometryUsage(document).get(DEFINITION_ID)).toEqual(
      { parameterNames: ['幅B'], configurationNames: ['別案'], unresolvedProblemNames: [] });
  });

  it('removeMathGeometryDefinition refuses naming only the real usage, not the mirrored configuration', () => {
    const document = documentWithMirroredUsage();
    const result = removeMathGeometryDefinition(document, DEFINITION_ID);
    expect(result).toEqual({ ok: false, reason: 'inUse',
      message: 'この測定値は幅Bで使われています。先にそちらを直してください。' });
  });

  it('the panel row shows one usage, not two, and names only the real usage (w15a\'s e2e expectation)', () => {
    const document = documentWithMirroredUsage();
    installDocument(document);
    const row = mathGeometryRows(useAppStore.getState())[0];
    expect(row.usageCount).toBe(1);
    expect(row.usageText).toBe('1か所');
    expect(row.usageNames).toEqual(['幅B']);
    expect(row.remove).toEqual({ ready: false, reasonKey: 'mathGeometry.error.referencedBy',
      reasonText: t('mathGeometry.error.referencedBy').replace('{names}', '幅B') });
  });
});

/* ---------------------------------------------------------------------------
 * Bug 2: confirming one touched tolerance field must not drift the untouched field
 * ------------------------------------------------------------------------- */

describe('bug 2: confirming one touched margin field must not round-trip the other', () => {
  it('demonstrates the bug: merging the edited field into the full displayed fields drifts the untouched one', () => {
    const current: MathGeometryTolerance = { linearMm: 1e-6, angularRadians: 1e-6 };
    // This is exactly what the old ToleranceEditor did: onChange spread the *displayed* fields (both
    // 12-significant-digit strings) and overwrote only the touched key, then read both back.
    const oldWay = readMathGeometryTolerance({ ...mathGeometryToleranceFields(current), linear: '2' });
    if (!oldWay.ok) throw new Error('expected the arithmetic to remain valid');
    expect(oldWay.tolerance.angularRadians).not.toBe(1e-6);
    expect(oldWay.tolerance.angularRadians).toBeCloseTo(1e-6, 15);
  });

  it('resolveMathGeometryTolerance keeps the untouched angular field exact', () => {
    const current: MathGeometryTolerance = { linearMm: 1e-6, angularRadians: 1e-6 };
    expect(resolveMathGeometryTolerance(current, { linear: '2' }))
      .toEqual({ ok: true, tolerance: { linearMm: 2, angularRadians: 1e-6 } });
  });

  it('resolveMathGeometryTolerance keeps the untouched linear field exact', () => {
    const current: MathGeometryTolerance = { linearMm: 1.23456789012345, angularRadians: 1e-6 };
    const result = resolveMathGeometryTolerance(current, { angular: '30' });
    if (!result.ok) throw new Error('expected a valid margin');
    expect(result.tolerance.linearMm).toBe(1.23456789012345);
    expect(result.tolerance.angularRadians).toBeCloseTo(Math.PI / 6, 15);
  });

  it('keeps both fields exact when neither is edited', () => {
    const current: MathGeometryTolerance = { linearMm: 1e-6, angularRadians: 1e-6 };
    expect(resolveMathGeometryTolerance(current, {})).toEqual({ ok: true, tolerance: current });
  });

  it('ToleranceEditor submits the exact stored value for the field the user never touched', () => {
    const document = documentWithTolerance({ linearMm: 1e-6, angularRadians: 1e-6 });
    useAppStore.getState().resetDocument(document);
    const onResult = vi.fn();
    renderTolerance(document, { linear: '2' }, onResult);
    click(t('mathGeometry.tolerance.apply'));
    expect(useAppStore.getState().document.mathGeometry?.[0].tolerance).toEqual({ linearMm: 2, angularRadians: 1e-6 });
    expect(onResult).toHaveBeenCalledWith({ ok: true });
  });

  it('ToleranceEditor submits the exact stored value when only the angular field is touched', () => {
    const document = documentWithTolerance({ linearMm: 1.23456789012345, angularRadians: 1e-6 });
    useAppStore.getState().resetDocument(document);
    renderTolerance(document, { angular: '30' });
    click(t('mathGeometry.tolerance.apply'));
    const tolerance = useAppStore.getState().document.mathGeometry?.[0].tolerance;
    expect(tolerance?.linearMm).toBe(1.23456789012345);
    expect(tolerance?.angularRadians).toBeCloseTo(Math.PI / 6, 15);
  });
});

/* ---------------------------------------------------------------------------
 * Bug 3: a field's error text must not become part of its accessible name
 * ------------------------------------------------------------------------- */

describe('bug 3: the margin field\'s error text lives outside its <label>, tied by aria-describedby', () => {
  it('keeps each label\'s text to just its heading when there is no error', () => {
    const document = documentWithTolerance({ linearMm: 1e-6, angularRadians: 1e-6 });
    const markup = renderTolerance(document, null);
    expect(labelContents(markup)).toEqual([
      t('mathGeometry.tolerance.linearLabel'), t('mathGeometry.tolerance.angularLabel'),
    ]);
  });

  it('demonstrates the bug: the old markup shape put the error text inside the <label>', () => {
    // The old JSX shape, reproduced verbatim as plain HTML (not through the component) to show why
    // wrapping the error <span> inside <label> leaks it into the input's accessible name.
    const oldMarkup = '<label class="pcad-field">'
      + '<span class="pcad-field__label">長さの幅（mm）</span>'
      + '<input type="text" class="pcad-field__input" value="-1" aria-invalid="true"/>'
      + '<span class="pcad-field__message">長さの幅は0より大きい有限の数にしてください。</span>'
      + '</label>';
    expect(labelContents(oldMarkup)[0]).toContain('長さの幅は0より大きい有限の数にしてください。');
  });

  it('moves the error text out of the label and ties it to the input with aria-describedby', () => {
    const document = documentWithTolerance({ linearMm: 1e-6, angularRadians: 1e-6 });
    const markup = renderTolerance(document, { linear: '-1' });
    const errorText = t('mathGeometry.tolerance.error.linear');
    expect(markup).toContain(errorText);
    // The name stays just the heading: no label anywhere in the markup contains the error sentence.
    expect(labelContents(markup).some(content => content.includes(errorText))).toBe(false);
    expect(labelContents(markup)).toContain(t('mathGeometry.tolerance.linearLabel'));
    // The error text is a sibling <p id="..."> that the input reaches only via aria-describedby.
    const paragraph = new RegExp(`<p id="([^"]+)"[^>]*>${escapeRegExp(errorText)}</p>`).exec(markup);
    expect(paragraph).not.toBeNull();
    const messageId = paragraph?.[1];
    expect(markup).toContain(`aria-describedby="${messageId}"`);
  });

  it('the angular field keeps its own separate message id and stays unaffected by the linear error', () => {
    const document = documentWithTolerance({ linearMm: 1e-6, angularRadians: 1e-6 });
    const markup = renderTolerance(document, { linear: '-1' });
    expect(labelContents(markup)).toContain(t('mathGeometry.tolerance.angularLabel'));
    expect(markup).not.toContain(t('mathGeometry.tolerance.error.angular'));
  });
});
