import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { BeamBucklingSupports } from './BeamBucklingSupports.js';
import { bucklingUiFixture } from './beamBuckling.testSupport.js';
import { requireBeamSession } from './beam.testSupport.js';

interface Control {
  readonly children?: ReactNode;
  readonly 'data-beam-restraint'?: number;
  readonly checked?: boolean;
  readonly onChange?: (event: { readonly target: { readonly checked: boolean } }) => void;
}
function controls(end: 'start' | 'end'): Control[] {
  const rows: Control[] = [];
  function walk(node: ReactNode): void {
    Children.forEach(node, child => {
      if (!isValidElement<Control>(child)) return;
      if (child.props['data-beam-restraint'] !== undefined) rows.push(child.props);
      walk(child.props.children);
    });
  }
  function Probe(): null {
    walk(BeamBucklingSupports({ member: requireBeamSession().members[0], end }));
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return rows;
}
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('six global support controls use the actual store edit action', () => {
  it.each([0, 1, 2, 3, 4, 5] as const)('edits only endpoint component %i and cancels the reviewed run', axis => {
    const fixture = bucklingUiFixture(), runner = { run: vi.fn(), cancel: vi.fn() };
    useAppStore.setState({ ...fixture.state, beamRunner: runner,
      beamSession: { ...fixture.session, reviewed: fixture.source } });
    const before = requireBeamSession(), control = controls('end').find(row => row['data-beam-restraint'] === axis);
    expect(controls('end')).toHaveLength(6);
    expect(control?.checked).toBe(false);
    if (control?.onChange === undefined) throw new Error('Missing actual support checkbox handler');
    control.onChange({ target: { checked: true } });
    const after = requireBeamSession();
    expect(after.members[0].endRestraints).toEqual([0, 1, 2, 3, 4, 5].map(index => index === axis));
    expect(after.members[0].startRestraints).toBe(before.members[0].startRestraints);
    expect(after.members[0].fixedStart).toBe(before.members[0].fixedStart);
    expect(after.members[0].values).toBe(before.members[0].values);
    expect(after.reviewed).toBeNull();
    expect(after.result).toBeNull();
    expect(after.revision).toBe(before.revision + 1);
    expect(runner.cancel).toHaveBeenCalledOnce();
    expect(controls('end').find(row => row['data-beam-restraint'] === axis)?.checked).toBe(true);
    expect(useAppStore.getState().assembly).toBe(fixture.state.assembly);
  });
});
