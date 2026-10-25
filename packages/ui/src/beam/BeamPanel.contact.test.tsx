import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { BeamContactDefinitions } from './BeamContactDefinitions.js';
import { BeamContactResults } from './BeamContactResults.js';
import { BeamPanel } from './BeamPanel.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { contactResultFor, contactUiFixture } from './beamContact.testSupport.js';
import { beamDisplayNumber } from './BeamResults.js';
import { beamDefinition, editBeamSession } from './beamSession.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

interface ElementProps {
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
  readonly 'data-beam-contact-node'?: string;
  readonly 'data-beam-contact-factor'?: number;
  readonly onClick?: () => void;
  readonly onBlurCapture?: (event: { readonly target: EventTarget }) => void;
  readonly ref?: { current: { contains(node: unknown): boolean } | null };
  readonly disabled?: boolean;
  readonly onChange?: (event: { readonly target: { readonly value: string } }) => void;
}
interface Found { readonly type: unknown; readonly props: ElementProps }
/** Walks the element tree a component returns. Function components below it stay opaque elements (their type is kept),
 * so nested controls are reached by rendering that component itself through the same Probe boundary. */
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
const definitions = (): Found[] => elements(() => BeamContactDefinitions({ session: requireBeamSession() }));
/** Exactly one reached element satisfies the predicate (explicit evidence that the nested control was reached). */
function one(found: readonly Found[], predicate: (props: ElementProps) => boolean, what: string): ElementProps {
  const matches = found.filter(row => predicate(row.props));
  expect(matches, what).toHaveLength(1);
  return matches[0].props;
}
const html = (): string => renderToStaticMarkup(<BeamPanel session={requireBeamSession()} />);
const escaped = (text: string): string => renderToStaticMarkup(<>{text}</>);
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('BeamPanel contact form and results (node, not DOM)', () => {
  it('offers contact as a fifth analysis type with six-DOF supports, the plain scope and the contact editor', () => {
    const fixture = beamUiFixture();
    const runner = { run: vi.fn(), cancel: vi.fn() };
    useAppStore.setState({ ...fixture.state, beamRunner: runner, beamSession: { ...fixture.session, reviewed: fixture.source } });
    const selector = one(panel(), props => props['data-testid'] === 'beam-analysis-type', 'analysis selector');
    if (selector.onChange === undefined) throw new Error('Missing analysis selector handler');
    selector.onChange({ target: { value: 'contact' } });
    expect(requireBeamSession().analysisType).toBe('contact');
    expect(requireBeamSession().reviewed).toBeNull();
    expect(runner.cancel).toHaveBeenCalledOnce();
    // The panel itself renders the contact editor for this session (the editor is an opaque element in its tree).
    const editors = panel().filter(row => row.type === BeamContactDefinitions);
    expect(editors).toHaveLength(1);
    expect(editors[0].props).toHaveProperty('session', requireBeamSession());
    const markup = html();
    expect(markup).toContain('<option value="contact"');
    expect(markup).toContain(escaped(t('beam.contactScope')));
    expect(markup).toContain(escaped(t('beam.contactSupportHelp')));
    expect(markup).toContain(escaped(t('beam.contactReferenceLoads')));
    expect(markup).toContain('data-testid="beam-contact-definitions"');
    expect(markup.match(/data-beam-restraint=/gu)).toHaveLength(12);
    expect(markup).not.toContain('data-beam-fixed=');
    // The form starts with no contact; only the add buttons and one empty factor row exist.
    expect(markup).not.toContain('data-beam-contact="');
    expect(markup).toContain('data-beam-contact-factor="0"');
    // The editor's own tree starts with no contact: the add buttons and exactly one empty factor row are reached.
    const editor = definitions();
    expect(editor.filter(row => row.props['data-beam-contact-node'] !== undefined)).toHaveLength(0);
    one(editor, props => props['data-testid'] === 'beam-contact-add', 'add contact');
    one(editor, props => props['data-testid'] === 'beam-contact-factor-add', 'add factor');
    one(editor, props => props['data-beam-contact-factor'] === 0, 'factor row 0');
    expect(editor.filter(row => row.props['data-beam-contact-factor'] !== undefined)).toHaveLength(1);
  });

  it('keeps blur view-only and refocuses the same refused field through the reached review callback', () => {
    const fixture = contactUiFixture();
    const invalid = editBeamSession(fixture.session,
      { kind: 'contact-value', index: 0, field: 'gap', source: '-0.01' });
    const field = 'contact:contact-1:gap';
    const runner = { run: vi.fn(), cancel: vi.fn() };
    useAppStore.setState({ ...fixture.state, beamRunner: runner,
      beamSession: { ...invalid, focusedField: field } });
    // Typed adapter only: this does not claim physical DOM/pointer delivery.
    class FieldElement extends EventTarget {
      readonly classList = { contains: (name: string): boolean => name === 'pcad-field__input' };
      isConnected = true;
      readonly focus = vi.fn();
    }
    vi.stubGlobal('HTMLElement', FieldElement);
    const input = new FieldElement();
    try {
      const reached = panel();
      const form = one(reached, props => props['data-testid'] === 'beam-panel', 'beam form');
      const review = one(reached, props => props['data-testid'] === 'beam-review', 'review');
      if (form.onBlurCapture === undefined || form.ref === undefined || review.onClick === undefined) {
        throw new Error('Missing reached focus adapter');
      }
      form.ref.current = { contains: node => node === input };
      const beforeBlur = useAppStore.getState();
      form.onBlurCapture({ target: input });
      expect(useAppStore.getState()).toBe(beforeBlur);
      expect(requireBeamSession()).toBe(beforeBlur.beamSession);
      expect(runner.cancel).not.toHaveBeenCalled();
      review.onClick();
      expect(requireBeamSession().errorKey).toBe('beam.error.contactGap');
      expect(requireBeamSession().focusedField).toBe(field);
      expect(input.focus).toHaveBeenCalledOnce();
      const beforeRepeat = useAppStore.getState();
      form.onBlurCapture({ target: input });
      expect(useAppStore.getState()).toBe(beforeRepeat);
      review.onClick();
      expect(input.focus).toHaveBeenCalledTimes(2);
      expect(requireBeamSession().contact).toBe(invalid.contact);
      expect(requireBeamSession().revision).toBe(invalid.revision);
      expect(runner.run).not.toHaveBeenCalled();
      input.isConnected = false;
      form.onBlurCapture({ target: input });
      review.onClick();
      expect(input.focus).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it('lists only the selected member end nodes, keeps a stale node visible as missing and routes the reached select', () => {
    const fixture = contactUiFixture();
    useAppStore.setState({ ...fixture.state, beamSession: fixture.session });
    const markup = html();
    expect(markup).toContain('data-beam-contact="contact-1"');
    expect(markup).toContain(`<option value="${fixture.member.startNodeId}">`);
    expect(markup).toContain(`<option value="${fixture.member.endNodeId}" selected="">`);
    expect(markup).not.toContain(escaped(t('beam.contactMissingNode')));
    useAppStore.setState({ beamSession: editBeamSession(fixture.session,
      { kind: 'contact-node', index: 0, end: 'a', nodeId: 'beam-member-9-end' }) });
    expect(html()).toContain(escaped(`${t('beam.contactMissingNode')}: beam-member-9-end`));
    // A plane contact has exactly one node select; it is reached in the editor's own tree and its handler routes.
    const editor = definitions();
    expect(editor.filter(row => row.props['data-beam-contact-node'] !== undefined)).toHaveLength(1);
    const select = one(editor, props => props['data-beam-contact-node'] === 'contact-1:a', 'contact node select');
    if (select.onChange === undefined) throw new Error('Missing contact node handler');
    select.onChange({ target: { value: fixture.member.startNodeId } });
    expect(requireBeamSession().contact.rows[0].nodeIdA).toBe(fixture.member.startNodeId);
  });

  it('adds contacts and factors through the reached buttons, with the factor remove limit enforced', () => {
    const fixture = contactUiFixture();
    useAppStore.setState({ ...fixture.state, beamSession: { ...fixture.session,
      contact: { ...fixture.session.contact, loadFactors: ['1'] } } });
    expect(html()).toContain('data-beam-contact-factor-remove="0" disabled=""');
    const add = one(definitions(), props => props['data-testid'] === 'beam-contact-add', 'add contact');
    if (add.onClick === undefined) throw new Error('Missing add contact handler');
    add.onClick();
    expect(requireBeamSession().contact.rows.map(row => row.id)).toEqual(['contact-1', 'contact-2']);
    expect(definitions().filter(row => row.props['data-beam-contact-node'] !== undefined)).toHaveLength(2);
    const addFactor = one(definitions(), props => props['data-testid'] === 'beam-contact-factor-add', 'add factor');
    if (addFactor.onClick === undefined) throw new Error('Missing add factor handler');
    addFactor.onClick();
    expect(requireBeamSession().contact.loadFactors).toEqual(['1', '']);
    expect(definitions().filter(row => row.props['data-beam-contact-factor'] !== undefined)).toHaveLength(2);
  });

  it('shows the accepted result per load state with plain labels and explicit units, through the reached state select', async () => {
    const fixture = contactUiFixture();
    const zero = editBeamSession(fixture.session, { kind: 'contact-value', index: 0, field: 'gap', source: '0' });
    const draft = beamDefinition(zero, fixture.source, []);
    if (!draft.ok) throw new Error(draft.diagnostic ?? 'Invalid contact fixture');
    const prepared = prepareBeamAnalysis(fixture.source, draft.definition);
    if (!prepared.ok || prepared.kind !== 'contact') throw new Error('Expected prepared contact input');
    const axial = 1 * 2 / (208e9 * 300e-6);
    const result = await contactResultFor(prepared.input, [
      { end: [0, 0, 0], state: 'closed', reactionN: 1, gapM: 0 },
      { end: [0, 0, axial], state: 'open', reactionN: 0, gapM: axial },
    ], fixture.member.endNodeId);
    useAppStore.setState({ ...fixture.state, beamSession: { ...zero, reviewed: fixture.source, status: 'complete', result } });
    // The panel renders the results component for exactly this result and the session's view choice.
    const views = panel().filter(row => row.type === BeamContactResults);
    expect(views).toHaveLength(1);
    expect(views[0].props).toHaveProperty('result', result);
    expect(views[0].props).toHaveProperty('view', requireBeamSession().contactView);
    let markup = html();
    expect(markup).toContain('data-testid="beam-contact-results"');
    expect(markup).toContain(escaped(t('beam.contactResultScope')));
    expect(markup).toContain('data-beam-contact-result="contact-1" data-state="closed"');
    expect(markup).toContain(escaped(t('beam.contactClosed')));
    expect(markup).toContain('data-quantity="force" data-unit="N" data-value="1"');
    expect(markup).toContain(escaped(t('beam.contactGapResult')));
    const state = one(elements(() => BeamContactResults({ result, view: requireBeamSession().contactView })),
      props => props['data-testid'] === 'beam-contact-state', 'load state select');
    if (state.onChange === undefined) throw new Error('Missing load state handler');
    state.onChange({ target: { value: '1' } });
    expect(requireBeamSession().contactView).toEqual({ state: 1 });
    expect(requireBeamSession().result).toBe(result);
    markup = html();
    expect(markup).toContain('data-beam-contact-result="contact-1" data-state="open"');
    expect(markup).toContain(escaped(t('beam.contactOpen')));
    expect(markup).toContain(`data-component="2" data-unit="m" data-value="${axial}"`);
    // The view converts metres to mm once for display (shared beam number formatting); data-value keeps metres.
    expect(markup).toContain(`data-value="${axial}">${beamDisplayNumber(axial * 1000)}<`);
  });
});
