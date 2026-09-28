import { attachUnsavedChangesGuard, PointerCadApp, setFileGateway, t, type CloseRequestTarget } from '@pointercad/ui';
import '@pointercad/ui/style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createDesktopFileGateway } from './desktopFileGateway.js';

const container = document.getElementById('root');
if (container === null) {
  // React の起動前に落ちる唯一の箇所。文言の正本は ja.json に置く(NFR-MA-5)。
  throw new Error(t('bootstrap.rootMissing'));
}

/*
 * ファイルの読み書きを OS のダイアログへ差し替える(FR-806、計画書 §2.10)。
 * React を起動する前に済ませる。起動後に差し替えると、最初の描画とその後で
 * ふるまいが変わり得るため。
 * preload の口が無ければ null が返り、ブラウザ用の口のまま動く(要件§1.5 の保険)。
 */
const gateway = createDesktopFileGateway();
if (gateway !== null) {
  setFileGateway(gateway);
}

/*
 * 窓を閉じるときの未保存の確認(レビュー R03)。Web 版と同じ入口へ、preload が出す本体の問合せの口を渡す。
 * 本体は、ここで用意を知らせた後だけ窓の「閉じる」を止めて問い合わせる。口が無い(画面だけを
 * ブラウザーで開いた)ときは取り付けない。形の確認は `typeof` だけで行う(rules/02-禁止事項.md)。
 */
// 口の名前を型の全ての鍵で並べる。口が増えたのに足し忘れると、ここが型の誤りになる。
const CLOSE_REQUEST_METHODS: Readonly<Record<keyof CloseRequestTarget, true>> = {
  closeGuardReady: true, reportUnsavedWork: true, onCloseRequest: true, chooseCloseAction: true, answerCloseRequest: true,
};
function isCloseRequestTarget(value: unknown): value is CloseRequestTarget {
  return typeof value === 'object' && value !== null
    && Object.keys(CLOSE_REQUEST_METHODS).every((name) => typeof Reflect.get(value, name) === 'function');
}
const desktopApi: unknown = Reflect.get(globalThis, 'pointercadDesktop');
if (isCloseRequestTarget(desktopApi)) {
  const stopUnsavedChangesGuard = attachUnsavedChangesGuard(desktopApi);
  import.meta.hot?.dispose(stopUnsavedChangesGuard);
}

createRoot(container).render(
  <StrictMode>
    <PointerCadApp />
  </StrictMode>,
);
