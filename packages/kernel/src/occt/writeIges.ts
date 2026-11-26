import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import { hasIgesBindings, IGES_UNAVAILABLE } from './igesBindings.js';
import { ShapeExportError } from './shapeExportDiagnostic.js';
import { withVirtualFile } from './virtualFile.js';
import { buildXcafDocument, type XcafShapeEntry } from './xcafDocument.js';

const WRITE_FAILED = 'IGES ファイルを書き出せませんでした。';
const TRIMMED_SURFACES = 0;

interface IgesWriteOptions {
  readonly withColors?: boolean;
  readonly unit?: 'mm' | 'inch';
}

interface IgesWriteResult {
  readonly bytes: Uint8Array;
  readonly colorWritten: boolean;
}

function withCleanup<T>(perform: () => T, cleanup: () => void): T {
  let result: T;
  try {
    result = perform();
  } catch (error) {
    try { cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'IGES write and cleanup failed', { cause: cleanupError });
    }
    throw error;
  }
  cleanup();
  return result;
}

function restoreSettings(settings: OpenCascadeInstance['IGESControl_Writer'], unit: string, mode: number): void {
  const failures: unknown[] = [];
  try {
    if (!settings.SetWriteUnit(unit)) throw new Error('IGES write unit restoration was rejected');
  } catch (error) { failures.push(error); }
  try {
    if (!settings.SetWriteBRepMode(mode)) throw new Error('IGES write mode restoration was rejected');
  } catch (error) { failures.push(error); }
  if (failures.length > 0) throw new AggregateError(failures, 'IGES write settings could not be restored');
}

export function writeIges(
  oc: OpenCascadeInstance,
  entries: readonly XcafShapeEntry[],
  options: IgesWriteOptions = {},
): IgesWriteResult {
  if (!hasIgesBindings(oc)) throw new ShapeExportError({ code: 'igesUnavailable' }, IGES_UNAVAILABLE);
  const { keep, release } = createAllocations();
  return withCleanup(() => {
    const document = keep(buildXcafDocument(oc, entries, {
      withColors: options.withColors,
      bodyLabelColor: true,
    }));
    const settings = oc.IGESControl_Writer;
    const unit = options.unit === 'inch' ? 'INCH' : 'MM';
    const priorUnit = settings.WriteUnit();
    const priorMode = settings.WriteBRepMode();
    const files = withVirtualFile(oc, 'iges', path => {
      // No await while the OCCT instance's shared IGES settings are overridden.
      withCleanup(() => {
        if (!settings.SetWriteUnit(unit) || !settings.SetWriteBRepMode(TRIMMED_SURFACES)) {
          throw new Error('IGES writer rejected supported output settings');
        }
        const writer = keep(new oc.IGESCAFControl_Writer_1());
        writer.SetNameMode(true);
        writer.SetColorMode(options.withColors ?? true);
        writer.SetLayerMode(false);
        const file = keep(new oc.TCollection_AsciiString_2(path));
        const progress = keep(new oc.Message_ProgressRange_1());
        if (!writer.Perform_1(document.handle, file, progress)) throw new Error(WRITE_FAILED);
      }, () => restoreSettings(settings, priorUnit, priorMode));
    });
    const file = files[0];
    if (files.length !== 1 || file === undefined || file.bytes.byteLength === 0) {
      throw new Error('IGES writer did not produce one nonempty output');
    }
    return { bytes: file.bytes, colorWritten: document.colorWritten };
  }, release);
}
