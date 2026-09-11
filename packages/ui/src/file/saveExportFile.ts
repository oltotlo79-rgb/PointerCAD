import { saveFileAsThrough, type FileGateway, type SaveFileKind } from './fileGateway.js';
import { isCamFormat, type ExportHandoff } from './openWith.js';
export interface SavedExchangeFile { readonly saved: boolean; readonly handoff?: ExportHandoff; }

/** 保存先を聞く1操作の答えを使う。後から共有の「最後の保存先」を読み直さない。 */
export async function saveExportFile(gateway: FileGateway, name: string, format: SaveFileKind, bytes: Uint8Array): Promise<SavedExchangeFile> {
  if (isCamFormat(format) && gateway.saveExport !== undefined) {
    const receipt = await gateway.saveExport(name, format, bytes);
    return receipt === null ? { saved: false } : { saved: true, handoff: { format, token: receipt.token } };
  }
  const saved = await saveFileAsThrough(gateway, name, format, bytes);
  return saved && isCamFormat(format) ? { saved, handoff: { format, token: null } } : { saved };
}
