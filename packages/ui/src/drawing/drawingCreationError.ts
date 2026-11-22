import { t } from '../i18n/t.js';

/**
 * 図面を作れなかった理由を鍵で運ぶ誤り(0b-5)。文は今までどおり訳した文(t(reason))なので、文を読む受け手には同じ文が届く。
 * 作成の画面は、誤りの文と訳した文を比べて鍵を取り戻さず、この鍵を読む(決まり failure-kind/no-message-text-match)。
 * 鍵は、作成の画面が知らせとして出し分ける 4 つだけ(ほかの理由は「図を作れませんでした」の知らせになる)。
 */
export class DrawingCreationError extends Error {
  constructor(readonly reason: 'drawing.error.partTooLarge' | 'drawing.error.assemblyConstraints'
    | 'drawing.error.selectSource' | 'drawing.error.noSolid') {
    super(t(reason));
  }
}
