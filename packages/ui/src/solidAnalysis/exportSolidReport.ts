import { refuseReport, reportTime, saveReportPdf } from '../analysisReport/exportReport.js';
import { REPORT_FIGURE_SIZE, type ReportFigure } from '../analysisReport/reportLayout.js';
import { t } from '../i18n/t.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentSessionResult, savedSolidDefinition } from './savedSolidResults.js';
import { buildSolidReport, solidReportCaption, type SolidReportInput } from './solidReport.js';
import { solidReportField, type SolidReportField } from './solidReportField.js';

type ExportState = Pick<AppState, 'document' | 'solidAnalysisSession' | 'completedGeneration'>;

/**
 * 保存した入力のまま、今の形で計算し終えた静解析の結果がある時だけ書き出せる(釦の押せる条件と同じ)。
 * 計算した結果も、開いたファイル・窓を閉じる前の結果を戻した物も、同じ照らし(currentSessionResult)で決める。
 */
export function canExportSolidReport(state: ExportState): boolean {
  return currentSessionResult(state.document, state.solidAnalysisSession, state.completedGeneration) !== null;
}

/** 応力の図: 間引いた三角形の数は図の大きさだけで決まるので、組む前に同じ大きさで 1 回描いて見出しに書く。 */
function stressFigure(field: SolidReportField): ReportFigure {
  const { dropped } = field.draw(0, 0, REPORT_FIGURE_SIZE.width, REPORT_FIGURE_SIZE.height);
  return { caption: solidReportCaption(field.legend.minimum, field.legend.maximum, dropped),
    paths: (left, bottom, width, height) => field.draw(left, bottom, width, height).paths };
}

/**
 * 立体の静解析の報告書(A4 の PDF)を書き出す(J-03c 段 2)。字体を待つ → 組版 → 保存の窓は、梁と同じ共通の道(saveReportPdf)。
 * 字体を待つ間に会話が替わったら保存しない。版は呼び出し元が渡す(currentAppVersion)。
 */
export async function exportSolidReport(appVersion: string, now: () => Date = () => new Date()): Promise<boolean> {
  const state = useAppStore.getState(), session = state.solidAnalysisSession, document = state.document;
  if (session === null) return false;
  const definition = savedSolidDefinition(document), outcome = currentSessionResult(document, session, state.completedGeneration);
  if (definition === undefined || outcome === null) return refuseReport('analysisReport.unavailable');
  return saveReportPdf({
    owner: JSON.stringify([session.ownerId, definition.id]),
    prepare: () => {
      const field = solidReportField(outcome);
      if (field === null) return 'analysisReport.unavailable';
      const exportedAt = now(), figure = stressFigure(field);
      const input: SolidReportInput = { analysisName: t('solidAnalysis.title'), documentName: document.name,
        exportedAt: reportTime(exportedAt), appVersion, definition, outcome };
      return { title: `${document.name} ${t('solidAnalysis.report.title')}`, fileName: `${document.name}-${definition.id}.pdf`,
        exportedAt, pages: outline => buildSolidReport(input, figure, outline) };
    },
    stillCurrent: () => useAppStore.getState().solidAnalysisSession === session,
  });
}
