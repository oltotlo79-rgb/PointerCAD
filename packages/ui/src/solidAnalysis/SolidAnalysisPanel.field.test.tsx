import type { CadSolidOutcome } from '@pointercad/fem';
import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { SolidAnalysisPanel } from './SolidAnalysisPanel.js';
import { solidFieldCssColor } from './solidFieldLayer.js';
import { solidAnalysisFieldOf } from './solidFieldState.js';

type SolidResult = Extract<CadSolidOutcome, { kind: 'result' }>;
type Vector3 = readonly [number, number, number];
type Vector6 = readonly [number, number, number, number, number, number];
interface Props {
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
  readonly 'aria-label'?: string;
  readonly value?: string;
  readonly style?: { readonly backgroundColor?: string };
  readonly onChange?: (event: { readonly target: { readonly value: string } }) => void;
}
const NODES: readonly Vector3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [2 / 3, 2 / 3, 2 / 3]];

/** Two Tet4 sharing a face, with independent per-element stresses (same fixture shape as solidFieldView.test.ts). */
function outcome(stresses: readonly Vector6[]): SolidResult {
  const input = { schema: 'pointercad-solid-tet4/1', source: { documentId: 'd', revision: 1, meshKey: 'm' }, units: 'N-mm-MPa',
    numericBudgetBytes: 1, nodes: NODES, elements: [{ nodes: [0, 1, 2, 3] as const, materialId: 'material' },
      { nodes: [4, 1, 3, 2] as const, materialId: 'material' }],
    materials: [{ id: 'material', youngMPa: 1, poisson: 0.3 }], constraints: [], nodalLoads: [], surfaceLoads: [] } as const;
  const result: SolidResult['result'] = { kind: 'oofem-linear-solid-tet4', source: input.source, inputSha256: 'x',
    method: 'oofem-ltrspace-isole-native-ldlt/1', units: 'N-mm-MPa', structuralCertification: false,
    displacementMm: NODES.map((): Vector3 => [0, 0, 0]), reactionN: NODES.map((): Vector3 => [0, 0, 0]),
    elements: stresses.map(stressMPa => ({ strain: [0, 0, 0, 0, 0, 0] as const, stressMPa })), strainEnergyNmm: 0,
    maximumRelativeEquilibriumResidual: 0, reservedNumericBytes: 0, nativeElementForcesN: [[], []], minimumScaledPivot: 1 };
  const mesh: SolidResult['mesh'] = { kind: 'netgen-tetra-mesh', input: { schema: 'pointercad-convex-plc/1',
    source: { documentId: 'd', revision: 1, featureId: 'f', bodyKey: 'k' }, units: 'mm', coordinates: [], triangles: [],
    tags: [], tagCount: 0 }, inputSha256: 'x', coordinates: [], tetrahedra: [], boundaryTriangles: [], boundaryTags: [],
  volumeMm3: 0, minTetVolumeMm3: 0 };
  return { kind: 'result', result, prepared: { input, loadedAreaMm2: 1, totalForceN: [0, 0, 0] }, mesh };
}
function elements(): Props[] {
  const rows: Props[] = [];
  function walk(node: ReactNode): void { Children.forEach(node, child => {
    if (isValidElement<Props>(child)) { rows.push(child.props); walk(child.props.children); }
  }); }
  function Probe(): null {
    const session = useAppStore.getState().solidAnalysisSession;
    if (!session) throw new Error('Missing session');
    walk(SolidAnalysisPanel({ session })); return null;
  }
  renderToStaticMarkup(<Probe />); return rows;
}
function markup(): string {
  const session = useAppStore.getState().solidAnalysisSession;
  if (!session) throw new Error('Missing session');
  return renderToStaticMarkup(<SolidAnalysisPanel session={session} />);
}
const row = (id: string): Props | undefined => elements().find(props => props['data-testid'] === id);
const MIXED: readonly Vector6[] = [[100, 0, 0, 0, 0, 0], [-40, 0, 0, 0, 0, 20]];
function complete(stresses: readonly Vector6[]): void {
  const session = useAppStore.getState().solidAnalysisSession;
  if (!session) throw new Error('Missing session');
  useAppStore.setState({ solidAnalysisSession: { ...session, status: 'complete', result: outcome(stresses) } });
}
function drawnScale(): number | undefined {
  return solidAnalysisFieldOf(useAppStore.getState().solidAnalysisSession)?.deformationScale;
}

