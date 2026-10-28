import ReactHooks, * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDrawingBundle, readPcadaFile, readPcadFile, writeDrawingBundle, writePcadaFile, writePcadFile } from '@pointercad/io';
import { absoluteCoordinate } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { CameraControlSettingsForm } from './CameraControlSettingsForm.js';
import { DEFAULT_CAMERA_CONTROLS, type CameraControlSettings } from './cameraControlSettings.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyCameraSettings } from './cameraSettingsApply.js';
import { CUSTOM_CAMERA, documentFixtures, EXPECTED_PRESETS, SAVED_AT, settingsStorage } from './cameraSettingsPersistence.testSupport.js';
import { loadSettings, saveSettings } from './settings.js';
import { applyNumericTransition, applySelectedFace } from '../sketch/commitToStore.js';
import { t } from '../i18n/t.js';

vi.mock('react', { spy: true });

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTestStore(); });

it('rejects an actual form submit after another camera setting was committed', () => {
  const draft = { ...DEFAULT_CAMERA_CONTROLS, dragSensitivity: 2 };
  vi.spyOn(React, 'useId').mockReturnValue('camera-test');
  const refused = vi.fn();
  vi.spyOn(React, 'useState').mockReturnValueOnce([{ value: draft, expected: DEFAULT_CAMERA_CONTROLS }, vi.fn()])
    .mockReturnValueOnce([false, refused]);
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  vi.spyOn(ReactHooks, 'useCallback').mockImplementation(callback => callback);
  vi.spyOn(ReactHooks, 'useDebugValue').mockImplementation(() => undefined);
  vi.spyOn(ReactHooks, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  const form = CameraControlSettingsForm() as React.ReactElement<{ onSubmit: (event: { preventDefault: () => void }) => void }>;
  const state = useAppStore.getState();
  state.setDisplaySettings({ ...state.displaySettings, cameraControls: { ...DEFAULT_CAMERA_CONTROLS, invertWheel: true } });
  const before = useAppStore.getState();
  form.props.onSubmit({ preventDefault: vi.fn() });
  expect(useAppStore.getState()).toBe(before);
  expect(refused).toHaveBeenCalledWith(true);
  vi.spyOn(React, 'useState').mockReturnValueOnce([{ value: draft, expected: DEFAULT_CAMERA_CONTROLS }, vi.fn()])
    .mockReturnValueOnce([true, vi.fn()]);
  expect(renderToStaticMarkup(CameraControlSettingsForm())).toContain(t('settings.camera.applyStale'));
});

it('captures the expected setting on the first real form edit and keeps it through later edits', () => {
  type Draft = { value: CameraControlSettings; expected: CameraControlSettings };
  vi.spyOn(React, 'useId').mockReturnValue('camera-draft');
  vi.spyOn(ReactHooks, 'useCallback').mockImplementation(callback => callback);
  vi.spyOn(ReactHooks, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  vi.spyOn(ReactHooks, 'useDebugValue').mockImplementation(() => undefined);
  const capture = vi.fn<(value: unknown) => void>();
  function render(draft: Draft | null) {
    vi.spyOn(React, 'useState').mockReturnValueOnce([draft, capture]).mockReturnValueOnce([false, vi.fn()]);
    return CameraControlSettingsForm();
  }
  function click(node: React.ReactNode, title: string): void {
    React.Children.forEach(node, child => {
      if (!React.isValidElement<{ title?: string; onClick?: () => void; children?: React.ReactNode }>(child)) return;
      if (child.props.title === title) child.props.onClick?.();
      click(child.props.children, title);
    });
  }
  click(render(null), t('settings.camera.defaultsGuide'));
  expect(capture).toHaveBeenCalledTimes(1);
  const firstUpdate = capture.mock.calls[0]?.[0] as (previous: null) => Draft;
  const first = firstUpdate(null);
  expect(first.expected).toEqual(EXPECTED_PRESETS.pointercad);
  expect(applyCameraSettings(CUSTOM_CAMERA, DEFAULT_CAMERA_CONTROLS)).toBe(true);
  click(render(first), t('settings.camera.presetGuide').replace('{preset}', t('settings.camera.preset.fusion')));
  expect(capture).toHaveBeenCalledTimes(2);
  const secondUpdate = capture.mock.calls[1]?.[0] as (previous: Draft) => Draft;
  const second = secondUpdate(first);
  expect(second.expected).toBe(first.expected);
  expect(second.value).toEqual(EXPECTED_PRESETS.fusion);
  const before = useAppStore.getState();
  const form = render(second) as React.ReactElement<{ onSubmit: (event: { preventDefault: () => void }) => void }>;
  form.props.onSubmit({ preventDefault: vi.fn() });
  expect(useAppStore.getState()).toBe(before);
});

type State = ReturnType<typeof useAppStore.getState>;
type Kind = 'part' | 'assembly' | 'drawing';
type Fixtures = Awaited<ReturnType<typeof documentFixtures>>;

function documentOf(state: State, kind: Kind) {
  return kind === 'part' ? state.document : kind === 'assembly' ? state.assembly : state.drawing;
}
function historyOf(state: State, kind: Kind) {
  return kind === 'part' ? state.undoStack : kind === 'assembly' ? state.assemblyUndoStack : state.drawingUndoStack;
}
function open(kind: Kind, f: Fixtures): void {
  const state = useAppStore.getState();
  if (kind === 'part') state.resetDocument(f.part);
  else if (kind === 'assembly') state.openAssembly(f.assembly, f.library);
  else state.openDrawing(f.drawing, { sources: f.sources, saved: true, fileName: 'camera.pcadd' });
}
function edit(kind: Kind, f: Fixtures): void {
  const state = useAppStore.getState();
  if (kind === 'part') state.applyDocument({ ...f.part, sketches: f.part.sketches.map(sketch => ({ ...sketch,
    features: sketch.features.map(feature => feature.kind === 'point' && feature.id === f.pointId
      ? { ...feature, at: absoluteCoordinate(25, -7, 3) } : feature) })) });
  else if (kind === 'assembly') state.applyAssembly({ ...f.assembly, components: f.assembly.components.map(component => ({ ...component,
    placement: { ...component.placement, position: [expressionValueFromNumber(12), expressionValueFromNumber(-4), expressionValueFromNumber(3)] as const } })) });
  else state.applyDrawing({ ...f.drawing, sheet: { ...f.drawing.sheet, scale: 2 } });
}
async function archive(kind: Kind, f: Fixtures): Promise<Uint8Array> {
  const state = useAppStore.getState();
  if (kind === 'part') return writePcadFile(state.document, { savedAt: SAVED_AT });
  if (kind === 'assembly' && state.assembly !== null) return writePcadaFile(state.assembly,
    { savedAt: SAVED_AT, parts: state.assemblyLibrary.parts, partFiles: state.assemblyLibrary.partFiles,
      partAttachments: state.assemblyLibrary.attachments });
  if (kind === 'drawing' && state.drawing !== null) return writeDrawingBundle(state.drawing, { savedAt: SAVED_AT, source: f.source });
  throw new Error('missing active document');
}
/** Every state field, including all inputs, version, IDs, derived results and history, retains its reference. */
function expectOnlySettingsChanged(before: State): void {
  const after = useAppStore.getState();
  expect(after).toEqual({ ...before, displaySettings: after.displaySettings });
  for (const key of Object.keys(before) as (keyof State)[]) {
    if (key !== 'displaySettings') expect(after[key], key).toBe(before[key]);
  }
}

describe('EX-10.UNDO settings are outside each document transaction', () => {
  for (const kind of ['part', 'assembly', 'drawing'] as const) {
    it(`${kind}: settings preserve every state field and codec bytes, one Undo/Redo restores the real edit`, async () => {
      const f = await documentFixtures();
      open(kind, f);
      const original = documentOf(useAppStore.getState(), kind);
      expect(historyOf(useAppStore.getState(), kind)?.past).toHaveLength(0);
      edit(kind, f);
      const before = useAppStore.getState();
      const edited = documentOf(before, kind);
      expect(edited).not.toBe(original);
      expect(historyOf(before, kind)?.past).toHaveLength(1);
      const bytes = await archive(kind, f);
      const memory = settingsStorage(); vi.stubGlobal('localStorage', memory.storage);
      expect(applyCameraSettings(CUSTOM_CAMERA, DEFAULT_CAMERA_CONTROLS)).toBe(true);
      expectOnlySettingsChanged(before);
      expect(loadSettings(memory.storage).cameraControls).toEqual(CUSTOM_CAMERA);
      expect(await archive(kind, f)).toEqual(bytes);
      const reopened = kind === 'part' ? readPcadFile(bytes) : kind === 'assembly' ? await readPcadaFile(bytes) : await readDrawingBundle(bytes);
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) throw new Error('archive refused');
      expect(reopened.document).toEqual(edited);
      const settings = useAppStore.getState().displaySettings;
      useAppStore.getState().undo();
      const undone = useAppStore.getState();
      expect(documentOf(undone, kind)).toBe(original);
      expect(undone.activeDocumentId).toBe(before.activeDocumentId);
      expect(historyOf(undone, kind)?.past).toHaveLength(0);
      expect(historyOf(undone, kind)?.future).toHaveLength(1);
      expect(undone.displaySettings).toBe(settings);
      useAppStore.getState().redo();
      const redone = useAppStore.getState();
      expect(documentOf(redone, kind)).toBe(edited);
      expect(redone.activeDocumentId).toBe(before.activeDocumentId);
      expect(historyOf(redone, kind)?.past).toHaveLength(1);
      expect(historyOf(redone, kind)?.future).toHaveLength(0);
      expect(redone.displaySettings).toBe(settings);
      expect(await archive(kind, f)).toEqual(bytes);
      if (kind === 'assembly') expect(redone.assemblyLibrary).toBe(f.library);
      if (kind === 'drawing') expect(redone.drawingSources).toBe(f.sources);
    });

    it(`${kind}: invalid apply, cancel, storage exception and stale draft keep document/history and saved bytes`, async () => {
      const f = await documentFixtures(); open(kind, f); edit(kind, f);
      const memory = settingsStorage(); vi.stubGlobal('localStorage', memory.storage);
      saveSettings(useAppStore.getState().displaySettings, memory.storage);
      let before = useAppStore.getState();
      const initialBytes = memory.bytes(), initialWrites = memory.writes();
      for (const number of [NaN, Infinity, -Infinity, 0, 11]) {
        expect(applyCameraSettings({ ...CUSTOM_CAMERA, wheelSensitivity: number }, DEFAULT_CAMERA_CONTROLS)).toBe(false);
        expect(useAppStore.getState()).toBe(before);
        expect(memory.bytes()).toBe(initialBytes);
        expect(memory.writes()).toBe(initialWrites);
      }
      expect(applyCameraSettings(CUSTOM_CAMERA, DEFAULT_CAMERA_CONTROLS)).toBe(true);
      before = useAppStore.getState();
      const committedBytes = memory.bytes(), committedWrites = memory.writes();
      expect(applyCameraSettings(EXPECTED_PRESETS.fusion, DEFAULT_CAMERA_CONTROLS)).toBe(false);
      expect(useAppStore.getState()).toBe(before);
      expect(memory.bytes()).toBe(committedBytes);
      expect(memory.writes()).toBe(committedWrites);
      // Cancel the actual form's draft after another valid route has committed CUSTOM_CAMERA.
      vi.spyOn(React, 'useId').mockReturnValue('camera-cancel');
      const discard = vi.fn();
      vi.spyOn(React, 'useState').mockReturnValueOnce([{ value: EXPECTED_PRESETS.fusion, expected: DEFAULT_CAMERA_CONTROLS }, discard])
        .mockReturnValueOnce([false, vi.fn()]);
      vi.spyOn(ReactHooks, 'useCallback').mockImplementation(callback => callback);
      vi.spyOn(ReactHooks, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
      vi.spyOn(ReactHooks, 'useDebugValue').mockImplementation(() => undefined);
      const form = CameraControlSettingsForm();
      const buttons: (() => void)[] = [];
      function visit(node: React.ReactNode): void {
        React.Children.forEach(node, child => {
          if (!React.isValidElement<{ title?: string; onClick?: () => void; children?: React.ReactNode }>(child)) return;
          if (child.props.title === t('settings.camera.cancelGuide') && child.props.onClick !== undefined) buttons.push(child.props.onClick);
          visit(child.props.children);
        });
      }
      visit(form); expect(buttons).toHaveLength(1); buttons[0]?.();
      expect(discard).toHaveBeenCalledWith(null);
      expect(useAppStore.getState()).toBe(before);
      expect(memory.bytes()).toBe(committedBytes); expect(memory.writes()).toBe(committedWrites);
      memory.failWrites();
      expect(applyCameraSettings(EXPECTED_PRESETS.fusion, CUSTOM_CAMERA)).toBe(true);
      expectOnlySettingsChanged(before);
      expect(useAppStore.getState().displaySettings.cameraControls).toEqual(EXPECTED_PRESETS.fusion);
      expect(memory.bytes()).toBe(committedBytes);
      expect(loadSettings(memory.storage).cameraControls).toEqual(CUSTOM_CAMERA);
      expect(memory.writes()).toBe(committedWrites + 1);
    });
  }

  it('accepts equivalent expected values and repeated applies while preserving unrelated settings', () => {
    const memory = settingsStorage(); vi.stubGlobal('localStorage', memory.storage);
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, theme: 'lightModern', uiScale: 125,
      cameraControls: structuredClone(DEFAULT_CAMERA_CONTROLS) });
    expect(applyCameraSettings(CUSTOM_CAMERA, DEFAULT_CAMERA_CONTROLS)).toBe(true);
    expect(useAppStore.getState().displaySettings).toMatchObject({ theme: 'lightModern', uiScale: 125, cameraControls: CUSTOM_CAMERA });
    const before = useAppStore.getState(), bytes = memory.bytes(), writes = memory.writes();
    expect(applyCameraSettings({ ...CUSTOM_CAMERA }, DEFAULT_CAMERA_CONTROLS)).toBe(true);
    expect(useAppStore.getState()).toBe(before); expect(memory.bytes()).toBe(bytes); expect(memory.writes()).toBe(writes);
  });

  it('the existing model confirmation and cancellation entrances preserve the previous document and history', async () => {
    const f = await documentFixtures(); open('part', f); edit('part', f);
    const before = useAppStore.getState();
    // A face needs at least three coplanar selected points: this real model operation refuses the empty selection.
    expect(applySelectedFace()).toBe(false);
    expect(useAppStore.getState().faceErrorKey).not.toBeNull();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().documentVersion).toBe(before.documentVersion);
    applyNumericTransition({ kind: 'cancelled' });
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document); expect(after.undoStack).toBe(before.undoStack);
    expect(after.documentVersion).toBe(before.documentVersion); expect(after.activeDocumentId).toBe(before.activeDocumentId);
  });
});
