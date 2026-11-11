import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { BeamPanel } from './BeamPanel.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { beamDefinition, restoreBeamSession } from './beamSession.js';

interface KeyInput {
  readonly key: string;
  readonly nativeEvent: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}
interface ElementProps {
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
  readonly onKeyDown?: (event: KeyInput) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
  readonly onClick?: () => void;
  readonly type?: string;
  readonly disabled?: boolean;
  readonly onChange?: (event: { readonly target: { readonly value: string } }) => void;
}
function panel(): ElementProps[] {
  const elements: ElementProps[] = [];
  function walk(node: ReactNode): void {
    Children.forEach(node, child => {
      if (!isValidElement<ElementProps>(child)) return;
      elements.push(child.props);
      walk(child.props.children);
    });
  }
  function Probe(): null {
    walk(BeamPanel({ session: requireBeamSession() }));
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return elements;
}
function install() {
  const fixture = beamUiFixture();
  const runner = { run: vi.fn(), cancel: vi.fn() };
  useAppStore.setState({ ...fixture.state, beamRunner: runner,
    beamSession: { ...fixture.session, reviewed: fixture.source } });
  return { fixture, runner };
}
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('BeamPanel real React handler and store (node, not DOM)', () => {
  it('selects buckling from the actual form, exposes explicit supports and routes mesh/mode edits through session invalidation', () => {
    install();
    const selected = panel().find(element => element['data-testid'] === 'beam-analysis-type');
    if (selected?.onChange === undefined) throw new Error('Missing analysis selector');
    selected.onChange({ target: { value: 'buckling' } });
    expect(requireBeamSession().analysisType).toBe('buckling');
    expect(requireBeamSession().reviewed).toBeNull();
    const html = renderToStaticMarkup(<BeamPanel session={requireBeamSession()} />);
    expect(html).toContain('data-beam-buckling-supports="start"');
    expect(html).toContain('data-beam-buckling-supports="end"');
    expect(html.match(/data-beam-restraint=/gu)).toHaveLength(12);
    expect(html).not.toContain('data-beam-fixed=');
    const mode = panel().find(element => element['data-testid'] === 'beam-mode-count');
    if (mode?.onChange === undefined) throw new Error('Missing buckling mode selector');
    mode.onChange({ target: { value: '2' } });
    expect(requireBeamSession().modeCount).toBe(2);
    const mesh = panel().find(element => element['data-testid'] === 'beam-segments');
    if (mesh?.onChange === undefined) throw new Error('Missing buckling mesh selector');
    mesh.onChange({ target: { value: '12' } });
    expect(requireBeamSession().segmentsPerMember).toBe(12);
    expect(requireBeamSession().result).toBeNull();
    expect(requireBeamSession().reviewed).toBeNull();
  });

  it.each([
    ['Enter', 13, true], ['Escape', 27, true], ['Enter', 229, false],
    ['Escape', 229, false], ['Process', 0, false],
  ] as const)('preserves review, document and history during IME %s/%i/%s', (key, keyCode, isComposing) => {
    const { runner } = install();
    const before = useAppStore.getState();
    const preventDefault = vi.fn(), stopPropagation = vi.fn();
    panel()[0].onKeyDown?.({ key, nativeEvent: { key, keyCode, isComposing }, preventDefault, stopPropagation });
    const after = useAppStore.getState();
    expect(after.beamSession).toBe(before.beamSession);
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(runner.run).not.toHaveBeenCalled();
    expect(runner.cancel).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it('closes only the session on ordinary Escape and cancels its runner once', () => {
    const { runner } = install();
    const before = useAppStore.getState();
    const preventDefault = vi.fn(), stopPropagation = vi.fn();
    panel()[0].onKeyDown?.({ key: 'Escape', nativeEvent: { key: 'Escape', keyCode: 27, isComposing: false },
      preventDefault, stopPropagation });
    expect(useAppStore.getState().beamSession).toBeNull();
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(runner.cancel).toHaveBeenCalledOnce();
    expect(runner.run).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('never starts on an implicit form submit; explicit Run starts once and edits invalidate it', () => {
    const { runner } = install();
    const tree = panel(), submit = tree[0].onSubmit;
    if (submit === undefined) throw new Error('Missing form handler');
    const preventDefault = vi.fn();
    submit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(runner.run).not.toHaveBeenCalled();
    const run = tree.find(element => element['data-testid'] === 'beam-run');
    expect(run?.type).toBe('button');
    expect(run?.disabled).toBe(false);
    if (run?.onClick === undefined) throw new Error('Missing explicit run');
    run.onClick();
    expect(runner.run).toHaveBeenCalledOnce();
    const revision = requireBeamSession().revision;
    useAppStore.getState().editBeam({ kind: 'analysis-type', value: 'modal' });
    expect(requireBeamSession().reviewed).toBeNull();
    expect(requireBeamSession().result).toBeNull();
    expect(requireBeamSession().revision).toBe(revision + 1);
    expect(runner.cancel).toHaveBeenCalledOnce();
    useAppStore.getState().runBeam();
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it('saves versioned modal inputs but restores no review, frame confirmation or numerical result', () => {
    const { fixture } = install();
    const session = { ...fixture.session, analysisType: 'modal' as const, modeCount: 3, segmentsPerMember: 12,
      members: fixture.session.members.map(member => ({ ...member,
        values: { ...member.values, endFx: '0' } })) };
    const checked = beamDefinition(session, fixture.source, []);
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error(checked.diagnostic ?? 'Invalid modal fixture');
    if (checked.definition.schema !== 'pointercad-standard-beam/2') throw new Error('Expected modal inputs');
    expect(checked.definition.schema).toBe('pointercad-standard-beam/2');
    expect(checked.definition.modal).toEqual({ modeCount: 3, segmentsPerMember: 12 });
    expect(checked.definition.loads).toEqual([]);
    const restored = restoreBeamSession(session.ownerId, checked.definition, [fixture.occurrence]);
    expect(restored.analysisType).toBe('modal');
    expect(restored.modeCount).toBe(3);
    expect(restored.segmentsPerMember).toBe(12);
    expect(restored.reviewed).toBeNull();
    expect(restored.result).toBeNull();
    expect(restored.members[0].confirmed).toBe(false);
    expect(beamDefinition(restored, fixture.source, []).ok).toBe(false);
  });
});
