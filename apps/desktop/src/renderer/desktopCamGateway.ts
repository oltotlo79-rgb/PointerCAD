import { t, type FileGateway } from '@pointercad/ui';
import type { CamFormat, CamTool } from '@pointercad/ui/open-with';
interface CamApi {
  saveExport(name: string, format: CamFormat, bytes: Uint8Array): Promise<unknown>;
  openExport(token: string): Promise<unknown>;
  openCamTool(tool: CamTool): Promise<unknown>;
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
    async saveExport(name, format, bytes) {
      const result = await api.saveExport(name, format, bytes);
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
