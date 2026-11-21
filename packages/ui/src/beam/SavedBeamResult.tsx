/**
 * 開いたファイルに保存してあった梁の静解析の結果(J-03b 段 1)。確かめる前だけ出す(確かめた後は、今の結果の欄が同じ結果を出す)。
 * 形を変える確定の後・会話の id や revision が違う時は出さない(古い結果を新しい入力の結果として見せない)。
 * 保存してあった結果を io が出さなかった(指紋の不一致・壊れた中身)時は、開いた文書のままで今の結果がまだ無い間だけ、理由を 1 行出す。
 * 計算に使った入力のまま「入力を文書に反映」して残した結果(J-03d)も、反映した後の文書のままの間だけ、同じ形で出す(文は反映した結果の物)。
 */
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { BeamResults } from './BeamResults.js';
import type { BeamSession } from './beamSession.js';
import { savedBeamResultDropped, shownSavedBeamResult } from './savedBeamResults.js';

export function SavedBeamResult({ session }: { readonly session: BeamSession }): React.JSX.Element | null {
  const assembly = useAppStore((state) => state.assembly);
  const opened = useAppStore((state) => state.assemblyOpenedAnalysisResults);
  const saved = shownSavedBeamResult(session, assembly, opened);
  if (saved === null) {
    return session.result === null && savedBeamResultDropped(assembly, opened)
      ? <p role="status" data-testid="beam-saved-result-dropped">{t('beam.savedResult.dropped')}</p> : null;
  }
  const applied = opened?.origin === 'applied';
  return (
    <section data-testid="beam-saved-result" data-origin={applied ? 'applied' : 'file'}
      aria-label={t(applied ? 'beam.appliedResult.title' : 'beam.savedResult.title')}>
      <p role="status">{applied ? t('beam.appliedResult.status') : t('beam.savedResult.status').replace('{version}', saved.appVersion)}</p>
      <BeamResults result={saved.result} members={session.members} />
    </section>
  );
}
