import { currentAppVersion } from '../app/appVersion.js';
import { t } from '../i18n/t.js';
import type { BeamSession } from './beamSession.js';
import { canExportBeamReport, exportBeamReport } from './exportBeamReport.js';

/** 梁の静解析の報告書(PDF)の釦。静解析の結果がある時だけ押せ、押せない時の訳を title に出す。 */
export function BeamReportButton({ session, reviewed }: { readonly session: BeamSession; readonly reviewed: boolean }): React.JSX.Element {
  const enabled = canExportBeamReport(session, reviewed);
  return <button type="button" className="pcad-button" data-testid="beam-report" disabled={!enabled}
    title={t(enabled ? 'beam.guide.report' : 'beam.guide.reportUnavailable')}
    onClick={() => { void exportBeamReport(currentAppVersion() ?? t('beam.report.versionUnknown')); }}>
    {t('beam.report.export')}</button>;
}
