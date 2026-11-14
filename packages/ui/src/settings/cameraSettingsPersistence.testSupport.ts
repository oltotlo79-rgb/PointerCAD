import {
  absoluteCoordinate, addComponent, appendFeature, createAssemblyDocument, createComponentFor,
  createDrawingDocument, createEmptyPartDocument, createEmptySketchDocument, createPointFeature,
  embedDrawingSource, embedPart, EMPTY_PART_LIBRARY, emptyDrawingSourceLibrary,
  emptyEmbeddedPartAttachments, replaceSketch, type PartDocument,
} from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import type { CameraBinding, CameraControlPreset, CameraControlSettings } from './cameraControlSettings.js';
import type { ViewControlOptions, ViewControlSettings, ViewTrigger } from './viewControlSettings.js';
import type { SettingsStorage } from './settings.js';

export const SAVED_AT = '2026-10-26T00:00:00.000Z';
const SETTINGS_KEY = 'pointercad.settings';

export function settingsStorage(initial: string | null = null) {
  const records = new Map<string, string>(initial === null ? [] : [[SETTINGS_KEY, initial]]);
  let failWrites = false;
  let writes = 0;
  const storage: SettingsStorage = {
    getItem: key => records.get(key) ?? null,
    setItem: (key, value) => {
      writes++;
      if (failWrites) throw new Error('storage quota');
      records.set(key, value);
    },
  };
  return { storage, records, bytes: () => storage.getItem(SETTINGS_KEY), writes: () => writes,
    failWrites: () => { failWrites = true; } };
}

// Independent expectations: no product defaults/preset selector is used to build this table.
function binding(input: CameraBinding['input'], alt = false, shift = false, ctrl = false): CameraBinding {
  return { input, alt, shift, ctrl, meta: false };
}
export const EXPECTED_PRESETS: Readonly<Record<CameraControlPreset, CameraControlSettings>> = {
  pointercad: { version: 1, orbit: [binding('middle'), binding('left', true)],
    pan: [binding('right'), binding('middle', false, true)], zoom: [binding('wheel'), binding('wheel', false, false, true)],
    wheelSensitivity: 1, dragSensitivity: 1, invertWheel: false, invertDrag: false },
  solidworks: { version: 1, orbit: [binding('middle')], pan: [binding('middle', false, false, true)],
    zoom: [binding('wheel'), binding('middle', false, true)],
    wheelSensitivity: 1, dragSensitivity: 1, invertWheel: false, invertDrag: false },
  fusion: { version: 1, orbit: [binding('middle', false, true)], pan: [binding('middle')], zoom: [binding('wheel')],
    wheelSensitivity: 1, dragSensitivity: 1, invertWheel: false, invertDrag: false },
  onshape: { version: 1, orbit: [binding('right')], pan: [binding('middle'), binding('right', false, false, true)],
    zoom: [binding('wheel')], wheelSensitivity: 1, dragSensitivity: 1, invertWheel: false, invertDrag: false },
};
export const CUSTOM_CAMERA: CameraControlSettings = {
  version: 1, orbit: [binding('left', true, true)], pan: [binding('middle', false, false, true)],
  zoom: [{ input: 'wheel', alt: false, shift: false, ctrl: false, meta: true }],
  wheelSensitivity: 2.5, dragSensitivity: 0.4, invertWheel: true, invertDrag: true,
};

// The same independent tables in the v2 shape (viewControls). Hand-written, not produced by the product migration.
function trigger(input: CameraBinding['input'], alt = false, shift = false, ctrl = false, meta = false): ViewTrigger {
  return input === 'wheel' ? { kind: 'wheel', alt, shift, ctrl, meta } : { kind: 'drag', button: input, alt, shift, ctrl, meta };
}
const VIEW_OPTIONS: ViewControlOptions = { orbitSensitivity: 1, panSensitivity: 1, wheelSensitivity: 1, zoomDragSensitivity: 1,
  invertWheel: false, invertZoomDrag: false, invertOrbitX: false, invertOrbitY: false };
export const EXPECTED_VIEW_PRESETS: Readonly<Record<CameraControlPreset, ViewControlSettings>> = {
  pointercad: { version: 2, options: VIEW_OPTIONS, bindings: { orbit: [trigger('middle'), trigger('left', true)],
    pan: [trigger('right'), trigger('middle', false, true)], zoom: [trigger('wheel'), trigger('wheel', false, false, true)] } },
  solidworks: { version: 2, options: VIEW_OPTIONS, bindings: { orbit: [trigger('middle')], pan: [trigger('middle', false, false, true)],
    zoom: [trigger('wheel'), trigger('middle', false, true)] } },
  fusion: { version: 2, options: VIEW_OPTIONS, bindings: { orbit: [trigger('middle', false, true)], pan: [trigger('middle')], zoom: [trigger('wheel')] } },
  onshape: { version: 2, options: VIEW_OPTIONS, bindings: { orbit: [trigger('right')],
    pan: [trigger('middle'), trigger('right', false, false, true)], zoom: [trigger('wheel')] } },
};
/** CUSTOM_CAMERA after the v1 to v2 migration: same bindings and zoom tuning, new rotation and pan fields at their defaults. */
export const CUSTOM_VIEW: ViewControlSettings = { version: 2,
  bindings: { orbit: [trigger('left', true, true)], pan: [trigger('middle', false, false, true)], zoom: [trigger('wheel', false, false, false, true)] },
  options: { ...VIEW_OPTIONS, wheelSensitivity: 2.5, zoomDragSensitivity: 0.4, invertWheel: true, invertZoomDrag: true } };

/** Small authored inputs with stable cross-document references; no kernel success is fabricated. */
export async function documentFixtures() {
  let sketch = createEmptySketchDocument();
  sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(12.5, -7, 3)));
  const point = sketch.features[0];
  if (point === undefined) throw new Error('missing point');
  sketch = appendFeature(sketch, createPointFeature(sketch, { mode: 'relative', base: { kind: 'point', pointId: point.id },
    dx: expressionValueFromNumber(4), dy: expressionValueFromNumber(5), dz: expressionValueFromNumber(0) }));
  const part: PartDocument = { ...replaceSketch(createEmptyPartDocument(), sketch), name: 'Camera persistence part' };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'camera-part.pcad', '', { importedAt: SAVED_AT });
  let assembly = createAssemblyDocument('Camera persistence assembly');
  const partRef = [...embedded.library.parts.keys()][0];
  if (partRef === undefined) throw new Error('missing embedded part');
  assembly = addComponent(assembly, createComponentFor(assembly, { kind: 'part', partRef }, { partName: part.name }));
  const source = { sourceKind: 'part', document: part, attachments: emptyEmbeddedPartAttachments() } as const;
  const drawingSource = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'camera-part.pcad', '', { importedAt: SAVED_AT });
  const drawing = createDrawingDocument('Camera persistence drawing', drawingSource.source);
  return { part, assembly, drawing, library: embedded.library, source, sources: drawingSource.library,
    pointId: point.id, partRef };
}
