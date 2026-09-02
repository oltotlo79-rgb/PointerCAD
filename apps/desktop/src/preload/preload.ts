import { contextBridge } from 'electron';

/** 画面側へ渡す最小の情報。プラットフォーム固有コードは apps/ 配下だけに置く(rules/04)。 */
contextBridge.exposeInMainWorld('pointercadDesktop', {
  platform: process.platform,
});
