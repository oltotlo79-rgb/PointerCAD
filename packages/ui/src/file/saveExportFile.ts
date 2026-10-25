import { saveFileAsThrough, type ExportSaveControl, type FileGateway, type SaveFileKind } from './fileGateway.js';
import { isCamFormat, type ExportHandoff } from './openWith.js';
export interface SavedExchangeFile { readonly saved: boolean; readonly handoff?: ExportHandoff; }

export type { ExportSaveControl } from './fileGateway.js';

export function mayStartExportSave(control?: ExportSaveControl): boolean {
  return control === undefined || (!control.signal.aborted && control.isCurrent());
}

/** 保存先を聞く1操作の答えを使う。後から共有の「最後の保存先」を読み直さない。 */
export async function saveExportFile(
  gateway: FileGateway, name: string, format: SaveFileKind, bytes: Uint8Array,
  control?: ExportSaveControl,
): Promise<SavedExchangeFile> {
  if (!mayStartExportSave(control)) return { saved: false };
  if (isCamFormat(format) && gateway.saveExport !== undefined) {
    const receipt = await (control === undefined ? gateway.saveExport(name, format, bytes)
      : gateway.saveExport(name, format, bytes, control));
    if (!mayStartExportSave(control)) return { saved: false };
    return receipt === null ? { saved: false } : { saved: true, handoff: { format, token: receipt.token } };
  }
  const saved = await saveFileAsThrough(gateway, name, format, bytes, control);
  if (!mayStartExportSave(control)) return { saved: false };
  return saved && isCamFormat(format) ? { saved, handoff: { format, token: null } } : { saved };
}
