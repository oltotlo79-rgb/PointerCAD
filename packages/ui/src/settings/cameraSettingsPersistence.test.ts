import { describe, expect, it } from 'vitest';
import {
  parseDocument, parseDrawing, readArchive, readAssemblyDocument, readDrawingBundle, readPcadaFile, readPcadFile,
  serializeDocument, serializeDrawing, writeAssemblyDocument, writeDrawingBundle, writePcadaFile, writePcadFile,
} from '@pointercad/io';
import type { CameraControlPreset } from './cameraControlSettings.js';
import { DEFAULT_DISPLAY_SETTINGS, loadSettings, saveSettings } from './settings.js';
import { withViewControlPreset } from './viewControlSettings.js';
import {
  CUSTOM_CAMERA, CUSTOM_VIEW, documentFixtures, EXPECTED_PRESETS, EXPECTED_VIEW_PRESETS, SAVED_AT, settingsStorage,
} from './cameraSettingsPersistence.testSupport.js';

/** Pinned expected values: the same literals as the product constants, kept independent of them. */
const SETTINGS_KEY = 'pointercad.settings';

// expected: the frozen v1 record as read back; view: the v2 source of truth; recovered: the unsaved startup notice count.
const fixtures = [
  { name: 'legacy without camera', camera: undefined, expected: EXPECTED_PRESETS.pointercad, view: EXPECTED_VIEW_PRESETS.pointercad, recovered: 0 },
  { name: 'current version 1', camera: CUSTOM_CAMERA, expected: CUSTOM_CAMERA, view: CUSTOM_VIEW, recovered: 0 },
  // Unreadable: the empty orbit, the missing pan and zoom, and the four missing v1 tuning fields.
  { name: 'corrupt camera', camera: { version: 1, orbit: [] }, expected: EXPECTED_PRESETS.pointercad, view: EXPECTED_VIEW_PRESETS.pointercad, recovered: 7 },
  { name: 'unknown version', camera: { ...CUSTOM_CAMERA, version: 99 }, expected: EXPECTED_PRESETS.pointercad, view: EXPECTED_VIEW_PRESETS.pointercad, recovered: 1 },
] as const;
const TUNING = { orbitSensitivity: 1.7, panSensitivity: 0.3, wheelSensitivity: 3.2, zoomDragSensitivity: 0.6,
  invertWheel: true, invertZoomDrag: true, invertOrbitX: false, invertOrbitY: true } as const;
const presets: readonly CameraControlPreset[] = ['pointercad', 'solidworks', 'fusion', 'onshape'];

describe('EX-10.PERSIST terminal settings', () => {
  for (const fixture of fixtures) {
    it(`roundtrips ${fixture.name} through the same storage key`, () => {
      const memory = settingsStorage(JSON.stringify({ theme: 'lightModern', uiScale: 125, cameraControls: fixture.camera }));
      const loaded = loadSettings(memory.storage);
      expect(loaded.cameraControls).toEqual(fixture.expected);
      expect(loaded).toEqual({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'lightModern', uiScale: 125, cameraControls: fixture.expected,
        viewControls: fixture.view, ...(fixture.recovered === 0 ? {} : { viewControlsRecovered: fixture.recovered }) });
      saveSettings(loaded, memory.storage);
      // The notice count is display-only: it is never written, so a reload has nothing left to report.
      const persisted = { ...loaded, viewControlsRecovered: undefined };
      expect(loadSettings(memory.storage)).toEqual(persisted);
      expect(JSON.parse(memory.bytes() ?? '')).toEqual(persisted);
      expect(memory.bytes()).not.toContain('viewControlsRecovered');
      expect([...memory.records.keys()]).toEqual([SETTINGS_KEY]);
    });
    for (const preset of presets) {
      it(`${fixture.name} preserves every field of ${preset}, the personal tuning and the frozen v1 record`, () => {
        const memory = settingsStorage(JSON.stringify({ theme: 'lightModern', uiScale: 125, cameraControls: fixture.camera }));
        const loaded = loadSettings(memory.storage);
        const view = withViewControlPreset({ ...fixture.view, options: TUNING }, preset);
        const expected = { ...EXPECTED_VIEW_PRESETS[preset], options: TUNING };
        expect(view).toEqual(expected);
        const configured = { ...loaded, viewControls: view };
        saveSettings(configured, memory.storage);
        const persisted = { ...loaded, viewControls: expected, viewControlsRecovered: undefined };
        expect(JSON.parse(memory.bytes() ?? '')).toEqual(persisted);
        expect(loadSettings(memory.storage)).toEqual(persisted);
        expect(loadSettings(memory.storage).cameraControls).toEqual(fixture.expected);
      });
    }
  }
  it('recovers invalid JSON through real load/save', () => {
    const memory = settingsStorage('{broken');
    expect(loadSettings(memory.storage)).toEqual(DEFAULT_DISPLAY_SETTINGS);
    saveSettings(loadSettings(memory.storage), memory.storage);
    expect(loadSettings(memory.storage)).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });
});

