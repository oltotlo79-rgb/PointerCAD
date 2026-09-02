import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { AlertIcon, MouseIcon } from './icons.js';

/**
 * 下端のステータスバー(要件§7.1、FR-905)。
 *
 * 左は今の状況を1文で伝える(操作ガイド / 計算中 / 失敗)。右は単位を小さな札で常に見せる。
 * 失敗しても操作は止めず、帯の色と文言で知らせる(FR-504、NFR-RE-1)。
 */
export function StatusBar(): React.JSX.Element {
  const isComputing = useAppStore((state) => state.isComputing);
  const errorMessage = useAppStore((state) => state.errorMessage);

  const className =
    errorMessage === null ? 'pcad-statusbar' : 'pcad-statusbar pcad-statusbar--error';

  return (
    <footer className={className}>
      <span className="pcad-statusbar__message" aria-live="polite">
        {errorMessage !== null ? (
          <>
            <AlertIcon size={14} />
            <span className="pcad-statusbar__text">{`${t('statusBar.error')} ${errorMessage}`}</span>
          </>
        ) : isComputing ? (
          <>
            <span className="pcad-spinner" aria-hidden="true" />
            <span className="pcad-statusbar__text">{t('statusBar.loading')}</span>
          </>
        ) : (
          <>
            <MouseIcon size={14} />
            <span className="pcad-statusbar__text">{t('statusBar.ready')}</span>
          </>
        )}
      </span>
      <span className="pcad-statusbar__spacer" />
      <span className="pcad-statusbar__unit">{t('statusBar.unit')}</span>
    </footer>
  );
}
