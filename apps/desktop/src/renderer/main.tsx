import { PointerCadApp, setFileGateway, t } from '@pointercad/ui';
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

createRoot(container).render(
  <StrictMode>
    <PointerCadApp />
  </StrictMode>,
);
