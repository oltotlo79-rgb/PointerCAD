import { refuseReport, reportTime, saveReportPdf } from '../analysisReport/exportReport.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { buildBeamReport, type BeamReportInput } from './beamReport.js';
import { beamDefinition, type BeamSession } from './beamSession.js';
import { beamSourceIsCurrent } from './beamSource.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

/** 検証した形が今のままで、静解析の結果がある時だけ書き出せる(釦の押せる条件と同じ)。 */
export function canExportBeamReport(session: BeamSession, reviewedIsCurrent: boolean): boolean {
  return reviewedIsCurrent && session.status !== 'running' && session.result?.kind === 'oofem-linear-beam-3d';
}

/**
 * 計算に使った条件を、実行と同じ道(beamDefinition → prepareBeamAnalysis の静解析の枝)で作り直す。
 * 編集すると結果は消える(editBeamSession)ので、結果がある間の下書きは実行の時と同じ。結び付かない時は null。
 */
function reportInput(session: BeamSession, appVersion: string, exportedAt: Date): BeamReportInput | null {
  const { reviewed, result } = session;
  if (reviewed === null || result?.kind !== 'oofem-linear-beam-3d') return null;
  const draft = beamDefinition(session, reviewed, reviewed.document.parameters);
  if (!draft.ok) return null;
  const prepared = prepareBeamAnalysis(reviewed, draft.definition);
  if (!prepared.ok || prepared.kind !== 'static') return null;
  return { analysisName: session.analysisId, documentName: reviewed.document.name, exportedAt: reportTime(exportedAt),
    appVersion, members: session.members, conditions: prepared.document, result };
}

/**
 * 梁の静解析の報告書(A4 の PDF)を書き出す。字体を待つ → 組版 → 保存の窓は、立体と同じ共通の道(saveReportPdf)。
 * 字体を待つ間に会話が替わったら保存しない。版は呼び出し元が渡す(currentAppVersion)。
 */
export async function exportBeamReport(appVersion: string, now: () => Date = () => new Date()): Promise<boolean> {
  const state = useAppStore.getState(), session = state.beamSession;
  if (session === null) return false;
  if (session.reviewed === null || !canExportBeamReport(session, beamSourceIsCurrent(session.reviewed, state))) {
    return refuseReport('analysisReport.unavailable');
  }
  return saveReportPdf({
    owner: JSON.stringify([session.ownerId, session.analysisId]),
    prepare: () => {
      const exportedAt = now(), input = reportInput(session, appVersion, exportedAt);
      return input === null ? 'analysisReport.unavailable' : { title: `${input.documentName} ${t('beam.report.title')}`,
        fileName: `${input.documentName}-${input.analysisName}.pdf`, exportedAt, pages: outline => buildBeamReport(input, outline) };
    },
    stillCurrent: () => useAppStore.getState().beamSession === session,
  });
}
