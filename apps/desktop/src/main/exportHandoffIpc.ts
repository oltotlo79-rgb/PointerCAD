import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { CAM_TOOL_URLS, isCamFormat, isCamTool, type CamFormat } from '@pointercad/ui/open-with';
import { validateAppSender } from './appSender.js';
import { ExportHandoffRegistry } from './exportHandoffRegistry.js';

const handoffs = new ExportHandoffRegistry();
const watched = new Set<number>();
const pendingWrites = new Map<number, Map<string, AbortController>>();
const cancelledWrites = new Map<number, Set<string>>();
const saturatedSenders = new Set<number>();
const MAX_CANCELLED_IDS = 1024;
const REQUEST_ID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}
function clearWriteState(sender: number): void {
  for (const controller of pendingWrites.get(sender)?.values() ?? []) controller.abort();
  pendingWrites.delete(sender);
  cancelledWrites.delete(sender);
  saturatedSenders.delete(sender);
}
export function clearExportHandoff(sender: number): void { handoffs.clear(sender); }
function watch(event: IpcMainInvokeEvent): void {
  const id = event.sender.id;
  if (watched.has(id)) return;
  watched.add(id);
  event.sender.once('destroyed', () => { clearExportHandoff(id); clearWriteState(id); watched.delete(id); });
}
function authorized(event: IpcMainInvokeEvent): void {
  if (!validateAppSender(event)) throw new Error('この画面からは加工先へ渡せません。');
}

function rememberCancellation(sender: number, requestId: string): void {
  if (saturatedSenders.has(sender)) return;
  let cancelled = cancelledWrites.get(sender);
  if (cancelled === undefined) {
    cancelled = new Set();
    cancelledWrites.set(sender, cancelled);
  }
  if (cancelled.size >= MAX_CANCELLED_IDS) {
    cancelled.clear();
    saturatedSenders.add(sender); // Fail closed instead of accepting a late invoke after tombstone eviction.
  } else {
    cancelled.add(requestId);
  }
}

/** The ID is opaque and scoped to the validated sender; functions/signals never cross IPC. */
export function beginExportWrite(event: IpcMainInvokeEvent, requestId: unknown):
  { readonly signal: AbortSignal | undefined; finish(): void } | null {
  if (requestId === undefined) return { signal: undefined, finish(): void { return; } }; // legacy direct save
  if (!isRequestId(requestId)) throw new Error('書き出しの依頼の形が正しくありません。');
  watch(event);
  const sender = event.sender.id;
  if (saturatedSenders.has(sender) || cancelledWrites.get(sender)?.has(requestId)) return null;
  let active = pendingWrites.get(sender);
  if (active === undefined) {
    active = new Map();
    pendingWrites.set(sender, active);
  }
  if (active.has(requestId)) throw new Error('書き出しの依頼が重複しています。');
  const controller = new AbortController();
  active.set(requestId, controller);
  const activeWrites = active;
  return { signal: controller.signal, finish(): void {
    if (activeWrites.get(requestId) === controller) activeWrites.delete(requestId);
    if (activeWrites.size === 0 && pendingWrites.get(sender) === activeWrites) pendingWrites.delete(sender);
  } };
}

export function registerExportHandoffIpc(save: (window: BrowserWindow | null, name: string, format: CamFormat,
  bytes: Uint8Array, signal?: AbortSignal) => Promise<string | null>): void {
  ipcMain.handle('pcad:cancelExportSave', (event, ...args: unknown[]) => {
    authorized(event);
    if (args.length !== 1 || !isRequestId(args[0])) throw new Error('書き出しの取消の形が正しくありません。');
    watch(event);
    const requestId = args[0];
    pendingWrites.get(event.sender.id)?.get(requestId)?.abort();
    rememberCancellation(event.sender.id, requestId);
    return true;
  });
  ipcMain.handle('pcad:saveExport', async (event, ...args: unknown[]) => {
    authorized(event);
    const [name, format, bytes, requestId] = args;
    if ((args.length !== 3 && args.length !== 4) || typeof name !== 'string' || !isCamFormat(format)
        || !(bytes instanceof Uint8Array) || (args.length === 4 && !isRequestId(requestId))) {
      throw new Error('書き出しの依頼の形が正しくありません。');
    }
    watch(event);
    const revision = handoffs.begin(event.sender.id);
    const attempt = beginExportWrite(event, requestId);
    if (attempt === null) return null;
    try {
      const path = await save(BrowserWindow.fromWebContents(event.sender), name, format, bytes, attempt.signal);
      if (path === null || attempt.signal?.aborted) return null;
      const token = handoffs.complete(event.sender.id, revision, format, path);
      return token === null ? null : { token };
    } finally {
      attempt.finish();
    }
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
