import { addComponent, createAssemblyDocument, createComponentFor, type AssemblyDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { planeBody } from '../assembly/filletWeldBodies.testSupport.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { chooseAssemblyBuild } from '../shell/menus/assemblyToolActions.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachAssemblyInteraction, type AssemblyMateInputObservation } from './attachAssemblyInteraction.js';
import type { AssemblyMateFaceHit } from './createAssemblyLayer.js';

beforeEach(resetTestStore);

const PLATE = planeBody([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], [0, 0, 1]);

/** 同じ子の組を `組,A` と `B` に置いた根を開き、解いた時の入力を持たない表示(古い表示)を入れる。 */
function openNested(): AssemblyDocument {
  let document = createAssemblyDocument('根');
  for (const id of ['組,A', 'B']) {
    document = addComponent(document, { ...createComponentFor(document, { kind: 'subAssembly', assemblyRef: 'child' }, {}), id });
  }
  useAppStore.getState().openAssembly(document);
  const opened = useAppStore.getState().assembly;
  if (opened === null) throw new Error('no assembly');
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: opened,
    resolved: { parts: new Map(), placements: new Map(), partKeys: new Map(), errors: [] },
    bodies: new Map([['plate-part', [PLATE]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
  return opened;
}

/** 実際の listener を EventTarget で動かす(描画・WebGL・ブラウザは起動しない)。 */
function attach(hit: AssemblyMateFaceHit | null) {
  const observed: AssemblyMateInputObservation[] = [];
  const canvas = Object.assign(new EventTarget(), { focus: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0 }) });
  const scene = { pickAssemblyFace: vi.fn(() => hit), pickComponent: vi.fn(() => null),
    worldToScreen: (point: readonly [number, number, number]): readonly [number, number] => [point[0], point[1]] };
  const interaction = attachAssemblyInteraction(canvas, scene, {
    viewDirection: () => [0, 0, 1], observeMateInput: (observation) => observed.push({ ...observation }) });
  const press = () => canvas.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }),
    { button: 0, buttons: 1, altKey: false, clientX: 5, clientY: 5, pointerId: 1, shiftKey: false }));
  return { observed, scene, interaction, press, canvas };
}

const NESTED_HIT: AssemblyMateFaceHit = { componentId: '組,A/plate', partKey: 'plate-part', bodyFeatureId: 'extrude-1', faceIndex: 0,
  occurrencePath: ['組,A', 'plate'] };

describe('溶接の打ちかけの押下で入れ子の葉の面を選ぶ', () => {
  it('解いた時の入力の無い表示では、押した入れ子の面を stale-view で断り、下書き・文書・Undo を変えない', () => {
    const before = openNested();
    chooseAssemblyBuild('filletWeld');
    const f = attach(NESTED_HIT);
    try {
      f.press();
      expect(f.scene.pickAssemblyFace).toHaveBeenCalled();
      const last = f.observed.at(-1);
      expect([last?.addAccepted, last?.jointOccurrenceIssue]).toEqual([false, 'stale-view']);
      expect(useAppStore.getState().assemblyNestedWeldDraft).toBeNull();
      expect([useAppStore.getState().assembly, useAppStore.getState().canUndo]).toEqual([before, false]);
    } finally { f.interaction.detach(); }
  });

  it('溶接の打ちかけが無い時は、同じ入れ子の当たりでも経路の選択へ流さない(部品を選ぶ今の動き)', () => {
    openNested();
    const f = attach(NESTED_HIT);
    try {
      f.press();
      expect(f.observed.every((observation) => observation.jointOccurrenceIssue === undefined)).toBe(true);
      expect(useAppStore.getState().assemblyNestedWeldDraft).toBeNull();
    } finally { f.interaction.detach(); }
  });
});

it('hovering a nested weld face highlights its displayed occurrence without creating a mate or undo entry', () => {
  const before = openNested();
  chooseAssemblyBuild('filletWeld');
  const f = attach(NESTED_HIT);
  try {
    f.canvas.dispatchEvent(Object.assign(new Event('pointermove'),
      { buttons: 0, altKey: false, clientX: 5, clientY: 5, pointerId: 1 }));
    const element = subShapeElementId('extrude-1', 'face', 0);
    expect(useAppStore.getState().hoveredElementId)
      .toBe(`assembly-target:${encodeURIComponent('組,A/plate')}/${encodeURIComponent(element)}`);
    expect(useAppStore.getState().assembly).toBe(before);
    expect(useAppStore.getState().assemblyMateDraft).toBeNull();
    expect(useAppStore.getState().canUndo).toBe(false);
  } finally { f.interaction.detach(); }
});
