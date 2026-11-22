import { toPdfPages, type RenderDocument } from '@pointercad/drawing';
import { drawingFont } from '../drawing/drawingFont.js';
import { saveFileAsThrough } from '../file/fileGateway.js';
import { hasSaveRecoveryCopy } from '../file/saveFailure.js';
import type { MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import type { OutlineText } from './reportLayout.js';

const twoDigits = (value: number): string => String(value).padStart(2, '0');

/** 見出しに出す書き出しの日時(その場の時刻。年-月-日 時:分)。梁と立体の報告書で同じ書き方。 */
export function reportTime(date: Date): string {
  return `${String(date.getFullYear())}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} `
    + `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/** 書き出さなかった理由を状態欄へ出す。 */
export function refuseReport(key: MessageKey): false {
  useAppStore.getState().setFileMessage({ key, failed: true });
  return false;
}

/** 書き出す物: PDF の題・保存の窓に出す名前・書き出しの時刻・字体の輪郭を受けて頁を組む関数。 */
interface PreparedReport {
  readonly title: string;
  readonly fileName: string;
  readonly exportedAt: Date;
  readonly pages: (outline: OutlineText) => readonly RenderDocument[];
}

interface ReportPdfRequest {
  /** 同じ物の書き出しを 2 つ重ねないための鍵(会話ごと)。 */
  readonly owner: string;
  /** 書き出す物を作る(重ねの見張りの中で 1 回)。作れない時は、出す理由の鍵を返す。 */
  readonly prepare: () => PreparedReport | MessageKey;
  /** 字体を待った後も同じ会話か。違えば保存しない。 */
  readonly stillCurrent: () => boolean;
}

const exporting = new Set<string>();

/**
 * 解析の報告書(A4 の PDF)を書き出す共通の道(梁と立体。J-03c)。作る → 字体を待つ → 組版 → toPdfPages → 保存の窓
 * (図面の PDF の書き出しと同じ道)。字体を待つ間に会話が替わったら保存しない。
 */
export async function saveReportPdf(request: ReportPdfRequest): Promise<boolean> {
  const gateway = useAppStore.getState().fileGateway;
  if (exporting.has(request.owner)) return false;
  exporting.add(request.owner);
  try {
    const prepared = request.prepare();
    if (typeof prepared === 'string') return refuseReport(prepared);
    if (await drawingFont.load() !== 'ready') return refuseReport('analysisReport.fontFailed');
    if (!request.stillCurrent()) return false;
    const pdf = toPdfPages(prepared.pages(drawingFont.outline),
      { title: prepared.title, creationDate: prepared.exportedAt.toISOString() });
    if (!pdf.ok) return refuseReport('analysisReport.failed');
    return await saveFileAsThrough(gateway, prepared.fileName, 'pdf', pdf.bytes);
  } catch (error) {
    return refuseReport(hasSaveRecoveryCopy(error) ? 'file.saveRecoveryCopyRetained' : 'analysisReport.failed');
  } finally {
    exporting.delete(request.owner);
  }
}
