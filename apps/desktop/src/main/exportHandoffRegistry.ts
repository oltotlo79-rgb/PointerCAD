import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { CamFormat } from '@pointercad/ui/open-with';

interface SavedExport { readonly token: string; readonly path: string; }
/** 文書の上書き先とは別に、各窓の最新の書き出し成功だけを保管する。 */
export class ExportHandoffRegistry {
  private readonly revisions = new Map<number, object>();
  private readonly files = new Map<number, SavedExport>();
  begin(sender: number): object {
    const revision = {};
    this.revisions.set(sender, revision); this.files.delete(sender);
    return revision;
  }
  clear(sender: number): void { this.revisions.delete(sender); this.files.delete(sender); }
  complete(sender: number, revision: object, format: CamFormat, path: string): string | null {
    if (this.revisions.get(sender) !== revision) return null;
    const extension = extname(path).toLowerCase();
    const valid = format === 'step' ? extension === '.step' || extension === '.stp' : extension === `.${format}`;
    if (!valid) throw new Error('この種類のファイルは加工先へ渡せません。');
    const token = randomUUID();
    this.files.set(sender, { token, path });
    return token;
  }
  resolve(sender: number, token: unknown): string | null {
    const saved = this.files.get(sender);
    return typeof token === 'string' && token === saved?.token ? saved.path : null;
  }
}
