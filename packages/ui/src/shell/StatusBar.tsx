import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

export function StatusBar(): React.JSX.Element {
  const isComputing = useAppStore((state) => state.isComputing);
  const errorMessage = useAppStore((state) => state.errorMessage);

  const className =
    errorMessage === null ? 'pcad-statusbar' : 'pcad-statusbar pcad-statusbar--error';

  return (
    <div className={className}>
      <span>
        {errorMessage !== null
          ? `${t('statusBar.error')} ${errorMessage}`
          : isComputing
            ? t('statusBar.loading')
            : t('statusBar.ready')}
      </span>
      <span className="pcad-statusbar__spacer" />
      <span>{t('statusBar.unit')}</span>
    </div>
  );
}
