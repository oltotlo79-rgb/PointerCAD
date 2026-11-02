import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { ExpressionField, type ExpressionFieldProps } from '../sketch/ExpressionField.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { BeamContactDefinitions } from './BeamContactDefinitions.js';
import { BeamFrictionDefinitions } from './BeamFrictionDefinitions.js';
import { BeamPanel } from './BeamPanel.js';
import { requireBeamSession } from './beam.testSupport.js';
import { contactUiFixture } from './beamContact.testSupport.js';
import { beamDefinition, editBeamSession } from './beamSession.js';

const deferredEffects = vi.hoisted(() => ({ callbacks: [] as (() => void)[] }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof React>();
  return { ...actual, useEffect: (effect: React.EffectCallback, dependencies?: React.DependencyList): void => {
    deferredEffects.callbacks.push(() => { effect(); });
    actual.useEffect(effect, dependencies);
  } };
});

interface Control {
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
  readonly 'data-friction-step-remove'?: number;
  readonly disabled?: boolean;
  readonly ref?: { current: { focus(): void } | null };
  readonly onClick?: () => void;
  readonly onChange?: (event: { readonly target: { readonly value: string } }) => void;
}
function reached() {
  const controls: Control[] = [], fields: ExpressionFieldProps[] = [];
  function walk(node: ReactNode): void {
    Children.forEach(node, child => {
      if (!isValidElement<Control>(child)) return;
      controls.push(child.props);
      if (child.type === ExpressionField && isValidElement<ExpressionFieldProps>(child)) fields.push(child.props);
      walk(child.props.children);
    });
  }
  function Probe(): null { walk(BeamFrictionDefinitions({ session: requireBeamSession() })); return null; }
  renderToStaticMarkup(<Probe />);
  return { controls, fields };
}
function button(id: string): Control {
  const matches = reached().controls.filter(p => p['data-testid'] === id);
  expect(matches).toHaveLength(1);return matches[0];
}
function field(key: string): ExpressionFieldProps {
  const matches = reached().fields.filter(p => p.field.key === key);
  expect(matches).toHaveLength(1);return matches[0];
}
function start() {
  const fixture = contactUiFixture();
  const session = editBeamSession(fixture.session, { kind: 'analysis-type', value: 'friction' });
  useAppStore.setState({ ...fixture.state, beamSession: session });
  return fixture;
}
beforeEach(() => { resetTestStore();vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_s, get) => get()); });
afterEach(() => { vi.restoreAllMocks();resetTestStore(); });

describe('friction author controls through actual session edit callbacks (no native)', () => {
  it('edits explicit mu, solver and integer budget, invalidating the review', () => {
    const fixture = start();
    useAppStore.setState({ beamSession: { ...requireBeamSession(), reviewed: fixture.source } });
    field('friction:coefficient:contact-1').onChange('0.3');
    expect(requireBeamSession().friction.coefficients).toEqual({ 'contact-1': '0.3' });
    expect(requireBeamSession().reviewed).toBeNull();
    button('beam-friction-solver').onChange?.({ target: { value: 'nsgs' } });
    expect(requireBeamSession().friction.solver).toBe('nsgs');
    field('friction:iterationLimit').onChange('20000');
    expect(requireBeamSession().friction.iterationLimit).toBe('20000');
  });
  it('copies a stage then edits complete loads independently, preserving zero and signed expressions', () => {
    start();
    const key = 'friction:step:0:load:0:force:0';
    field(key).onChange('5 N');
    button('beam-friction-step-add').onClick?.();
    const original = requireBeamSession().friction.steps[0];
    field('friction:step:1:load:0:force:0').onChange('0');
    field('friction:step:1:load:0:moment:2').onChange('-4 N·mm');
    expect(requireBeamSession().friction.steps).toHaveLength(2);
    expect(requireBeamSession().friction.steps[0]).toBe(original);
    expect(original.loads[0].force[0]).toBe('5 N');
    expect(requireBeamSession().friction.steps[1].loads[0].force[0]).toBe('0');
    expect(requireBeamSession().friction.steps[1].loads[0].moment[2]).toBe('-4 N·mm');
  });
  it('enforces one and 32 stages and sends focus to the persistent add button after removal', () => {
    start();
    expect(reached().controls.find(p => p['data-friction-step-remove'] === 0)?.disabled).toBe(true);
    for (let n = 1; n < 32; n += 1) button('beam-friction-step-add').onClick?.();
    expect(requireBeamSession().friction.steps).toHaveLength(32);
    expect(button('beam-friction-step-add').disabled).toBe(true);
    deferredEffects.callbacks = [];
    const tree = reached(), add = tree.controls.find(p => p['data-testid'] === 'beam-friction-step-add');
    const afterCommit = deferredEffects.callbacks.at(-1);
    const remove = tree.controls.find(p => p['data-friction-step-remove'] === 31);
    if (add?.ref === undefined || remove?.onClick === undefined) throw new Error('Reached ref and remove required');
    const focus = vi.fn();add.ref.current = { focus };remove.onClick();
    expect(focus).not.toHaveBeenCalled(); // The add button is still disabled until the render commits.
    if (afterCommit === undefined) throw new Error('Missing post-commit focus effect');
    afterCommit();
    expect(focus).toHaveBeenCalledOnce();
    expect(requireBeamSession().friction.steps).toHaveLength(31);
  });
  it('shows invalid field diagnostics and refuses the same draft on review without invented defaults', () => {
    const fixture = start();
    for (const source of ['', '-0.1', 'bad(']) {
      field('friction:coefficient:contact-1').onChange(source);
      expect(field('friction:coefficient:contact-1').result.error).not.toBeNull();
      const checked = beamDefinition(requireBeamSession(), fixture.source, []);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.field).toBe('friction:coefficient:contact-1');
    }
    field('friction:coefficient:contact-1').onChange('0.3');
    field('friction:iterationLimit').onChange('1.5');
    expect(field('friction:iterationLimit').result.error).not.toBeNull();
    const checked = beamDefinition(requireBeamSession(), fixture.source, []);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.field).toBe('friction:iterationLimit');
    field('friction:iterationLimit').onChange('64');
    field('friction:step:0:load:0:force:0').onChange('');
    expect(field('friction:step:0:load:0:force:0').result.error).not.toBeNull();
    expect(beamDefinition(requireBeamSession(), fixture.source, []).ok).toBe(false);
  });
  it('keeps old contact factors while friction reuses contact rows, six restraints and its dedicated author', () => {
    const fixture = start();
    const friction = renderToStaticMarkup(<BeamPanel session={requireBeamSession()} />);
    expect(friction).toContain('data-testid="beam-friction-definitions"');
    expect(friction).toContain('data-beam-contact="contact-1"');
    expect(friction.match(/data-beam-restraint=/gu)).toHaveLength(12);
    expect(friction).not.toContain('data-testid="beam-contact-factors"');
    expect(friction).not.toContain('data-testid="beam-axial-bolts"');
    expect(friction).toContain(t('beam.frictionMemberLoadsHelp'));
    const contact = renderToStaticMarkup(<BeamContactDefinitions session={fixture.session} />);
    expect(contact).toContain('data-testid="beam-contact-factors"');
    expect(contact).toContain('data-beam-contact-factor="0"');
  });
});
