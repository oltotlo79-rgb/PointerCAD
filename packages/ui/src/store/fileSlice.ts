/**
 * ファイルのスライス(口・名前・保存済みの控え・自動保存・復元の問い合わせ)。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 */

import type { AutoSaver } from '@pointercad/io';
import type { PartDocument } from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { FileGateway } from '../file/fileGateway.js';
import type { MessageKey } from '../i18n/t.js';
import type { AppState } from './appState.js';

/**
 * ファイル操作の結果を帯へ 1 行で出すための知らせ(FR-806、NFR-UX-5)。
 *
 * 成功(`failed: false`)は「保存しました」のような短い一言、失敗(`failed: true`)は
 * 理由そのもの(`file.error.*` など)を入れる。理由の文はそれだけで何が起きたかが
 * 分かる書き方にしてあるので、見出しを足して二重に言わない。
 * 文書が変わったら用済みなので消す(`applyDocument` / `undo` / `redo` / `resetDocument`)。
 */
export interface FileMessage {
  readonly key: MessageKey;
  readonly failed: boolean;
}

/**
 * 起動時に出す「前回の作業が残っています」の案内(FR-805、§0.a-0.12)。
 *
 * 中身そのもの(控えの `.pcad`)はここへ持たない。案内に出すのは時刻と名前だけで、
 * 実際の読み直しは「復元する」を押したときに保管庫から改めて行う(`attachAutoSave.ts`)。
 * 出していないものを記憶に抱え込まないため。
 */
export interface RestorePrompt {
  /** 控えを書いた時刻(ISO 8601)。表示は現地時刻に直す。 */
  readonly savedAt: string;
  /** 控えの部品の名前。 */
  readonly documentName: string;
  /** この版では読めず、復元の代わりに控えを書き出せる状態。省略時は従来どおり復元できる。 */
  readonly unrecoverable?: boolean;
  /** 復元できない理由の文言キー。`unrecoverable` のときだけ案内へ出す。 */
  readonly reasonKey?: MessageKey;
}

/**
 * 保存していない変更を失う操作の前の確認で選ばれた答え(w91a)。デスクトップ版の窓を閉じる前の
 * 確認(`unsavedChangesGuard.ts` の `CloseChoice`)と同じ 3 つにそろえる。
 */
export type DiscardChoice = 'save' | 'discard' | 'cancel';

/**
 * 画面の中に出している確認(w91a)。ブラウザー標準の `confirm` はデスクトップ版で英語の
 * OK/Cancel になり、日本語の画面から浮くので使わない(lint が拒否する)。
 */
export interface DiscardConfirmRequest {
  /** 何を失うかを述べる文(`file.discardConfirm` など)。 */
  readonly messageKey: MessageKey;
  /** 答えを返す。呼ぶのは `answerDiscardConfirm` だけ。 */
  readonly resolve: (choice: DiscardChoice) => void;
}

/** ファイルのスライスが持つ欄と操作。 */
export interface FileSlice {
  /**
   * ファイルの読み書きの口(§2.10)。既定はブラウザ用で、デスクトップ版が
   * `setFileGateway` で差し替える(UI から `apps/` を import できないため)。
   */
  readonly fileGateway: FileGateway;
  /** 開いている(または保存した)ファイルの名前。まだ保存していなければ null。 */
  readonly fileName: string | null;
  /**
   * 最後に保存した文書。これと `document` の中身が違えば「保存していない変更がある」
   * (判定は `hasUnsavedChanges`)。一度も保存していなければ null。
   */
  readonly savedDocument: PartDocument | null;
  /**
   * いまの絵をサムネイルの PNG にする手立て(§0.a-0.18)。ビューポートが自分を
   * 差し出し、片付けで null へ戻す。用意できていなければサムネイルなしで保存する。
   */
  readonly captureThumbnail: (() => Uint8Array | null) | null;
  /**
   * いまの絵を**印刷用の 1 コマ**(PNG の data URL)にする手立て(FR-810、FR-908、
   * P6 §2.11、タスク33)。`captureThumbnail` と同じくビューポートが差し出し、
   * 片付けで null へ戻す。用意できていなければ印刷を断る(NFR-UX-5)。
   *
   * **サムネイルの口とは別にする。** サムネイルは 256 画素の正方形で下地も画面と同じ
   * 暗い色だが、印刷は長辺 2000 画素・**白い下地**でなければならない(FR-908
   * 「印刷の見た目は表示テーマの影響を受けない」)。
   */
  readonly capturePrintFrame: (() => string | null) | null;
  /** ファイル操作の結果の知らせ。出すものが無ければ null。 */
  readonly fileMessage: FileMessage | null;
  /**
   * 自動保存の控えを書く人(FR-805)。起動時に `startAutoSave` が差し出し、
   * 片付けで取り下げる。まだ用意できていなければ null。
   *
   * ストアへ置くのは、手で保存できたときに控えを消す(`savePart`)のと、復元の案内カードの
   * ボタン(`AppShell.tsx`)が同じ 1 人を使う必要があるため。口を配り歩くと、どこかで
   * 別の控えを掴んで「消したはずのものが残る」ことになる。
   */
  readonly autoSaver: AutoSaver | null;
  /** 起動時の復元の案内(§0.a-0.12)。出すものが無ければ null。 */
  readonly restorePrompt: RestorePrompt | null;
  /**
   * 答えを待っている確認(w91a)。無ければ null。**文書を作り直しても消さない**(確認を出した
   * 手続きが答えを待っているため)。確認は 1 つずつで、新しい確認が来たら前の確認は「戻る」で終える。
   */
  readonly discardConfirm: DiscardConfirmRequest | null;