describe('EX-10.PERSIST document codecs', () => {
  it('keeps runtime settings and derived caches outside the authored document codecs', async () => {
    const f = await documentFixtures();
    // Deliberately alien runtime fields, not a forged successful recompute result.
    const runtime = { cameraControls: CUSTOM_CAMERA, viewControls: CUSTOM_VIEW, displaySettings: DEFAULT_DISPLAY_SETTINGS,
      bodies: ['derived-cache-sentinel'], resolvedSketch: { diagnostic: 'derived-cache-sentinel' }, undoStack: ['history-sentinel'] };
    const part = { ...f.part, ...runtime }, assembly = { ...f.assembly, ...runtime };
    // Drawing preserves unknown authored JSON fields. Test its documented derived cache names instead;
    // cameraSettingsHistory separately checks that its real store never mixes terminal settings into the document.
    const drawing = { ...f.drawing, projectionCache: ['derived-cache-sentinel'], mesh: ['derived-cache-sentinel'],
      resolvedViews: ['derived-cache-sentinel'], viewFrames: ['derived-cache-sentinel'] };
    for (const [text, expected] of [[serializeDocument(part, { savedAt: SAVED_AT }), f.part],
      [writeAssemblyDocument(assembly, { savedAt: SAVED_AT }), f.assembly],
      [serializeDrawing(drawing, { savedAt: SAVED_AT }), f.drawing]] as const) {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || !('document' in parsed)) throw new Error('missing document');
      expect(parsed.document).toEqual(expected);
      expect(text).not.toContain('derived-cache-sentinel');
      expect(text).not.toContain('history-sentinel');
      expect(text).not.toContain('cameraControls');
      expect(text).not.toContain('viewControls');
      expect(text).not.toContain('displaySettings');
    }
  });
  it('roundtrips whole old/current part, assembly and drawing inputs without terminal or derived state', async () => {
    const f = await documentFixtures();
    // Schema 21 is the preceding supported document format; no authored field is removed for comparison.
    for (const schemaVersion of [21, f.part.schemaVersion]) {
      const part = { ...f.part, schemaVersion };
      const assembly = { ...f.assembly, schemaVersion };
      const drawing = { ...f.drawing, schemaVersion };
      const partText = serializeDocument(part, { savedAt: SAVED_AT });
      const assemblyText = writeAssemblyDocument(assembly, { savedAt: SAVED_AT });
      const drawingText = serializeDrawing(drawing, { savedAt: SAVED_AT });
      const parsedPart = parseDocument(partText), parsedAssembly = readAssemblyDocument(assemblyText), parsedDrawing = parseDrawing(drawingText);
      expect(parsedPart.ok).toBe(true); expect(parsedAssembly.ok).toBe(true); expect(parsedDrawing.ok).toBe(true);
      if (!parsedPart.ok || !parsedAssembly.ok || !parsedDrawing.ok) throw new Error('codec rejected fixture');
      // Readers migrate the format version; all authored fields are compared.
      expect(parsedPart.document).toEqual({ ...part, schemaVersion: f.part.schemaVersion });
      expect(parsedPart.document.sketches[0]?.features[1]).toMatchObject({ at: { mode: 'relative', base: { kind: 'point', pointId: f.pointId } } });
      expect(parsedAssembly.document).toEqual({ ...assembly, schemaVersion: f.assembly.schemaVersion });
      expect(parsedAssembly.document.components[0]?.source).toEqual({ kind: 'part', partRef: f.partRef });
      expect(parsedDrawing.document).toEqual({ ...drawing, schemaVersion: f.drawing.schemaVersion });
      const partBytes = writePcadFile(part, { savedAt: SAVED_AT });
      const assemblyBytes = await writePcadaFile(assembly, { savedAt: SAVED_AT, parts: f.library.parts });
      const source = { ...f.source, document: part };
      const drawingBytes = await writeDrawingBundle(drawing, { savedAt: SAVED_AT, source });
      const openedPart = readPcadFile(partBytes), openedAssembly = await readPcadaFile(assemblyBytes), openedDrawing = await readDrawingBundle(drawingBytes);
      expect(openedPart.ok).toBe(true); expect(openedAssembly.ok).toBe(true); expect(openedDrawing.ok).toBe(true);
      if (!openedPart.ok || !openedAssembly.ok || !openedDrawing.ok) throw new Error('archive rejected fixture');
      expect(openedPart.document).toEqual(parsedPart.document);
      expect(openedAssembly.document).toEqual(parsedAssembly.document);
      expect(openedAssembly.parts.get(f.partRef)).toEqual(f.part);
      expect(openedDrawing.document).toEqual(parsedDrawing.document);
      expect(openedDrawing.source.document).toEqual(parsedPart.document);
      for (const bytes of [partBytes, assemblyBytes, drawingBytes]) {
        const archive = readArchive(bytes, { shouldExtract: () => true });
        expect(archive.ok).toBe(true);
        if (!archive.ok) throw new Error('archive rejected');
        for (const [name, entry] of archive.entries) {
          expect(name.endsWith('.json')).toBe(true);
          const text = new TextDecoder().decode(entry);
          expect(text).not.toMatch(/"(?:cameraControls|viewControls|displaySettings|wheelSensitivity|dragSensitivity|orbitSensitivity|panSensitivity|resolvedSketch|bodies|mesh|undoStack)"/u);
        }
      }
    }
  });
});
