import { t } from '../i18n/t.js';
import { answerImportUnit } from './exchangeActions.js';

/**
 * 読み込んだファイルの単位を訊く小窓(計画書 docs/plans/P6-入出力.md §0.a-0.6、タスク32b)。
 *
 * 対応要件: FR-802、FR-811、NFR-UX-4(Enter 連打で意味のある結果)、
 * NFR-UX-5(できないことは押す前に断る / 誤操作を招く訊き方をしない)。
 *
 * **STL と OBJ、単位の書かれていない DXF にだけ出る。** どちらの仕様にも長さの単位が
 * 無く、数をそのまま mm として取り込むと 25.4 倍ずれた形になるので、読み込む前に訊く。
 *
 * **確認の窓(`confirm`)ではなく、選ぶボタンを名前のまま並べる。** 2 択を
 * 「OK / キャンセル」で訊くと、どちらがどの単位か覚えていないと誤って選んでしまい、
 * 3 つ目の答え(やめる)も窓の × と区別できない(NFR-UX-5)。
 *
 * Enter は「ミリメートル」(既定。`type="submit"` の 1 つ目のボタン)、Esc は「やめる」。
 * 覆いは作らないので、背後の視点操作はそのまま効く(NFR-UX-2。`ExchangePanel` と同じ作り)。
 */
export function ImportUnitPanel(): React.JSX.Element {
  return (
    <form
      className="pcad-card pcad-import-unit"
      onSubmit={(event) => {
        event.preventDefault();
        // Enter は既定のミリメートル(数をそのまま取り込む、§0.a-0.6 の既定)。
        answerImportUnit('mm');
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          answerImportUnit(null);
        }
      }}
      aria-label={t('exchange.importUnitQuestion')}
    >
      <p className="pcad-import-unit__title">{t('exchange.importUnitQuestion')}</p>
      <div className="pcad-import-unit__actions">
        <button
          type="submit"
          className="pcad-button pcad-button--action pcad-button--primary"
          autoFocus
        >
          {t('exchange.importUnitMillimeter')}
        </button>
        <button
          type="button"
          className="pcad-button pcad-button--action"
          onClick={() => {
            answerImportUnit('inch');
          }}
        >
          {t('exchange.importUnitInch')}
        </button>
        <button
          type="button"
          className="pcad-button pcad-button--action"
          onClick={() => {
            answerImportUnit(null);
          }}
        >
          {t('exchange.cancel')}
        </button>
      </div>
    </form>
  );
}