  // 動作を変える口はメソッド宣言ではなくプロパティ関数型で書く。メソッド宣言だと
  // useAppStore((state) => state.setX) のように取り出したとき @typescript-eslint/unbound-method
  // に触れるため(計画書 P1 §0.a-0.12、docs/報告記録.md 2026-09-02 15:28 の残件②)。
  /** ファイルの読み書きの口を差し替える(デスクトップ版の入口が呼ぶ)。 */
  readonly setFileGateway: (gateway: FileGateway) => void;
  /** 開いているファイルの名前と、最後に保存した文書を差し替える。 */
  readonly setFileState: (fileName: string | null, savedDocument: PartDocument | null) => void;
  /** サムネイルの作り手を差し出す・取り下げる(ビューポートが呼ぶ)。 */
  readonly setCaptureThumbnail: (capture: (() => Uint8Array | null) | null) => void;
  /** 印刷用の 1 コマの作り手を差し出す・取り下げる(FR-810。ビューポートが呼ぶ)。 */
  readonly setCapturePrintFrame: (capture: (() => string | null) | null) => void;
  /** ファイル操作の結果を帯へ出す・消す。 */
  readonly setFileMessage: (message: FileMessage | null) => void;
  /** 自動保存の控えを書く人を差し出す・取り下げる(`startAutoSave` が呼ぶ)。 */
  readonly setAutoSaver: (saver: AutoSaver | null) => void;
  /** 復元の案内を出す・閉じる。 */
  readonly setRestorePrompt: (prompt: RestorePrompt | null) => void;
  /** 画面の中の確認を出し、選ばれた答えを返す(w91a)。前の確認が残っていれば「戻る」で終える。 */
  readonly requestDiscardConfirm: (messageKey: MessageKey) => Promise<DiscardChoice>;
  /** 出している確認に答えて閉じる。確認が無ければ何もしない。 */
  readonly answerDiscardConfirm: (choice: DiscardChoice) => void;
  /**
   * 別名保存(FR-812、P6 §0.a-0.37、タスク28)。**いま開いている部品を新しい名前で保存し、
   * 以後の保存先をその新しい名前へ切り替える。元のファイルには何も書かない。**
   *
   * 中身は既存の「保存」に `saveAs = true` を渡すだけで、新しい書き込みの筋道は作らない
   * (口が `savePcad(..., saveAs: true)` で必ず場所を訊き、書けた先を次の上書き先として
   * 覚え直す。Web 版・デスクトップ版とも既にそう振る舞う)。取り消されたときは
   * 保存先も名前も変わらない。ツールバーへ出す入口はタスク33。
   */
  readonly saveDocumentAs: () => Promise<void>;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(ファイル)。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type FileInitialState = Pick<
  FileSlice,
  | 'fileGateway'
  | 'fileName'
  | 'savedDocument'
  | 'captureThumbnail'
  | 'capturePrintFrame'
  | 'fileMessage'
  | 'autoSaver'
  | 'restorePrompt'
>;

export const createFileSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<FileSlice, keyof FileInitialState>
> = (set, get) => ({
  discardConfirm: null,
  requestDiscardConfirm: (messageKey) => new Promise<DiscardChoice>((resolve) => {
    // 同時に 2 つは出さない。前の確認を待っている手続きは「戻る」を受け取り、何も失わずに止まる。
    get().discardConfirm?.resolve('cancel');
    set({ discardConfirm: { messageKey, resolve } });
  }),
  answerDiscardConfirm: (choice) => {
    const pending = get().discardConfirm;
    if (pending === null) return;
    set({ discardConfirm: null });
    pending.resolve(choice);
  },
  setFileGateway: (fileGateway) => {
    set({ fileGateway });
  },
  setFileState: (fileName, savedDocument) => {
    set({ fileName, savedDocument });
  },
  setCaptureThumbnail: (capture) => {
    set({ captureThumbnail: capture });
  },
  setCapturePrintFrame: (capture) => {
    set({ capturePrintFrame: capture });
  },
  setFileMessage: (fileMessage) => {
    set((state) => ({
      fileMessage,
      // 保存・開くなどが成功したら、古い断りはもう関係ない知らせなので消す
      // (§0.a-0.23 ⑦)。失敗のときは残す(利用者はまだその理由を解消していない)。
      faceErrorKey:
        fileMessage !== null && !fileMessage.failed ? null : state.faceErrorKey,
      solidErrorKey:
        fileMessage !== null && !fileMessage.failed ? null : state.solidErrorKey,
    }));
  },
  setAutoSaver: (autoSaver) => {
    set({ autoSaver });
  },
  setRestorePrompt: (restorePrompt) => {
    set({ restorePrompt });
  },
  saveDocumentAs: async () => {
    /*
     * 保存の手続き(`partFile.ts`)は逆にこのストアを読むので、上で静的に読むと
     * ストア → 手続き → ストアの輪になる。呼ばれたときに読めば輪にならない
     * (`AppShell.tsx` がビューポートを遅れて読むのと同じ書き方)。
     */
    const { createDefaultPartFileDeps, savePart } = await import('../file/partFile.js');
    await savePart(createDefaultPartFileDeps(), true);
  },
});
