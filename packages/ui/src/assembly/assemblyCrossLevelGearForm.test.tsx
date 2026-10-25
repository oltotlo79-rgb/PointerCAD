import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  createAssemblyDocument, EMPTY_PART_LIBRARY, resolveAssembly, type AssemblyComponent, type AssemblyDocument, type ComponentSource,
  type CrossLevelGearCouplingDefinition, type Joint, type JointOccurrenceInputs, type PartLibrary,
} from '@pointercad/model';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { AssemblyPropertyPanel } from './AssemblyPropertyPanel.js';
import { crossLevelGearRefusal, crossLevelGearTargets } from './AssemblyCrossLevelGearForm.js';

/*
 * The cross-level gear form's visible contract. Hand-written tree: the parent places `mid` as A and B (repeated);
 * mid places `leaf` as M and owns the revolute `mid-turn`; leaf owns the revolute `child-turn` and the slider
 * `child-slide`. The expected targets and labels below are written from this tree.
 */
const ZERO = expressionValueFromNumber(0);
const PART: ComponentSource = { kind: 'part', partRef: 'part-ref' };
const sub = (assemblyRef: string): ComponentSource => ({ kind: 'subAssembly', assemblyRef });
function component(id: string, source: ComponentSource = PART): AssemblyComponent {
  return { id, name: id, source, placement: { position: [ZERO, ZERO, ZERO], rotation: [0, 0, 0, 1] },
    fixed: false, visible: true, suppressed: false };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: null, suppressed: false };
}
const expression = (source: string, value: number): ExpressionValue => ({ ...expressionValueFromNumber(value), source });
const leaf: AssemblyDocument = { ...createAssemblyDocument('leaf'), components: [component('base'), component('arm')],
  joints: [joint('child-turn', 'revolute', 'arm', 'base'), joint('child-slide', 'slider', 'arm', 'base')] };
const mid: AssemblyDocument = { ...createAssemblyDocument('mid'), components: [component('mid-base'), component('M', sub('leaf'))],
  joints: [joint('mid-turn', 'revolute', 'M', 'mid-base')] };
const library: PartLibrary = { ...EMPTY_PART_LIBRARY, assemblies: new Map([['leaf', leaf], ['mid', mid]]) };
const saved: CrossLevelGearCouplingDefinition = { id: 'cross-gear-1', kind: 'crossLevelGear', parentJointId: 'drive',
  childPath: ['B', 'M'], childJointId: 'child-turn', ratio: expression('-2', -2), phaseDeg: expression('0', 0), suppressed: false };

function open(couplings?: readonly CrossLevelGearCouplingDefinition[]): AssemblyDocument {
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'),
    components: [component('ground'), component('A', sub('mid')), component('B', sub('mid'))],
    joints: [joint('drive', 'revolute', 'A', 'ground')], ...(couplings === undefined ? {} : { crossLevelGearCouplings: couplings }) };
  useAppStore.getState().openAssembly(document, library);
  const subAssemblies = library.assemblies ?? new Map<string, AssemblyDocument>();
  const source: JointOccurrenceInputs = { document, library, subAssemblies };
  useAppStore.setState({ selection: ['drive'], assemblyView: { sourceDocument: document, source,
    resolved: resolveAssembly(document, { library, subAssemblies }), bodies: new Map(), appearances: new Map(), diagnosis: null,
    mateTargetErrors: new Map(), mateTargets: new Map(), jointFrames: new Map() } });
  return document;
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('cross-level gear form', () => {
  it('lists every revolute joint inside every placement by typed path, repeated placements separately', () => {
    const document = open();
    expect(crossLevelGearTargets(document, library).map(target => [target.path, target.jointId, target.label])).toEqual([
      [['A'], 'mid-turn', 'A : mid-turn'],
      [['A', 'M'], 'child-turn', 'A / M : child-turn'],
      [['B'], 'mid-turn', 'B : mid-turn'],
      [['B', 'M'], 'child-turn', 'B / M : child-turn'],
    ]);
  });

  it('offers creation on the selected parent revolute joint, and says that cross-level cams are not available yet', () => {
    open();
    const html = renderToStaticMarkup(<AssemblyPropertyPanel />);
    expect(html).toContain(`aria-label="${t('assembly.crossGear.title')}"`);
    expect(html).toContain('>B / M : child-turn</option>');
    expect(html).toContain(t('assembly.crossGear.create'));
    expect(html).toContain(t('assembly.crossGear.camPending'));
    // A new definition has no drive fields yet.
    expect(html).not.toContain(t('assembly.crossGear.parentAngle').replace('{joint}', 'drive'));
  });

  it('shows a saved definition with update, remove and both drive fields named after their joints', () => {
    open([saved]);
    const html = renderToStaticMarkup(<AssemblyPropertyPanel />);
    expect(html).toContain(t('assembly.crossGear.update'));
    expect(html).toContain(t('assembly.crossGear.remove'));
    expect(html).toContain(`aria-label="${t('assembly.crossGear.parentAngle').replace('{joint}', 'drive')}"`);
    expect(html).toContain(`aria-label="${t('assembly.crossGear.childAngle').replace('{joint}', 'B / M : child-turn')}"`);
    expect(html).toContain(t('assembly.crossGear.driveHint'));
  });

  it('names the reason of a refusal, with a general reason for the rest', () => {
    expect(crossLevelGearRefusal('child-at-limit')).toContain(t('assembly.crossGear.reason.childLimit'));
    expect(crossLevelGearRefusal('coupled-parent-joint')).toContain(t('assembly.crossGear.reason.coupledParent'));
    expect(crossLevelGearRefusal('missing-child-joint')).toContain(t('assembly.crossGear.reason.invalid'));
  });
});
