import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { BeamContactDefinitions } from './BeamContactDefinitions.js';
import { BeamImpactDefinitions } from './BeamImpactDefinitions.js';
import { BeamPanel } from './BeamPanel.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { contactUiFixture } from './beamContact.testSupport.js';
import { beamDefinition, editBeamSession, type BeamEdit, type BeamSession } from './beamSession.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

interface ElementProps {
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
  readonly 'data-beam-impact-field'?: string;
  readonly 'data-beam-impact-pair'?: string;
  readonly onChange?: (event: { readonly target: { readonly value: string } }) => void;
}
/** Props of the shared expression field inside an impact wrapper. */
interface FieldProps {
  readonly onChange?: (source: string) => void;
  readonly unitLabel?: string;
}
interface Found { readonly type: unknown; readonly props: ElementProps }
/** Same node-only walk as the contact panel test: nested components stay opaque and are rendered through Probe. */
function elements(render: () => ReactNode): Found[] {
  const found: Found[] = [];
  function walk(node: ReactNode): void {
    Children.forEach(node, child => {
      if (!isValidElement<ElementProps>(child)) return;
      found.push({ type: child.type, props: child.props });
      walk(child.props.children);
    });
  }
  function Probe(): null {
    walk(render());
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return found;
}
const panel = (): Found[] => elements(() => BeamPanel({ session: requireBeamSession() }));
const impactEditor = (): Found[] => elements(() => BeamImpactDefinitions({ session: requireBeamSession() }));
function one(found: readonly Found[], predicate: (props: ElementProps) => boolean, what: string): ElementProps {
  const matches = found.filter(row => predicate(row.props));
  expect(matches, what).toHaveLength(1);
  return matches[0].props;
}
/** Types into the shared expression field inside the wrapper with this key, through its own onChange. */
function field(key: string): FieldProps {
  const wrapper = one(impactEditor(), props => props['data-beam-impact-field'] === key, key);
  const child = Children.toArray(wrapper.children).find(node => isValidElement<FieldProps>(node));
  if (!isValidElement<FieldProps>(child)) throw new Error(`Missing field ${key}`);
  return child.props;
}
function type(key: string, source: string): void {
  const change = field(key).onChange;
  if (change === undefined) throw new Error(`Missing change handler ${key}`);
  change(source);
}
const fieldUnit = (key: string): string | undefined => field(key).unitLabel;

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/** The contact form's plane row reused as an impact plane; the member's reference load is cleared (impact has none). */
function impactStore(runner = { run: vi.fn(), cancel: vi.fn() }) {
  const fixture = contactUiFixture();
  const edits: readonly BeamEdit[] = [
    { kind: 'analysis-type', value: 'impact' },
    { kind: 'value', id: fixture.member.id, field: 'endFz', source: '0' },
  ];
  const session: BeamSession = edits.reduce(editBeamSession, fixture.session);
  useAppStore.setState({ ...fixture.state, beamRunner: runner, beamSession: session });
  return { fixture, runner };
}

describe('BeamPanel impact controls (node, not DOM)', () => {
  it('offers impact as an analysis type and renders the impact editor instead of the contact editor', () => {
    const fixture = beamUiFixture();
    const runner = { run: vi.fn(), cancel: vi.fn() };
    useAppStore.setState({ ...fixture.state, beamRunner: runner, beamSession: { ...fixture.session, reviewed: fixture.source } });
    const selector = one(panel(), props => props['data-testid'] === 'beam-analysis-type', 'analysis selector');
    if (selector.onChange === undefined) throw new Error('Missing analysis selector handler');
    selector.onChange({ target: { value: 'impact' } });
    expect(requireBeamSession().analysisType).toBe('impact');
    expect(requireBeamSession().reviewed).toBeNull();
    expect(runner.cancel).toHaveBeenCalledOnce();
    expect(panel().filter(row => row.type === BeamImpactDefinitions)).toHaveLength(1);
    expect(panel().filter(row => row.type === BeamContactDefinitions)).toHaveLength(0);
  });

  it('every control edit reaches the saved schema 6 with the shown units (m/s, N/m, ms to s, mm kept)', () => {
    const { fixture } = impactStore();
    const end = fixture.member.endNodeId;
    expect(fieldUnit(`impact:velocity:${end}:2`)).toBe('m/s');
    expect(fieldUnit('impact:contactStiffness')).toBe('N/m');
    type(`impact:velocity:${end}:2`, '-2');
    type('impact:contactStiffness', '10000000');
    type('impact:timeStep', '0.01ms');
    type('impact:stepCount', '200');
    type('impact:outputEvery', '2');
    const checked = beamDefinition(requireBeamSession(), fixture.source, []);
    if (!checked.ok) throw new Error(`Expected valid impact input: ${checked.key} ${checked.field ?? ''}`);
    if (checked.definition.schema !== 'pointercad-standard-beam/6') throw new Error('Expected schema 6');
    const impact = checked.definition.impact;
    expect(impact.initialVelocities).toEqual([{ nodeId: end, velocityMPerS: [0, 0, -2] }]);
    expect(impact.contactStiffnessNPerM).toBe(10000000);
    expect(impact.history.timeStepS).toBeCloseTo(1e-5, 18);
    expect(impact.history.stepCount).toBe(200);
    expect(impact.history.outputEvery).toBe(2);
    // The plane keeps the entered direction and the gap in mm (0.5 mm, not 0.0005).
    expect(impact.planes).toEqual([{ id: 'contact-1', nodeId: end, normal: [0, 0, 1], gapMm: 0.5 }]);
  });

  it('an edit while running cancels the run and discards the reviewed state', () => {
    const { fixture, runner } = impactStore();
    useAppStore.setState({ beamSession: { ...requireBeamSession(), status: 'running', reviewed: fixture.source } });
    type('impact:stepCount', '300');
    expect(runner.cancel).toHaveBeenCalled();
    expect(requireBeamSession().status).toBe('editing');
    expect(requireBeamSession().reviewed).toBeNull();
    expect(requireBeamSession().impact.stepCount).toBe('300');
  });

  it('shows a node pair left from the contact analysis as unsupported and refuses it on review', () => {
    const { fixture } = impactStore();
    // Establish one valid problem before isolating the unsupported pair condition.
    type(`impact:velocity:${fixture.member.endNodeId}:2`, '-2');
    type('impact:contactStiffness', '10000000');
    type('impact:timeStep', '0.01ms');
    type('impact:stepCount', '200');
    type('impact:outputEvery', '2');
    expect(beamDefinition(requireBeamSession(), fixture.source, []).ok).toBe(true);
    useAppStore.setState({ beamSession: editBeamSession(editBeamSession(requireBeamSession(),
      { kind: 'contact-kind', index: 0, value: 'node-pair' }),
    { kind: 'contact-node', index: 0, end: 'b', nodeId: fixture.member.startNodeId }) });
    one(impactEditor(), props => props['data-beam-impact-pair'] === 'contact-1', 'unsupported pair notice');
    expect(beamDefinition(requireBeamSession(), fixture.source, [])).toMatchObject({ ok: false, key: 'beam.error.impactPairUnsupported' });
  });

  it('never prepares a saved impact as another analysis route', () => {
    const { fixture } = impactStore();
    type(`impact:velocity:${fixture.member.endNodeId}:2`, '-2');
    type('impact:contactStiffness', '10000000');
    type('impact:timeStep', '0.01ms');
    type('impact:stepCount', '200');
    type('impact:outputEvery', '2');
    const checked = beamDefinition(requireBeamSession(), fixture.source, []);
    if (!checked.ok) throw new Error('Expected valid impact input');
    expect(prepareBeamAnalysis(fixture.source, checked.definition)).toMatchObject({ ok: true, kind: 'impact',
      input: { schema: 'pointercad-beam-impact/1',
        initialVelocities: [{ nodeId: fixture.member.endNodeId, velocityMPerS: [0, 0, -2] }],
        contacts: [{ nodeId: fixture.member.endNodeId, directionUnit: [0, 0, 1], gapM: 0.0005 }] } });
  });
});
