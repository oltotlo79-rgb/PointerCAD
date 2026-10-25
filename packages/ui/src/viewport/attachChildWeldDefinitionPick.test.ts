import {
  buildStandardPartFromSource, EMPTY_PART_LIBRARY, resolveAssembly, type AssemblyComponent, type AssemblyDocument, type PartLibrary,
} from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { childOwnedWeldFixture } from '../../../model/src/analysis/cadWeldLayerChildOwned.testSupport.js';
import { testComponent, testPlacement } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { beamUiFixture } from '../beam/beam.testSupport.js';
import { chooseAssemblyBuild } from '../shell/menus/assemblyToolActions.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachAssemblyInteraction, type AssemblyMateInputObservation } from './attachAssemblyInteraction.js';
import type { AssemblyMateFaceHit } from './createAssemblyLayer.js';

beforeEach(resetTestStore);

/** The repeated welded child (P1, P2) plus an unrelated root sibling S, with the completed CAD view the editor reads. */
function open(mutate: (document: AssemblyDocument) => AssemblyDocument = (document) => document) {
  const f = childOwnedWeldFixture();
  const sibling: AssemblyComponent = { ...testComponent('S', '30'), placement: testPlacement([-300, 0, 0]) };
  const document = mutate({ ...f.document, components: [...f.document.components, sibling] });
  const library: PartLibrary = { ...EMPTY_PART_LIBRARY, assemblies: f.subAssemblies };
  const resolved = resolveAssembly(document, { library, subAssemblies: f.subAssemblies, standardPart: buildStandardPartFromSource });
  const ui = beamUiFixture();
  if (ui.state.assemblyView === null) throw new Error('UI fixture view missing');
  useAppStore.getState().openAssembly(document, library);
  useAppStore.setState({ isComputing: false,
    assemblyView: { ...ui.state.assemblyView, sourceDocument: document, resolved, bodies: f.context.bodies } });
  const bead = f.beads[0]?.id;
  if (bead === undefined) throw new Error('fixture bead missing');
  return { f, document, bead };
}

/** The real listeners on an EventTarget (no rendering, WebGL or browser), same pattern as attachNestedWeldInteraction.test. */
function attach(hit: AssemblyMateFaceHit | null) {
  const observed: AssemblyMateInputObservation[] = [];
  const canvas = Object.assign(new EventTarget(), { focus: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0 }) });
  const scene = { pickAssemblyFace: vi.fn(() => hit), pickComponent: vi.fn(() => null),
    worldToScreen: (point: readonly [number, number, number]): readonly [number, number] => [point[0], point[1]] };
  const interaction = attachAssemblyInteraction(canvas, scene, {
    viewDirection: () => [0, 0, 1], observeMateInput: (observation) => observed.push({ ...observation }) });
  const press = (altKey = false) => canvas.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }),
    { button: 0, buttons: 1, altKey, clientX: 5, clientY: 5, pointerId: 1, shiftKey: false }));
  return { observed, scene, interaction, press };
}

const beadHit = (occurrence: 'P1' | 'P2', bead: string): AssemblyMateFaceHit => ({ componentId: `${occurrence}/${bead}`,
  partKey: 'bead-part', bodyFeatureId: 'bead-body', faceIndex: 0, occurrencePath: [occurrence, bead] });

describe('W1: a primary click on a child-definition bead face while the weld tool is idle', () => {
  it('starts the shared-definition edit on the exact occurrence path without committing', () => {
    const { document, bead } = open();
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldDraft?.picks).toHaveLength(0);
    const p = attach(beadHit('P1', bead));
    try {
      p.press();
      const state = useAppStore.getState();
      expect(state.assemblyChildWeldEdit?.path).toStrictEqual(['P1', bead]);
      expect(state.assemblyChildWeldEdit?.affectedPlacements).toBe(2);
      expect(state.assemblyFilletWeldDraft?.weldId).toBe('weld-1');
      expect(p.observed.at(-1)?.addAccepted).toBe(true);
      // Selection only opens the edit: nothing is committed before the explicit confirmation.
      expect([state.assembly, state.canUndo, state.assemblyUndoStack?.past.length]).toEqual([document, false, 0]);
    } finally { p.interaction.detach(); }
  });

  it('does not retarget an edit already in progress when another occurrence bead is clicked', () => {
    const { bead } = open();
    chooseAssemblyBuild('filletWeld');
    const first = attach(beadHit('P1', bead));
    try { first.press(); } finally { first.interaction.detach(); }
    const second = attach(beadHit('P2', bead));
    try {
      second.press();
      expect(useAppStore.getState().assemblyChildWeldEdit?.path).toStrictEqual(['P1', bead]);
    } finally { second.interaction.detach(); }
  });

  it('leaves the camera modifier alone: Alt+primary never starts the edit or reaches the pick', () => {
    const { bead } = open();
    chooseAssemblyBuild('filletWeld');
    const p = attach(beadHit('P1', bead));
    try {
      p.press(true);
      expect(p.observed.at(-1)?.inputGate).toBe('button-or-alt');
      expect(p.scene.pickAssemblyFace).not.toHaveBeenCalled();
      expect(useAppStore.getState().assemblyChildWeldEdit).toBeNull();
    } finally { p.interaction.detach(); }
  });

  it('keeps ordinary routing without the weld tool and for a root face', () => {
    const { bead } = open();
    const none = attach(beadHit('P1', bead));
    try {
      none.press();
      expect(useAppStore.getState().assemblyChildWeldEdit).toBeNull();
      expect(useAppStore.getState().assemblyFilletWeldDraft).toBeNull();
    } finally { none.interaction.detach(); }
    chooseAssemblyBuild('filletWeld');
    const root = attach({ componentId: 'S', partKey: 'bar-part', bodyFeatureId: 'bar-body', faceIndex: 0, occurrencePath: ['S'] });
    try {
      root.press();
      expect(useAppStore.getState().assemblyChildWeldEdit).toBeNull();
      expect(useAppStore.getState().assemblyFilletWeldDraft?.weldId).toBeNull();
    } finally { root.interaction.detach(); }
  });

  it('refuses a suppressed occurrence and a hit whose path is not the displayed occurrence, before any mutation', () => {
    const { document, bead } = open((current) => ({ ...current, components: current.components.map((row) =>
      row.id === 'P1' ? { ...row, suppressed: true } : row) }));
    chooseAssemblyBuild('filletWeld');
    const suppressed = attach(beadHit('P1', bead));
    try { suppressed.press(); } finally { suppressed.interaction.detach(); }
    const mismatched = attach({ ...beadHit('P2', bead), occurrencePath: ['P1', bead] });
    try { mismatched.press(); } finally { mismatched.interaction.detach(); }
    const state = useAppStore.getState();
    expect(state.assemblyChildWeldEdit).toBeNull();
    expect([state.assembly, state.canUndo]).toEqual([document, false]);
  });
});
