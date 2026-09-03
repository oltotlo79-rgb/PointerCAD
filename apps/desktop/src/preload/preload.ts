import { contextBridge, ipcRenderer } from 'electron';

/**
 * 画面側へ渡す最小の口。プラットフォーム固有コードは apps/ 配下だけに置く(rules/04)。
 *
 * `contextIsolation: true` / `sandbox: true` / `nodeIntegration: false` のまま動くので、
 * ここから渡せるのは「文字列」「真偽」「バイト列」と、それらを往復させる関数だけ。
 * ファイルの実体・パス・`fs` そのものは**渡さない**(NFR-SE-1)。
 *
 * チャンネル名は `apps/desktop/src/main/pcadDialogs.ts` の定数と同じ文字列を書いている。
 * あちらから読み込むと本体プロセス専用の `dialog` / `ipcMain` までこの束へ入るため。
 *
 * 返り値の型を `Promise<unknown>` にしてあるのは、`ipcRenderer.invoke` の答えの形を
 * ここでは確かめていないから。形の確認は受け手の
 * `apps/desktop/src/renderer/desktopFileGateway.ts` が1箇所でまとめて行う。
 */
contextBridge.exposeInMainWorld('pointercadDesktop', {
  platform: process.platform,
  /** 「開く」。答えは `{ name, bytes }` か null。 */
  openPcad: (): Promise<unknown> => ipcRenderer.invoke('pcad:open'),
  /** 「保存」。答えは保存したファイル名か null(取り消し)。 */
  savePcad: (suggestedName: string, bytes: Uint8Array, saveAs: boolean): Promise<unknown> =>
    ipcRenderer.invoke('pcad:save', suggestedName, bytes, saveAs),
  /** 上書き先を覚えているか。答えは真偽。 */
  hasSaveTarget: (): Promise<unknown> => ipcRenderer.invoke('pcad:hasTarget'),
});
