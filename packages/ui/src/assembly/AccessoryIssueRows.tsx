/**
 * 接合チェックの一覧の「付け直せない付属の部品」の塊(A3。統括の決定 2026-11-19 Q-A3a・Q-A3b)。店は記録のある文書を入れるたびに付属を本体の端へ
 * 付け直すが、付け直せない時(合うキャップが無い・2 つ以上ある)は元の位置のまま入れるので、ここに本体の名前と理由を出す。欄・釦は無い。
 */
import { accessoryIssues, type AssemblyDocument } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';

const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  noMatchingCap: 'assembly.accessory.issueNoMatchingCap', ambiguousCap: 'assembly.accessory.issueAmbiguousCap',
  noMatchingRing: 'assembly.accessory.issueNoMatchingRing', noMatchingFitting: 'assembly.accessory.issueNoMatchingFitting',
};

export function AccessoryIssueRows({ document, nameOf }: { readonly document: AssemblyDocument; readonly nameOf: (componentId: string) => string }):
React.JSX.Element | null {
  const issues = accessoryIssues(document);
  if (issues.length === 0) return null;
  return (<div className="pcad-interference__rows" aria-label={t('assembly.accessory.issueTitle')} data-testid="joint-check-accessory">
    <strong>{t('assembly.accessory.issueTitle')}</strong>
    {issues.map((issue) => <p key={issue.recordId} className="pcad-interference__summary">
      {`${nameOf(issue.hostComponentId)}: ${t(REASON_KEYS[issue.reason] ?? 'assembly.accessory.issueOther')}`}</p>)}
  </div>);
}
