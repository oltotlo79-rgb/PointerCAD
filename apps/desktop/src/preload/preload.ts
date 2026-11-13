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
  prepareOcctTransport: (): Promise<unknown> => ipcRenderer.invoke('pcad:prepareOcctTransport'),
  saveExport: (name: string, kind: string, bytes: Uint8Array, requestId?: string): Promise<unknown> =>
    requestId === undefined ? ipcRenderer.invoke('pcad:saveExport', name, kind, bytes)
      : ipcRenderer.invoke('pcad:saveExport', name, kind, bytes, requestId),
  cancelExportSave: (requestId: string): Promise<unknown> => ipcRenderer.invoke('pcad:cancelExportSave', requestId),
  openExport: (token: string): Promise<unknown> => ipcRenderer.invoke('pcad:openExport', token),
  openCamTool: (tool: string): Promise<unknown> => ipcRenderer.invoke('pcad:openCamTool', tool),
  /**
   * 「開く」の開始(2026-11-13: バイト列を 1 回で受け取らず、本体が決めた大きさに区切って受け取る)。本体が窓を出し、
   * 答えは `{ readId, name, size, chunkBytes }` か null(取り消し)。readId は一時的な識別子で、実パスは含めない。
   * 本文は `readPcadOpenChunk` で区切りごとに受け取る(全体をここで受けると、世界の境目で全体が写される)。
   */
  beginPcadOpen: (kind?: 'part' | 'assembly' | 'drawing' | 'all'): Promise<unknown> => ipcRenderer.invoke('pcad:openBegin', kind),
  /** 区切りの 1 回分。通し番号は 0 から。答えはその回のバイト列。 */
  readPcadOpenChunk: (readId: string, index: number): Promise<unknown> => ipcRenderer.invoke('pcad:openChunk', readId, index),
  /** 全部受け取った後の終わり。本体が読む途中の変化が無いことを確かめて閉じる。答えは上書き先の候補の token(実パスは含めない)。 */
  finishPcadOpen: (readId: string): Promise<unknown> => ipcRenderer.invoke('pcad:openFinish', readId),
  /** 途中の「開く」をやめる(本体が開いたままのファイルを閉じる)。 */
  abortPcadOpen: (readId: string): Promise<unknown> => ipcRenderer.invoke('pcad:openAbort', readId),
  /**
   * 読み直しの開始。読込の Worker へ並びを移した後に中身が要った時だけ使う。渡すのは終わりで受け取った token だけで、
   * 本体は開いた時と同じファイルの時だけ答える(答えは開始と同じ形。本文は readPcadOpenChunk で受け取る)。
   */
  rereadPcadOpen: (token: string): Promise<unknown> => ipcRenderer.invoke('pcad:openReread', token),
  /** 読み終えた部品について、開いた先を上書き先に確定する。 */
  confirmSaveTarget: (token: string): Promise<unknown> =>
    ipcRenderer.invoke('pcad:confirmTarget', token),
  /** 新しい文書へ替えるとき、確定済み・未確定の保存先を解除する。 */
  clearSaveTarget: (): Promise<unknown> => ipcRenderer.invoke('pcad:clearTarget'),
  /**
   * 「保存」の開始(案B: バイト列を 1 回で送らず、本体が決めた大きさに分けて送る)。本体が保存先を決め、
   * 答えは `{ transferId, chunkBytes }` か null(取り消し)。分けるのは画面の側(desktopFileGateway.ts)で、
   * ここは大きな並びを受け取らない(全体をここへ渡すと、世界の境目で全体が写される)。
   */
  beginPcadSave: (suggestedName: string, saveAs: boolean, kind: 'part' | 'assembly' | 'drawing',
    totalBytes: number): Promise<unknown> => ipcRenderer.invoke('pcad:saveBegin', suggestedName, saveAs, kind, totalBytes),
  /** 分けた 1 回分。通し番号は 0 から、照合値は中身の SHA-256(16 進)。答えは受けたら true。 */
  sendPcadSaveChunk: (transferId: string, index: number, bytes: Uint8Array, sha256: string): Promise<unknown> =>
    ipcRenderer.invoke('pcad:saveChunk', transferId, index, bytes, sha256),
  /** 確定。答えは保存したファイル名か null(保存先が途中で解除された)。 */
  commitPcadSave: (transferId: string): Promise<unknown> => ipcRenderer.invoke('pcad:saveCommit', transferId),
  /** 途中の保存を捨てる(本体の一時ファイルを消す。保存先には触れない)。 */
  abortPcadSave: (transferId: string): Promise<unknown> => ipcRenderer.invoke('pcad:saveAbort', transferId),
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
  saveFileAs: (fileName: string, kind: string, bytes: Uint8Array, requestId?: string): Promise<unknown> =>
    requestId === undefined ? ipcRenderer.invoke('pcad:saveAs', fileName, kind, bytes)
      : ipcRenderer.invoke('pcad:saveAs', fileName, kind, bytes, requestId),
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
