import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, applyFilletWeld, createAssemblyDocument, createComponentFor, planFilletWeld, weldSegmentsOf,
  type AssemblyDocument, type FilletWeldRequest, type Placement, type Vec3,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { chooseAssemblyBuild } from '../shell/menus/assemblyToolActions.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { TEE_PLANE_BODIES } from './filletWeldBodies.testSupport.js';
import { isOccurrenceWeld } from './nestedWeldDraft.js';

beforeEach(resetTestStore);

const REVISIONS: ReadonlyMap<string, string> = new Map([['standing', 'rev-s'], ['base', 'rev-b']]);

function placement(position: Vec3): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation: [0, 0, 0, 1] };
}

function face(componentId: string, partRef: string, centroid: Vec3, normal: Vec3): FilletWeldRequest['first'] {
  return { componentId, sourceKey: `part:${partRef}@${REVISIONS.get(partRef) ?? ''}`, centroid, normal,
    face: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: centroid, axis: normal, radius: null } } };
}

/** 立板と底板の T 継手に断続ビード2本の溶接を足した文書(平らの溶接)。 */
function weldedTee(): AssemblyDocument {
  let document = createAssemblyDocument('溶接');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'standing' }, { placement: placement([0, 26, 10]) }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'base' }, { placement: placement([0, 0, 0]) }));
  const planned = planFilletWeld(document, {
    first: face('component-1', 'standing', [50, 8, 25], [0, 1, 0]), second: face('component-2', 'base', [50, 30, 10], [0, 0, 1]),
    edge: { midpoint: [50, 8, 0], direction: [1, 0, 0], length: 100,
      edge: { bodyFeatureId: 'extrude-1', index: 1, fingerprint: { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null } } },
    legOnSecond: 6, legOnFirst: 6, segments: [{ start: 0, length: 30 }, { start: 60, length: 40 }], materialId: 'steel',
  }, REVISIONS, TEE_PLANE_BODIES);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(document, planned.plan, REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

/** 同じ溶接のビードを、根の葉どうしの入れ子の溶接の結び付けとして記録した文書。 */
function occurrenceOwned(document: AssemblyDocument): AssemblyDocument {
  const beads = (weldSegmentsOf(document).get('weld-1') ?? []).map((bead) => bead.id);
  return { ...document, jointOccurrenceConnections: [{ kind: 'weld', firstPath: ['component-1'], secondPath: ['component-2'], componentIds: beads }] };
}

/** 開いた組立と、解いた時の入力を持たない表示(作り直しの途中・古い表示)。 */
function openWithoutSource(document: AssemblyDocument): AssemblyDocument {
  useAppStore.getState().openAssembly(document);
  const opened = useAppStore.getState().assembly;
  if (opened === null) throw new Error('no assembly');
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: opened,
    resolved: { parts: new Map(), placements: new Map(), partKeys: new Map(), errors: [] },
    bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
  return opened;
}

function selectFirstBead(): void {
  const assembly = useAppStore.getState().assembly;
  const bead = assembly === null ? undefined : weldSegmentsOf(assembly).get('weld-1')?.[0]?.id;
  if (bead === undefined) throw new Error('no bead');
  useAppStore.getState().setSelection([bead]);
}

describe('保存した入れ子の溶接を、今の溶接の窓で直す道', () => {
  it('結び付けの記録があるビードを選んで始めると、平らの予告ではなく入れ子の直しの予告になる', () => {
    const owned = occurrenceOwned(weldedTee());
    expect(isOccurrenceWeld(owned, 'weld-1')).toBe(true);
    expect(isOccurrenceWeld(weldedTee(), 'weld-1')).toBe(false);
    openWithoutSource(owned);
    selectFirstBead();
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldDraft).toMatchObject({ weldId: 'weld-1', lengthsSource: '30, 40', materialId: 'steel' });
    // 表示に解いた時の入力が無いので、直しの予告は古い(命令を呼ばない)。平らの計画へは落とさない。
    expect(useAppStore.getState().assemblyNestedWeldPreview).toEqual({ kind: 'stale' });
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'stale' } });
  });

  it('欄を直すと直しの予告を作り直し、欄が数でない時は欄の理由を出す', () => {
    const before = openWithoutSource(occurrenceOwned(weldedTee()));
    selectFirstBead();
    chooseAssemblyBuild('filletWeld');
    useAppStore.getState().updateFilletWeldDraft({ legOnSecondSource: 'x' });
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'value', field: 'legOnSecond' } });
    expect(useAppStore.getState().assemblyNestedWeldPreview).toBeNull();
    useAppStore.getState().updateFilletWeldDraft({ legOnSecondSource: '5' });
    expect(useAppStore.getState().assemblyNestedWeldPreview).toEqual({ kind: 'stale' });
    useAppStore.getState().updateFilletWeldDraft({ startSource: 'x' });
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'value', field: 'start' } });
    useAppStore.getState().updateFilletWeldDraft({ startSource: '0', lengthsSource: 'x' });
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'value', field: 'lengths' } });
    useAppStore.getState().updateFilletWeldDraft({ lengthsSource: '30, 40', gapsSource: 'x' });
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'value', field: 'gaps' } });
    useAppStore.getState().updateFilletWeldDraft({ gapsSource: '' });
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'gapCount' } });
    expect(useAppStore.getState().commitFilletWeld()).toBe(false);
    expect(useAppStore.getState().assembly).toBe(before);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('窓の確定(commitFilletWeld)は入れ子の直しへ渡り、古い表示では文書も Undo も変えない。取消でも変えない', () => {
    const before = openWithoutSource(occurrenceOwned(weldedTee()));
    selectFirstBead();
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().commitFilletWeld()).toBe(false);
    expect([useAppStore.getState().assembly, useAppStore.getState().canUndo]).toEqual([before, false]);
    useAppStore.getState().cancelFilletWeld();
    expect([useAppStore.getState().assembly, useAppStore.getState().assemblyNestedWeldPreview]).toEqual([before, null]);
  });

  it('結び付けの無い平らの溶接は、今までどおり平らの直しの予告のまま', () => {
    openWithoutSource(weldedTee());
    selectFirstBead();
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyNestedWeldPreview).toBeNull();
    expect(useAppStore.getState().assemblyFilletWeldDraft?.weldId).toBe('weld-1');
  });
});
