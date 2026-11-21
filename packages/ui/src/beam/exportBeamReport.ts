import { toPdfPages } from '@pointercad/drawing';
import { drawingFont } from '../drawing/drawingFont.js';
import { saveFileAsThrough } from '../file/fileGateway.js';
import { hasSaveRecoveryCopy } from '../file/saveFailure.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { buildBeamReport, type BeamReportInput } from './beamReport.js';
import { beamDefinition, type BeamSession } from './beamSession.js';
import { beamSourceIsCurrent } from './beamSource.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

/** 検証した形が今のままで、静解析の結果がある時だけ書き出せる(釦の押せる条件と同じ)。 */
export function canExportBeamReport(session: BeamSession, reviewedIsCurrent: boolean): boolean {
  return reviewedIsCurrent && session.status !== 'running' && session.result?.kind === 'oofem-linear-beam-3d';
}

const twoDigits = (value: number): string => String(value).padStart(2, '0');

/** 見出しに出す書き出しの日時(その場の時刻。年-月-日 時:分)。 */
function beamReportTime(date: Date): string {
  return `${String(date.getFullYear())}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} `
    + `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
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
  return { analysisName: session.analysisId, documentName: reviewed.document.name, exportedAt: beamReportTime(exportedAt),
    appVersion, members: session.members, conditions: prepared.document, result };
}

const exporting = new Set<string>();

function refuse(key: MessageKey): false {
  useAppStore.getState().setFileMessage({ key, failed: true });
  return false;
}

/**
 * 梁の静解析の報告書(A4 の PDF)を書き出す。字体を待つ → 組版 → toPdfPages → 保存の窓(図面の PDF の書き出しと同じ道)。
 * 字体を待つ間に会話が替わったら保存しない。版は呼び出し元が渡す(currentAppVersion)。
 */
export async function exportBeamReport(appVersion: string, now: () => Date = () => new Date()): Promise<boolean> {
  const state = useAppStore.getState(), session = state.beamSession;
  if (session === null) return false;
  if (session.reviewed === null || !canExportBeamReport(session, beamSourceIsCurrent(session.reviewed, state))) {
    return refuse('beam.report.unavailable');
  }
  const owner = JSON.stringify([session.ownerId, session.analysisId]);
  if (exporting.has(owner)) return false;
  exporting.add(owner);
  try {
    const exportedAt = now();
    const input = reportInput(session, appVersion, exportedAt);
    if (input === null) return refuse('beam.report.unavailable');
    if (await drawingFont.load() !== 'ready') return refuse('beam.report.fontFailed');
    if (useAppStore.getState().beamSession !== session) return false;
    const pdf = toPdfPages(buildBeamReport(input, drawingFont.outline),
      { title: `${input.documentName} ${t('beam.report.title')}`, creationDate: exportedAt.toISOString() });
    if (!pdf.ok) return refuse('beam.report.failed');
    return await saveFileAsThrough(state.fileGateway, `${input.documentName}-${input.analysisName}.pdf`, 'pdf', pdf.bytes);
  } catch (error) {
    return refuse(hasSaveRecoveryCopy(error) ? 'file.saveRecoveryCopyRetained' : 'beam.report.failed');
  } finally {
    exporting.delete(owner);
  }
}
