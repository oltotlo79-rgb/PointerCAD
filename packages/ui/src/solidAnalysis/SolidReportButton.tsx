import { currentAppVersion } from '../app/appVersion.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { canExportSolidReport, exportSolidReport } from './exportSolidReport.js';

/** 立体の静解析の報告書(PDF)の釦(J-03c 段 2)。保存した入力の結果がある時だけ押せ、押せない時の訳を title に出す。 */
export function SolidReportButton(): React.JSX.Element {
  const enabled = useAppStore(canExportSolidReport);
  return <button type="button" className="pcad-button" data-testid="solid-report" disabled={!enabled}
    title={t(enabled ? 'analysisReport.guide' : 'solidAnalysis.guide.reportUnavailable')}
    onClick={() => { void exportSolidReport(currentAppVersion() ?? t('analysisReport.versionUnknown')); }}>
    {t('analysisReport.export')}</button>;
}
