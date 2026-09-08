import { useMemo } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { interferenceRows } from './interferenceView.js';

function withCount(key: 'assembly.interference.ignored' | 'assembly.interference.failures', count: number): string {
  return t(key).replace('{count}', String(count));
}

export function AssemblyInterferencePanel(): React.JSX.Element | null {
  const document = useAppStore((state) => state.assembly);
  const open = useAppStore((state) => state.assemblyInterferenceOpen);
  const result = useAppStore((state) => state.assemblyInterferenceResult);
  const selectedKey = useAppStore((state) => state.assemblyInterferenceSelectedKey);
  const progress = useAppStore((state) => state.assemblyInterferenceProgress);
  const checking = useAppStore((state) => state.isCheckingAssemblyInterference);
  const error = useAppStore((state) => state.assemblyInterferenceError);
  const names = useMemo(() => new Map(document?.components.map((component) =>
    [component.id, component.name] as const) ?? []), [document]);
  const rows = useMemo(() => result === null ? []
    : interferenceRows(result, (id) => names.get(id) ?? id), [result, names]);
  if (document === null || !open) return null;
  const ignored = result?.skips.filter((skip) => skip.reason === 'ignored').length ?? 0;

  return (
    <section className="pcad-interference" aria-label={t('assembly.interference.title')}>
      <header className="pcad-interference__header">
        <strong>{t('assembly.interference.title')}</strong>
        <button type="button" className="pcad-button pcad-interference__close"
          aria-label={t('assembly.interference.close')}
          onClick={() => { useAppStore.getState().closeAssemblyInterference(); }}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {checking ? (
        <div className="pcad-interference__progress" role="status">
          <span className="pcad-spinner" aria-hidden="true" />
          <span>{t('assembly.interference.checking')}</span>
          {progress === null ? null : <span>{progress.completedPairs}/{progress.totalPairs}</span>}
        </div>
      ) : null}
      {error === null ? null : <p className="pcad-panel__error" role="alert">{error}</p>}
      {!checking && result !== null && rows.length === 0 ? (
        <p className="pcad-interference__empty">{t(result.cancelled
          ? 'assembly.interference.cancelled' : 'assembly.interference.none')}</p>
      ) : null}
      <div className="pcad-interference__rows">
        {rows.map((row) => (
          <button type="button" className="pcad-interference__row" key={row.key}
            aria-pressed={selectedKey === row.key}
            onClick={() => { useAppStore.getState().selectAssemblyInterference(row.key); }}>
            <span>{row.aName} × {row.bName}</span>
            <strong>{row.volumeText}</strong>
          </button>
        ))}
      </div>
      {result === null ? null : (
        <footer className="pcad-interference__summary">
          <span>{withCount('assembly.interference.ignored', ignored)}</span>
          {result.failures.length === 0 ? null
            : <span>{withCount('assembly.interference.failures', result.failures.length)}</span>}
        </footer>
      )}
    </section>
  );
}