beforeEach(() => {
  resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null });
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
  useAppStore.getState().toggleStrength();
  useAppStore.setState({ solidAnalysisRunner: { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() } });
  useAppStore.getState().openSolidAnalysis();
});
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); resetTestStore(); });

describe('solid analysis field view panel (Node, not browser acceptance)', () => {
  it('shows the empty state and no field controls before a result exists', () => {
    expect(row('solid-field-empty')).toBeDefined();
    expect(row('solid-field-view')).toBeUndefined();
    expect(markup()).toContain(t('solidAnalysis.fieldEmpty'));
  });

  it('shows a labelled quantity selector and signed MPa bounds that follow the selected component', () => {
    complete(MIXED);
    expect(row('solid-field-empty')).toBeUndefined();
    const text = markup();
    for (const key of ['solidAnalysis.fieldView', 'solidAnalysis.fieldQuantity', 'solidAnalysis.deformationScale',
      'solidAnalysis.legendMinimum', 'solidAnalysis.legendMaximum', 'solidAnalysis.fieldVonMises',
      'solidAnalysis.fieldXy'] as const) expect(text).toContain(t(key));
    // Default von Mises: element 0 = 100, element 1 = hypot(40/sqrt2, 0, 40/sqrt2, sqrt3*20) = sqrt(2800).
    expect(text).toContain(`${Math.sqrt(2800)} MPa`);
    expect(text).toContain('100 MPa');
    row('solid-field-quantity')?.onChange?.({ target: { value: 'xx' } });
    expect(useAppStore.getState().solidAnalysisSession?.fieldView.quantity).toBe('xx');
    expect(markup()).toContain('-40 MPa');
    expect(markup()).not.toContain(`${Math.sqrt(2800)} MPa`);
    row('solid-field-quantity')?.onChange?.({ target: { value: 'not-a-quantity' } });
    expect(useAppStore.getState().solidAnalysisSession?.fieldView.quantity).toBe('xx');
  });

  it('shows the drawn low/high colours with an accessible signed range, and one colour for a constant component', () => {
    complete(MIXED);
    row('solid-field-quantity')?.onChange?.({ target: { value: 'xx' } });
    expect(row('solid-field-ramp-low')?.style?.backgroundColor).toBe(solidFieldCssColor(0));
    expect(row('solid-field-ramp-high')?.style?.backgroundColor).toBe(solidFieldCssColor(1));
    expect(row('solid-field-ramp')?.['aria-label']).toBe(`${t('solidAnalysis.legendRamp')} -40 MPa - 100 MPa`);
    row('solid-field-quantity')?.onChange?.({ target: { value: 'zz' } });
    expect(markup()).toContain(t('solidAnalysis.legendConstant'));
    expect(row('solid-field-ramp-low')?.style?.backgroundColor).toBe(solidFieldCssColor(0.5));
    expect(row('solid-field-ramp-high')?.style?.backgroundColor).toBe(solidFieldCssColor(0.5));
    expect(row('solid-field-ramp')?.['aria-label']).toBe(`${t('solidAnalysis.legendRamp')} 0 MPa - 0 MPa`);
  });

  it('shows the scale of the displayed session, equal to the drawn scale, across two sessions', () => {
    complete(MIXED);
    row('solid-field-scale')?.onChange?.({ target: { value: '25' } });
    const first = useAppStore.getState().solidAnalysisSession;
    expect(row('solid-field-scale')?.value).toBe('25');
    expect(drawnScale()).toBe(25);
    row('solid-field-scale')?.onChange?.({ target: { value: '-3' } });
    expect(drawnScale()).toBe(25); // an invalid entry never changes the drawn scale
    useAppStore.getState().openSolidAnalysis(); // replaces the session without a close
    complete(MIXED);
    const second = useAppStore.getState().solidAnalysisSession;
    expect(second?.fieldView).not.toBe(first?.fieldView);
    expect(row('solid-field-scale')?.value).toBe('1');
    expect(drawnScale()).toBe(1);
  });

  it('reports an unusable result instead of drawing values from it', () => {
    complete([[100, 0, 0, 0, 0, 0]]); // one stress for two elements: not a consistent result
    expect(row('solid-field-unavailable')).toBeDefined();
    expect(row('solid-field-legend')).toBeUndefined();
    expect(markup()).toContain(t('solidAnalysis.fieldUnavailable'));
  });
});
