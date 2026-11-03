import { createAssemblyDocument, createDrawingDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import { restoreBoltPreloadDraft } from '../../beam/boltPreloadDraft.js';
import { savedBoltFixture } from '@pointercad/model/testing/analysis-fixtures';
import { ANALYSIS_MENU_ITEMS, analysisMenuItemsFor } from './analysisMenuItems.js';
import { analysisToolbarReadiness, openAnalysisTool, runAnalysisTool } from './analysisToolbarActions.js';

// The shared document reset does not close these two independent analysis sessions.
function resetAnalysisTestStore(): void {
  const current = useAppStore.getState();
  if (current.solidAnalysisSession !== null) current.closeSolidAnalysis();
  if (current.solidPlasticSession !== null) current.closeSolidPlastic();
  if (current.solidFiniteSession !== null) current.closeSolidFinite();
  if (current.shellAnalysisSession !== null) current.closeShellAnalysis();
  useAppStore.setState({ solidPlasticRunner: null, solidFiniteRunner: null });
  resetTestStore();
}
beforeEach(() => {
  resetAnalysisTestStore();
  expect(useAppStore.getState().solidAnalysisSession).toBeNull();
  expect(useAppStore.getState().solidPlasticSession).toBeNull();
  expect(useAppStore.getState().solidFiniteSession).toBeNull();
  expect(useAppStore.getState().shellAnalysisSession).toBeNull();
});
afterEach(resetAnalysisTestStore);
const state = () => useAppStore.getState();
const ready = { ready: true, reasonKey: null };

// Independent expectations name the actual sessions, not the descriptor's isOpen implementation.
const entries = [
  { id: 'beam', field: 'beamSession', kinds: ['assembly'] },
  { id: 'plasticBar', field: 'plasticBarSession', kinds: ['part', 'assembly'] },
  { id: 'fatigue', field: 'fatigueSession', kinds: ['part', 'assembly'] },
  { id: 'fatigueStrain', field: 'fatigueStrainSession', kinds: ['part', 'assembly'] },
  { id: 'fatigueLocalCycle', field: 'fatigueLocalCycleSession', kinds: ['part', 'assembly'] },
  { id: 'solidAnalysis', field: 'solidAnalysisSession', kinds: ['part'] },
  { id: 'solidPlastic', field: 'solidPlasticSession', kinds: ['part'] },
  { id: 'solidFinite', field: 'solidFiniteSession', kinds: ['part'] },
  { id: 'shellAnalysis', field: 'shellAnalysisSession', kinds: ['part'] },
] as const;

it('exposes nine unique entries: eight for a part, five for an assembly, none for a drawing', () => {
  expect(ANALYSIS_MENU_ITEMS.map(item => item.id)).toEqual(entries.map(item => item.id));
  expect(analysisMenuItemsFor('part').map(item => item.id)).toEqual([
    'plasticBar', 'fatigue', 'fatigueStrain', 'fatigueLocalCycle', 'solidAnalysis', 'solidPlastic', 'solidFinite',
    'shellAnalysis',
  ]);
  expect(analysisMenuItemsFor('assembly').map(item => item.id)).toEqual([
    'beam', 'plasticBar', 'fatigue', 'fatigueStrain', 'fatigueLocalCycle',
  ]);
  expect(analysisMenuItemsFor('drawing')).toEqual([]);
});

describe('opens the existing panel through public store actions', () => {
  for (const entry of entries) {
    for (const kind of entry.kinds) {
      it(`${kind}: ${entry.id}, including a closed parent and a repeated selection`, () => {
        if (kind === 'assembly') state().openAssembly(createAssemblyDocument('Analysis assembly'));
        const before = state();
        expect(before.strengthSession).toBeNull();
        expect(analysisToolbarReadiness(before, entry.id)).toEqual(ready);
        expect(runAnalysisTool(entry.id)).toEqual(ready);
        const opened = state(), session = opened[entry.field];
        expect(opened.strengthSession).not.toBeNull();
        expect(session).not.toBeNull();
        expect(openAnalysisTool(opened)).toBe(entry.id);
        expect(opened.document).toBe(before.document);
        expect(opened.assembly).toBe(before.assembly);
        expect(opened.canUndo).toBe(before.canUndo);
        expect(runAnalysisTool(entry.id)).toEqual(ready);
        expect(state()).toBe(opened);
        state().closeStrength();
        expect(state().strengthSession).toBeNull();
        expect(state()[entry.field]).toBe(session);
        expect(runAnalysisTool(entry.id)).toEqual(ready);
        expect(state().strengthSession).not.toBeNull();
        expect(state()[entry.field]).toBe(session);
      });
    }
  }
});

it('refuses every analysis in a drawing without creating a parent or modifying the document', () => {
  state().openDrawing(createDrawingDocument('Drawing', {
    sourceRef: 'part', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '',
  }));
  const before = state();
  for (const entry of entries) {
    expect(runAnalysisTool(entry.id)).toEqual({ ready: false, reasonKey: 'command.unavailable.document' });
    expect(state()).toBe(before);
  }
});

it('refuses part-only and assembly-only entries before opening the parent', () => {
  const part = state();
  expect(runAnalysisTool('beam')).toEqual({ ready: false, reasonKey: 'command.unavailable.document' });
  expect(state()).toBe(part);
  state().openAssembly(createAssemblyDocument('Assembly'));
  const assembly = state();
  for (const id of ['solidAnalysis', 'solidPlastic', 'solidFinite', 'shellAnalysis'] as const) {
    expect(runAnalysisTool(id)).toEqual({ ready: false, reasonKey: 'command.unavailable.document' });
    expect(state()).toBe(assembly);
  }
});

it('retains edited, unsaved input when another entry is selected and when the parent is reopened', () => {
  expect(runAnalysisTool('plasticBar')).toEqual(ready);
  state().editPlasticBar({ kind: 'value', field: 'length', source: '147mm' });
  const before = state(), edited = before.plasticBarSession;
  expect(edited?.draft.values.length).toBe('147mm');
  expect(runAnalysisTool('fatigue')).toEqual({ ready: false, reasonKey: 'toolbar.analysis.closeCurrent' });
  expect(state()).toBe(before);
  expect(runAnalysisTool('plasticBar')).toEqual(ready);
  expect(state()).toBe(before);
  state().closeStrength();
  const hidden = state();
  expect(runAnalysisTool('solidAnalysis')).toEqual({ ready: false, reasonKey: 'toolbar.analysis.closeCurrent' });
  expect(state()).toBe(hidden);
  expect(runAnalysisTool('plasticBar')).toEqual(ready);
  expect(state().plasticBarSession).toBe(edited);
  state().closePlasticBar();
  expect(runAnalysisTool('fatigue')).toEqual(ready);
  expect(state().fatigueSession).not.toBeNull();
});

it('does not choose an arbitrary panel when existing actions have opened more than one session', () => {
  state().toggleStrength(); state().openPlasticBar(); state().openFatigue();
  const before = state();
  expect(before.plasticBarSession).not.toBeNull(); expect(before.fatigueSession).not.toBeNull();
  expect(openAnalysisTool(before)).toBe('blocked');
  for (const id of ['plasticBar', 'fatigue', 'solidAnalysis'] as const) {
    expect(runAnalysisTool(id)).toEqual({ ready: false, reasonKey: 'toolbar.analysis.closeCurrent' });
    expect(state()).toBe(before);
  }
});

it('refuses an existing bolt preload input without treating it as an ordinary beam session', () => {
  const draft = restoreBoltPreloadDraft(savedBoltFixture().saved);
  const current = { ...state(), boltPreloadDraft: draft };
  const before = JSON.stringify(draft);
  expect(openAnalysisTool(current)).toBe('blocked');
  for (const item of analysisMenuItemsFor('part')) {
    expect(analysisToolbarReadiness(current, item.id)).toEqual({ ready: false, reasonKey: 'toolbar.analysis.closeCurrent' });
  }
  expect(current.boltPreloadDraft).toBe(draft);
  expect(JSON.stringify(draft)).toBe(before);
  expect(state().strengthSession).toBeNull();
});

it('explicit small/finite switching cancels the previous run and keeps the two documents unchanged', () => {
  const smallCancel = vi.fn(), finiteCancel = vi.fn();
  useAppStore.setState({ solidPlasticRunner: { run: vi.fn(), cancel: smallCancel, captureFaces: vi.fn(), validate: vi.fn() },
    solidFiniteRunner: { run: vi.fn(), cancel: finiteCancel, captureFaces: vi.fn(), validate: vi.fn() } });
  expect(runAnalysisTool('solidPlastic')).toEqual(ready);
  const document = state().document, history = state().undoStack;
  smallCancel.mockClear();
  expect(runAnalysisTool('solidFinite')).toEqual(ready);
  expect(smallCancel).toHaveBeenCalledTimes(1);
  expect(state().solidPlasticSession).toBeNull(); expect(state().solidFiniteSession).not.toBeNull();
  finiteCancel.mockClear();
  expect(runAnalysisTool('solidPlastic')).toEqual(ready);
  expect(finiteCancel).toHaveBeenCalledTimes(1);
  expect(state().solidFiniteSession).toBeNull(); expect(state().solidPlasticSession).not.toBeNull();
  expect(state().document).toBe(document); expect(state().undoStack).toBe(history);
});

it('does not supersede a newer tool opened synchronously by cancellation', () => {
  expect(runAnalysisTool('solidPlastic')).toEqual(ready);
  useAppStore.setState({ solidPlasticRunner: { run: vi.fn(), validate: vi.fn(), captureFaces: vi.fn(),
    cancel: () => state().openPlasticBar() } });
  expect(runAnalysisTool('solidFinite')).toEqual({ ready: false, reasonKey: 'toolbar.analysis.closeCurrent' });
  expect(state().plasticBarSession).not.toBeNull(); expect(state().solidFiniteSession).toBeNull();
});
