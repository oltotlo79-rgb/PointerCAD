import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { DrawingPrintOptions } from '@pointercad/ui/print-settings';

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
  saveExport: (name: string, kind: string, bytes: Uint8Array): Promise<unknown> => ipcRenderer.invoke('pcad:saveExport', name, kind, bytes),
  openExport: (token: string): Promise<unknown> => ipcRenderer.invoke('pcad:openExport', token),
  openCamTool: (tool: string): Promise<unknown> => ipcRenderer.invoke('pcad:openCamTool', tool),
  /** 「開く」。答えは `{ name, bytes, saveTargetToken }` か null。token に実パスは含めない。 */
  openPcad: (kind?: 'part' | 'assembly' | 'drawing' | 'all'): Promise<unknown> => ipcRenderer.invoke('pcad:open', kind),
  /** 読み終えた部品について、開いた先を上書き先に確定する。 */
  confirmSaveTarget: (token: string): Promise<unknown> =>
    ipcRenderer.invoke('pcad:confirmTarget', token),
  /** 新しい文書へ替えるとき、確定済み・未確定の保存先を解除する。 */
  clearSaveTarget: (): Promise<unknown> => ipcRenderer.invoke('pcad:clearTarget'),
  /** 「保存」。答えは保存したファイル名か null(取り消し)。 */
  savePcad: (suggestedName: string, bytes: Uint8Array, saveAs: boolean,
    kind?: 'part' | 'assembly' | 'drawing'): Promise<unknown> =>
    ipcRenderer.invoke('pcad:save', suggestedName, bytes, saveAs, kind),
  /** 上書き先を覚えているか。答えは真偽。 */
  hasSaveTarget: (): Promise<unknown> => ipcRenderer.invoke('pcad:hasTarget'),
  /**
   * 種類を選んで「開く」(P6 計画書 タスク4)。答えは `{ name, kind, bytes }` か null。
   * **パスは含まれない**(NFR-SE-1)。
   */
  openFile: (kinds: readonly string[]): Promise<unknown> =>
    ipcRenderer.invoke('pcad:openAny', kinds),
  /**
   * 種類を選んで「書き出す」。答えは書けたかどうかの真偽で、**名前もパスも返さない**
   * (NFR-SE-1)。呼ぶたびに名前を訊く(上書き先を覚えない。§0.a-0.4)。
   */
  saveFileAs: (fileName: string, kind: string, bytes: Uint8Array): Promise<unknown> =>
    ipcRenderer.invoke('pcad:saveAs', fileName, kind, bytes),
  /**
   * 印刷する(P6 計画書 タスク29)。渡すのは PNG のバイト列だけで、
   * 答えは印刷できたかどうかの真偽(取り消しは false)。**名前もパスも渡さない**(NFR-SE-1)。
   */
  print: (bytes: Uint8Array, options?: DrawingPrintOptions): Promise<unknown> => options === undefined
    ? ipcRenderer.invoke('pcad:print', bytes) : ipcRenderer.invoke('pcad:print', bytes, options),
  /**
   * 窓を閉じるときの未保存の確認(レビュー R03)。本体の `apps/desktop/src/main/closeGuard.ts` と
   * チャンネル名をそろえる。画面が用意と文言を知らせるまで、本体は閉じるのを止めない。
   */
  closeGuardReady: (texts: unknown): Promise<unknown> => ipcRenderer.invoke('pcad:closeGuardReady', texts),
  /** 未保存の有無が変わったことを本体へ知らせる(OS の終了要求を止めるかの判断に使う)。 */
  reportUnsavedWork: (unsaved: boolean): Promise<unknown> => ipcRenderer.invoke('pcad:closeGuardState', unsaved),
  /**
   * 本体からの「閉じてよいか」の問合せを受ける。渡すのは問合せの番号(文字列)だけで、
   * IPC の event は画面へ渡さない。戻り値の関数で受けるのをやめる。
   */
  onCloseRequest: (listener: (requestId: string) => void): (() => void) => {
    const receive = (_event: IpcRendererEvent, requestId: unknown): void => {
      if (typeof requestId === 'string') listener(requestId);
    };
    ipcRenderer.on('pcad:closeRequest', receive);
    return () => { ipcRenderer.removeListener('pcad:closeRequest', receive); };
  },
  /** 本体の窓で「保存して閉じる・保存せずに閉じる・戻る」を出させる。答えは 'save'・'discard'・'cancel'。 */
  chooseCloseAction: (requestId: string): Promise<unknown> => ipcRenderer.invoke('pcad:closeChoice', requestId),
  /** 問合せに答える。close が true なら本体が窓を閉じる。 */
  answerCloseRequest: (requestId: string, close: boolean): Promise<unknown> =>
    ipcRenderer.invoke('pcad:closeAnswer', requestId, close),
});
