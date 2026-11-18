/**
 * 接合チェック(E-09)の一覧。干渉の一覧と同じ所・同じ形に出す(開くと干渉の一覧は閉じる)。
 * 開いている間、文書か表示が替わった時だけ調べ直す(店の refreshAssemblyJointCheck)。自動の確かめを止めた時は理由と「今確かめる」を出す。
 */
import { splitCrossJoints, type FrameJointKind } from '@pointercad/model';
import { useEffect, useMemo } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  FRAME_JOINT_CHECK_TIME_LIMIT_MS, frameJointBrokenRows, frameJointCheckRows, frameJointCheckStopped, frameJointCheckSummary,
  type FrameJointBrokenRow, type FrameJointCheckView,
} from './frameJointCheckView.js';

/** 締結部品の自動判別(E-07)で留められる形(十字は T 2 つに分けて留める)。 */
const FASTENABLE: ReadonlySet<FrameJointKind> = new Set<FrameJointKind>(['L', 'T', 'cross', 'butt']);

/** 文の {名前} を数で埋める。 */
function filled(text: string, values: Readonly<Record<string, number>>): string {
  return Object.entries(values).reduce((out, [name, value]) => out.split(`{${name}}`).join(String(Math.round(value))), text);
}

/** 自動の確かめを止めた理由の文(止めていない時は null)。 */
function stoppedText(view: FrameJointCheckView): string | null {
  if (!frameJointCheckStopped(view)) return null;
  if (!view.result.ok) {
    return filled(t(view.result.reason === 'tooManyMembers' ? 'assembly.jointCheck.stoppedMembers' : 'assembly.jointCheck.stoppedComponents'),
      { count: view.result.count, limit: view.result.limit });
  }
  return filled(t('assembly.jointCheck.stoppedTime'), { ms: view.elapsedMs, limit: FRAME_JOINT_CHECK_TIME_LIMIT_MS });
}

/** 部品が欠けた・部材が無い・接続が見つからない記録の行(E-13): 理由と、作り直す(接続がある時だけ)・記録を外す(部品は残す)。 */
function BrokenRecordRow({ row }: { readonly row: FrameJointBrokenRow }): React.JSX.Element {
  return (
    <div className="pcad-interference__summary" data-testid="joint-check-broken">
      <span>{`${t(`assembly.jointCheck.kind.${row.kind}`)}: ${row.names.join(' × ')}`}</span>
      <strong>{t(`assembly.jointCheck.broken.${row.status}`)}</strong>
      {row.status === 'missingParts' ? (
        <button type="button" className="pcad-button" title={t('assembly.jointCheck.rebuildTooltip')} data-testid="joint-check-rebuild"
          onClick={() => { useAppStore.getState().beginJointBracketSwap(row.id); }}>{t('assembly.jointCheck.rebuild')}</button>
      ) : null}
      <button type="button" className="pcad-button" title={t('assembly.jointCheck.detachTooltip')} data-testid="joint-check-detach"
        onClick={() => { useAppStore.getState().detachJointRecord(row.id); }}>{t('assembly.jointCheck.detach')}</button>
    </div>
  );
}

export function FrameJointCheckPanel(): React.JSX.Element | null {
  const document = useAppStore((state) => state.assembly);
  const view = useAppStore((state) => state.assemblyView);
  const open = useAppStore((state) => state.assemblyJointCheckOpen);
  const check = useAppStore((state) => state.assemblyJointCheck);
  const selectedKey = useAppStore((state) => state.assemblyJointCheckSelectedKey);
  // 文書か表示が替わった時だけ調べ直す(同じ物なら店が前の結果のまま返す)。
  useEffect(() => { if (open) useAppStore.getState().refreshAssemblyJointCheck(false); }, [open, document, view]);
  const names = useMemo(() => new Map(document?.components.map((component): readonly [string, string] => [component.id, component.name]) ?? []),
    [document]);
  const rows = useMemo(() => (check === null ? [] : frameJointCheckRows(check, (id) => names.get(id) ?? id)), [check, names]);
  const broken = useMemo(() => (check === null ? [] : frameJointBrokenRows(check, (id) => names.get(id) ?? id)), [check, names]);
  if (document === null || !open) return null;
  const summary = check === null ? null : frameJointCheckSummary(check);
  const stopped = check === null ? null : stoppedText(check);

  return (
    <section className="pcad-interference" aria-label={t('assembly.jointCheck.title')} data-testid="joint-check">
      <header className="pcad-interference__header">
        <strong>{t('assembly.jointCheck.title')}</strong>
        <button title={t('assembly.jointCheck.closeTooltip')} type="button" className="pcad-button pcad-interference__close"
          aria-label={t('assembly.jointCheck.close')} onClick={() => { useAppStore.getState().closeAssemblyJointCheck(); }}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {stopped === null ? null : (
        <div className="pcad-interference__progress" role="status" data-testid="joint-check-stopped">
          <span>{stopped}{check?.stale === true ? ` ${t('assembly.jointCheck.stale')}` : ''}</span>
          <button type="button" className="pcad-button" title={t('assembly.jointCheck.runNowTooltip')}
            onClick={() => { useAppStore.getState().refreshAssemblyJointCheck(true); }}>{t('assembly.jointCheck.runNow')}</button>
        </div>
      )}
      {summary === null ? null : (
        <p className="pcad-interference__summary" data-testid="joint-check-summary">{filled(t('assembly.jointCheck.summary'),
          { none: summary.none, oneSided: summary.oneSided, rigid: summary.rigidGroup, members: summary.unfastenedMembers })}</p>
      )}
      {summary !== null && rows.length === 0 ? <p className="pcad-interference__empty">{t('assembly.jointCheck.allFastened')}</p> : null}
      <div className="pcad-interference__rows">
        {rows.map((row) => (
          <div key={row.key} className="pcad-interference__summary">
            <button title={t('assembly.jointCheck.rowTooltip')} type="button" className="pcad-interference__row"
              aria-pressed={selectedKey === row.key} data-testid="joint-check-row"
              onClick={() => { useAppStore.getState().selectAssemblyJointCheck(row.key); }}>
              <span>{`${t(`assembly.jointCheck.kind.${row.kind}`)}: ${row.names.join(' × ')}`}</span>
              <strong>{t(`assembly.jointCheck.fastening.${row.fastening}`)}</strong>
            </button>
            {FASTENABLE.has(row.kind) ? (
              <button type="button" className="pcad-button" title={t('assembly.jointCheck.fastenTooltip')} data-testid="joint-check-fasten"
                onClick={() => { useAppStore.getState().beginJointBracket(splitCrossJoints([row.joint]).map((joint) => joint.id)); }}>
                {t('assembly.jointCheck.fasten')}</button>
            ) : null}
          </div>
        ))}
      </div>
      {broken.length === 0 ? null : (
        <div className="pcad-interference__rows" aria-label={t('assembly.jointCheck.brokenTitle')}>
          <strong>{t('assembly.jointCheck.brokenTitle')}</strong>
          {broken.map((row) => <BrokenRecordRow key={row.id} row={row} />)}
        </div>
      )}
    </section>
  );
}
