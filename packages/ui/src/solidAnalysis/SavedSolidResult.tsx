import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { openedSolidNotice, openedSolidResult, SAVED_SOLID_NOTICE_KEYS, type SavedSolidNotice } from './savedSolidResults.js';
import type { SolidAnalysisSession } from './solidAnalysisSession.js';
import { solidResultScalars } from './solidResultScalars.js';

/**
 * The static solid result saved with the opened part (J-03b stage 2). A restored result is the panel's own result and
 * only gets a status line here. A result that could not be restored shows why; a result saved without its solver input
 * (an earlier stage-2 file) shows the values that need no solver input, with the reason.
 */
export function SavedSolidResult({ session }: { readonly session: SolidAnalysisSession }): React.JSX.Element | null {
  const document = useAppStore(state => state.document);
  const opened = useAppStore(state => state.solidOpenedResults);
  const record = useAppStore(state => state.solidSavedRestore);
  const saved = openedSolidResult(document, opened);
  const restore = saved !== undefined && record?.saved === saved ? record.restore : null;
  if (session.result !== null) {
    if (saved === undefined || restore?.kind !== 'restored' || restore.outcome !== session.result) return null;
    // A result kept when the panel was closed is not a saved one yet: its line says so instead of a saved app version.
    return <p role="status" data-testid="solid-saved-result" data-origin={opened?.origin}>{opened?.origin === 'kept'
      ? t('solidAnalysis.savedResult.kept') : t('solidAnalysis.savedResult.status').replace('{version}', saved.appVersion)}</p>;
  }
  const notice: SavedSolidNotice | null = saved === undefined ? openedSolidNotice(document, opened)
    : restore !== null && restore.kind !== 'restored' ? restore.notice : saved.prepared === undefined ? 'noSolverInput' : null;
  if (notice === null) return null;
  const scalars = notice === 'noSolverInput' && saved !== undefined ? solidResultScalars(saved.result) : null;
  return <section aria-label={t('solidAnalysis.savedResult.title')} data-testid="solid-saved-result" data-notice={notice}>
    <p role="status">{t(SAVED_SOLID_NOTICE_KEYS[notice])}</p>
    {scalars === null || saved === undefined ? null : <dl>
      <dt>{t('solidAnalysis.displacement')}</dt><dd>{scalars.maximumDisplacement} mm</dd>
      <dt>{t('solidAnalysis.stress')}</dt><dd>{scalars.maximumVonMises} MPa</dd>
      <dt>{t('solidAnalysis.reaction')}</dt><dd>{scalars.reaction.join(', ')} N</dd>
      <dt>{t('solidAnalysis.energy')}</dt><dd>{saved.result.strainEnergyNmm} N·mm</dd>
      <dt>{t('solidAnalysis.residual')}</dt><dd>{saved.result.maximumRelativeEquilibriumResidual}</dd>
    </dl>}
  </section>;
}
