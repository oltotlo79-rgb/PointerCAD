import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import { hasIgesBindings, IGES_UNAVAILABLE } from './igesBindings.js';
import { withVirtualFile } from './virtualFile.js';
import { buildXcafDocument, type XcafShapeEntry } from './xcafDocument.js';

const WRITE_FAILED = 'IGES ファイルを書き出せませんでした。';
const RESTORE_FAILED = 'IGES の書出し設定を元に戻せませんでした。';
const TRIMMED_SURFACES = 0;

interface IgesWriteOptions {
  readonly withColors?: boolean;
  readonly unit?: 'mm' | 'inch';
}

interface IgesWriteResult {
  readonly bytes: Uint8Array;
  readonly colorWritten: boolean;
}

export function writeIges(
  oc: OpenCascadeInstance,
  entries: readonly XcafShapeEntry[],
  options: IgesWriteOptions = {},
): IgesWriteResult {
  if (!hasIgesBindings(oc)) throw new Error(IGES_UNAVAILABLE);
  const document = buildXcafDocument(oc, entries, {
    withColors: options.withColors,
    bodyLabelColor: true,
  });
  const { keep, release } = createAllocations();
  try {
    const settings = oc.IGESControl_Writer;
    const unit = options.unit === 'inch' ? 'INCH' : 'MM';
    const priorUnit = settings.WriteUnit();
    const priorMode = settings.WriteBRepMode();
    const files = withVirtualFile(oc, 'iges', path => {
      // No await while the OCCT instance's shared IGES settings are overridden.
      try {
        if (!settings.SetWriteUnit(unit) || !settings.SetWriteBRepMode(TRIMMED_SURFACES)) {
          throw new Error(WRITE_FAILED);
        }
        const writer = keep(new oc.IGESCAFControl_Writer_1());
        writer.SetNameMode(true);
        writer.SetColorMode(options.withColors ?? true);
        writer.SetLayerMode(false);
        const file = keep(new oc.TCollection_AsciiString_2(path));
        const progress = keep(new oc.Message_ProgressRange_1());
        if (!writer.Perform_1(document.handle, file, progress)) throw new Error(WRITE_FAILED);
      } finally {
        restoreSettings();
      }
    });
    const file = files[0];
    if (files.length !== 1 || file === undefined || file.bytes.byteLength === 0) throw new Error(WRITE_FAILED);
    return { bytes: file.bytes, colorWritten: document.colorWritten };

    function restoreSettings(): void {
      let restoredUnit: boolean;
      let restoredMode: boolean;
      try {
        restoredUnit = settings.SetWriteUnit(priorUnit);
      } finally {
        restoredMode = settings.SetWriteBRepMode(priorMode);
      }
      if (!restoredUnit || !restoredMode) throw new Error(RESTORE_FAILED);
    }
  } finally {
    try { release(); } finally { document.delete(); }
  }
}
