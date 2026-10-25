import { t, type FileGateway } from '@pointercad/ui';
import type { CamFormat, CamTool } from '@pointercad/ui/open-with';
interface CamApi {
  saveExport(name: string, format: CamFormat, bytes: Uint8Array, requestId?: string): Promise<unknown>;
  openExport(token: string): Promise<unknown>;
  openCamTool(tool: CamTool): Promise<unknown>;
  cancelExportSave?(requestId: string): Promise<unknown> | void;
}

type ExportControl = NonNullable<Parameters<NonNullable<FileGateway['saveExport']>>[3]>;

/** Keep AbortSignal/functions in the renderer and send only a one-attempt ID through IPC. */
export async function controlledDesktopExport<Result>(
  api: { cancelExportSave?: (requestId: string) => Promise<unknown> | void },
  control: ExportControl | undefined,
  invoke: (requestId?: string) => Promise<Result>,
): Promise<Result | null> {
  if (control === undefined) return invoke();
  if (control.signal.aborted || !control.isCurrent() || typeof api.cancelExportSave !== 'function') return null;
  const requestId = crypto.randomUUID();
  const cancel = (): void => {
    try { void Promise.resolve(api.cancelExportSave?.(requestId)).catch(() => {}); }
    catch { /* Main may already have settled. */ }
  };
  control.signal.addEventListener('abort', cancel, { once: true });
  try {
    if (control.signal.aborted || !control.isCurrent()) {
      cancel();
      return null;
    }
    const result = await invoke(requestId);
    return control.signal.aborted || !control.isCurrent() ? null : result;
  } finally {
    control.signal.removeEventListener('abort', cancel);
  }
}
function hasCamApi(value: unknown): value is CamApi {
  return typeof value === 'object' && value !== null
    && 'saveExport' in value && typeof value.saveExport === 'function'
    && 'openExport' in value && typeof value.openExport === 'function'
    && 'openCamTool' in value && typeof value.openCamTool === 'function';
}
export function desktopCamGateway(api: unknown): Pick<FileGateway, 'saveExport' | 'openExport' | 'openCamTool'> {
  if (!hasCamApi(api)) return {};
  return {
    async saveExport(name, format, bytes, control) {
      const result = await controlledDesktopExport(api, control,
        (requestId) => requestId === undefined ? api.saveExport(name, format, bytes)
          : api.saveExport(name, format, bytes, requestId));
      if (result === null) return null;
      if (typeof result !== 'object' || result === null || !('token' in result)
        || (result.token !== null && (typeof result.token !== 'string' || result.token.length === 0 || result.token.length > 100))) {
        throw new Error(t('file.saveFailed'));
      }
      return { token: result.token };
    },
    async openExport(token) { return await api.openExport(token) === true; },
    async openCamTool(tool) { return await api.openCamTool(tool) === true; },
  };
}
