import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { CAM_TOOL_URLS, isCamFormat, isCamTool, type CamFormat } from '@pointercad/ui/open-with';
import { validateAppSender } from './appSender.js';
import { ExportHandoffRegistry } from './exportHandoffRegistry.js';

const handoffs = new ExportHandoffRegistry();
const watched = new Set<number>();
export function clearExportHandoff(sender: number): void { handoffs.clear(sender); }
function watch(event: IpcMainInvokeEvent): void {
  const id = event.sender.id;
  if (watched.has(id)) return;
  watched.add(id);
  event.sender.once('destroyed', () => { clearExportHandoff(id); watched.delete(id); });
}
function authorized(event: IpcMainInvokeEvent): void {
  if (!validateAppSender(event)) throw new Error('この画面からは加工先へ渡せません。');
}
export function registerExportHandoffIpc(save: (window: BrowserWindow | null, name: string, format: CamFormat, bytes: Uint8Array) => Promise<string | null>): void {
  ipcMain.handle('pcad:saveExport', async (event, ...args: unknown[]) => {
    authorized(event);
    const [name, format, bytes] = args;
    if (args.length !== 3 || typeof name !== 'string' || !isCamFormat(format) || !(bytes instanceof Uint8Array)) {
      throw new Error('書き出しの依頼の形が正しくありません。');
    }
    watch(event);
    const revision = handoffs.begin(event.sender.id);
    const path = await save(BrowserWindow.fromWebContents(event.sender), name, format, bytes);
    return path === null ? null : { token: handoffs.complete(event.sender.id, revision, format, path) };
  });
  ipcMain.handle('pcad:openExport', async (event, ...args: unknown[]) => {
    authorized(event);
    if (args.length !== 1) return false;
    const path = handoffs.resolve(event.sender.id, args[0]);
    if (path === null) return false;
    try { return await shell.openPath(path) === ''; } catch { return false; }
  });
  ipcMain.handle('pcad:openCamTool', async (event, ...args: unknown[]) => {
    authorized(event);
    if (args.length !== 1 || !isCamTool(args[0])) return false;
    try { await shell.openExternal(CAM_TOOL_URLS[args[0]]); return true; } catch { return false; }
  });
}
