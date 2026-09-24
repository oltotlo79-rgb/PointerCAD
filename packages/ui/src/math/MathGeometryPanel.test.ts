import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { appendSolid, DEFAULT_MATH_GEOMETRY_TOLERANCE, type MathGeometryOutcome,
  type MathGeometryQuantity, type PartDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type MessageKey } from '../i18n/t.js';
import { PropertyPanel } from '../shell/PropertyPanel.js';
import { useAppStore } from '../store/useAppStore.js';
import { bodyFor, extrudeFeature, partWithPoint, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { MathGeometryPanel } from './MathGeometryPanel.js';
import { mathGeometryPanelGuideText, mathGeometryRows } from './mathGeometryRows.js';

interface Control {
  readonly title?: string;
  readonly children?: React.ReactNode;
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

const VOLUME: MathGeometryQuantity = { kind: 'volume', body: { kind: 'body', featureId: 'box' } };
function install(quantity: MathGeometryQuantity = VOLUME, value = 24000): PartDocument {
  const base = appendSolid(partWithPoint(), { ...extrudeFeature('box'), name: 'Box' });
  const document: PartDocument = { ...base, mathGeometry: [{ id: 'g', documentId: base.id, name: 'Measured', quantity,
    tolerance: { linearMm: 0.002, angularRadians: 0.003 } }] };
  const store = useAppStore.getState();
  store.resetDocument(document);
  store.recordRecomputeRequest(1);
  const outcome: MathGeometryOutcome = { id: 'g', documentId: base.id, generation: 1, status: 'value', kind: 'real', value,
    unit: 'unit' in quantity ? quantity.unit : 'mm3', representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
  store.applyRecompute(document, { ...resultFor(document), generation: 1, mathGeometry: [outcome],
    bodies: [{ ...bodyFor('box'), bodyKind: 'solid' }] });
  store.recordRecomputeCompletion(1, 'success');
  store.setActiveTool('mathGeometry');
  return document;
}

function render(component = MathGeometryPanel): string {
  rendered.controls = [];
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(createElement(component)); } finally { snapshot.mockRestore(); }
}
function click(key: MessageKey): void {
  const button = rendered.controls.find(item => item.children === t(key));
  if (button === undefined || button.onClick === undefined) throw new Error(`Missing button: ${key}`);
  expect(button.disabled).not.toBe(true);
  button.onClick();
}
beforeEach(() => { resetTestStore(); useAppStore.setState({ drawing: null }); });
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('GR-19b: measurement panel wiring', () => {
  it('renders current names, quantities, values, margins and guide from the shared readers', () => {
    install();
    const row = mathGeometryRows(useAppStore.getState())[0], markup = render();
    for (const text of [row.name, row.kindLabel, row.targetsSummary, row.valueText, row.toleranceText,
      row.toleranceNote, row.usageText, mathGeometryPanelGuideText(useAppStore.getState())]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('data-help-topic="math-input"');
    expect(markup).toContain('value="Measured"');
    expect(markup).toContain(t('mathGeometry.reselectHint'));
  });

  it.each(['computing', 'cancelled', 'timeline'] as const)('%s displays the shared reason instead of the old measurement', status => {
    install();
    if (status === 'computing') useAppStore.setState({ requestedGeneration: 2 });
    if (status === 'cancelled') useAppStore.setState({ recomputeCancelled: true });
    if (status === 'timeline') useAppStore.setState({ timelineIndex: 0 });
    const markup = render();
    expect(markup).toContain(t(`mathGeometry.status.${status}`));
    expect(markup).not.toContain('24000 mm³');
    expect(rendered.controls.find(item => item.children === t('mathGeometry.createParameter'))?.disabled).toBe(true);
  });

  it('appears first in properties and suppresses both temporary measurement sections until exit', () => {
    install();
    useAppStore.setState({ selection: ['box'] });
    const markup = render(PropertyPanel);
    const titles = [...markup.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map(match => match[1]);
    expect(titles[0]).toBe(t('mathGeometry.title'));
    expect(titles).not.toContain(t('propertyPanel.sectionMeasure'));
    expect(titles).not.toContain(t('propertyPanel.sectionMassProperties'));
    const before = useAppStore.getState();
    click('mathGeometry.closeTool');
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().selection).toEqual(['box']);
    expect(useAppStore.getState().focusViewportRequestCount).toBe(before.focusViewportRequestCount + 1);
    const after = render(PropertyPanel);
    expect(after).toContain(t('propertyPanel.sectionMeasure'));
    expect(after).toContain(t('propertyPanel.sectionMassProperties'));
    expect(after).not.toContain('data-math-geometry-id');
  });

  it('adds the selected candidate through the command with a single Undo entry', () => {
    const owner = install();
    useAppStore.setState({ selection: ['box'] });
    render();
    click('mathGeometry.add');
    expect(useAppStore.getState().document.mathGeometry).toHaveLength(2);
    expect(useAppStore.getState().document.mathGeometry?.[1].quantity).toEqual(VOLUME);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(owner);
  });

  it('refuses an add event if computation began after rendering', () => {
    const owner = install();
    useAppStore.setState({ selection: ['box'] });
    render();
    useAppStore.setState({ requestedGeneration: 2 });
    click('mathGeometry.add');
    expect(useAppStore.getState().document).toBe(owner);
  });

  it('creates a coefficient with the measured reference and disables deletion of the used definition', () => {
    const owner = install();
    render();
    click('mathGeometry.createParameter');
    const parameter = useAppStore.getState().document.parameters[0];
    expect(parameter.value.source).toBe('coef("Measured")');
    expect(parameter.name).toBe(`Measured${t('mathGeometry.createParameter.nameSuffix')}`);
    const markup = render();
    expect(markup).toContain(parameter.name);
    expect(rendered.controls.find(item => item.children === t('mathGeometry.delete'))?.disabled).toBe(true);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(owner);
  });

  it('deletes an unused definition and restores it in one Undo', () => {
    const owner = install();
    render();
    click('mathGeometry.delete');
    expect(useAppStore.getState().document.mathGeometry).toEqual([]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(owner);
  });

  it('resets margins to the exact constants instead of round-tripping displayed degrees', () => {
    const owner = install();
    render();
    click('mathGeometry.tolerance.reset');
    expect(useAppStore.getState().document.mathGeometry?.[0].tolerance).toEqual(DEFAULT_MATH_GEOMETRY_TOLERANCE);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(owner);
  });

  it('connects angle controls for extended angular quantities', () => {
    const point = { kind: 'sketch-point', sketchId: 'sketch-1', reference: { kind: 'point', pointId: 'point-1' } } as const;
    const owner = install({ kind: 'point-angle', first: point, second: point, third: point, unit: 'degree' }, 60);
    render();
    click('mathGeometry.unit.radian');
    expect(useAppStore.getState().document.mathGeometry?.[0].quantity).toMatchObject({ kind: 'point-angle', unit: 'radian' });
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(owner);
  });

  it('reselects through the shared same-kind candidate and preserves identity, name and margins', () => {
    const owner = install();
    useAppStore.setState({ selection: ['box'] });
    render();
    click('mathGeometry.reselect');
    expect(useAppStore.getState().document.mathGeometry?.[0]).toEqual(owner.mathGeometry?.[0]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(owner);
  });

  it('does not expose controls outside the active tool', () => {
    install();
    useAppStore.getState().setActiveTool('select');
    expect(render()).toBe('');
    expect(rendered.controls).toEqual([]);
  });

  it('provides a nonempty title on every rendered control', () => {
    install();
    const markup = render();
    for (const match of markup.matchAll(/<(?:button|input|select|summary)\b[^>]*>/g)) {
      expect(match[0]).toMatch(/title="[^"]+"/);
    }
  });

  /**
   * GR-19d (w15a's e2e finding): the row's properties list must carry a class of its own, on top of
   * the shared `.pcad-properties`, so `appShell.css` can size its heading column without touching the
   * other panels that reuse `.pcad-properties` (`mathGeometryPanelListLayout.test.ts` checks the CSS
   * rule itself). Every heading text must still be in the markup as its own `<dt>` — the bug was a
   * layout collapse, not a missing element, so the markup already had these before the fix; this test
   * mainly guards the scoping class from silently disappearing again.
   */
  it('GR-19d: scopes each row\'s properties list with its own class and keeps every heading', () => {
    install();
    const markup = render();
    expect(markup).toContain('class="pcad-properties pcad-parameter__properties"');
    for (const key of ['mathGeometry.quantityLabel', 'mathGeometry.targetsLabel', 'mathGeometry.valueLabel',
      'mathGeometry.toleranceLabel'] as const) {
      expect(markup).toContain(`<dt class="pcad-properties__key">${t(key)}</dt>`);
    }
  });

  /** GR-19d (w15a's e2e finding): the quantity-to-add field needs its own class so appShell.css can give it the same left/right margin as its siblings, without changing `.pcad-parameters__fields`, which `ParameterPanel` also uses. */
  it('GR-19d: gives the quantity-to-add field its own class for the panel\'s left/right margin', () => {
    install();
    const markup = render();
    expect(markup).toContain('class="pcad-field pcad-parameters__quantity-field"');
  });
});
