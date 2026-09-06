/**
 * 印刷(計画書 docs/plans/P6-入出力.md §2.11、§0.a-0.39、タスク29)。
 *
 * 対応要件: FR-810(印刷)、FR-908(印刷の見た目は表示テーマの影響を受けない)、
 * NFR-RE-1(取り消しで止めない)、NFR-UX-5(できないときは理由を出す)、
 * 要件§1.5(Web 版とデスクトップ版に機能差を作らない)。
 *
 * P6 で印刷するのは**いま見えているビューポートの 1 コマ**だけで、用紙サイズ・向き・部数は
 * OS の印刷ダイアログに任せる(図面そのものの印刷は P8。§0.a-0.39)。
 *
 * 道筋は 2 つある(どちらも利用者から見た操作は同じ、要件§1.5)。
 *  - Web: 印刷用の紙面(見出しと `<img>` 1 枚)を body の末尾へ足し、`appShell.css` の
 *    `@media print` でツールバー・ツリー・プロパティ・ステータスバーを隠して `window.print()`。
 *  - デスクトップ: PNG のバイト列を口(`FileGateway.print`)へ渡す。本体プロセスが
 *    隠しの窓で `webContents.print()` を呼ぶ(`apps/desktop/src/main/main.ts`)。
 *
 * **絵は必ず白い下地の上に描く**(FR-908)。画面がダークでも紙は白い。下地の色は
 * `thumbnail.ts` の `PRINT_BACKGROUND` 1 か所だけが決めていて、テーマの色を読まない。
 *
 * DOM を触るのは `capturePrintPng`(canvas)と `mountPrintSheetIn`(紙面を足す)の 2 つだけで、
 * 「どんな大きさで描くか」「何を組むか」「どう断るか」はすべて純関数へ出してある。
 */

import { t } from '../i18n/t.js';

import type { FileGateway } from './fileGateway.js';
import {
  dataUrlToBytes,
  fillCanvasBackground,
  PRINT_BACKGROUND,
  type CanvasBackground,
} from './thumbnail.js';

/**
 * 印刷する絵の長辺の上限(画素)。
 *
 * 紙の解像度に対して十分な大きさで、なおかつ data URL が長くなりすぎない値にする
 * (デスクトップ版は PNG を data URL にして隠しの窓へ読み込ませるため)。**拡大はしない**ので、
 * ビューポートがこれより小さいときは画面と同じ大きさのまま。
 */
export const PRINT_IMAGE_MAX = 2000;

/** 印刷する絵の大きさ(画素)。 */
export interface PrintImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * 元の絵を、長辺が `max` を超えないように縮めた大きさ。縦横比は保つ。
 *
 * **拡大はしない**(`captureThumbnailPng` と同じ考え方。引き伸ばしても情報は増えない)。
 * 大きさが決められないときは null。
 */
export function printImageSize(
  sourceWidth: number,
  sourceHeight: number,
  max: number = PRINT_IMAGE_MAX,
): PrintImageSize | null {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    !Number.isFinite(max) ||
    max <= 0
  ) {
    return null;
  }
  const scale = Math.min(max / sourceWidth, max / sourceHeight, 1);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

// ---------------------------------------------------------------------------
// 印刷用の紙面の組み立て図(純関数。DOM に触れない)
// ---------------------------------------------------------------------------

/** 紙面の外枠の class 名。`appShell.css` の `@media print` と揃える。 */
export const PRINT_SHEET_CLASS = 'pcad-print-sheet';

/** 印刷する 1 枚ぶんの中身。 */
export interface PrintSheet {
  /** 印刷する絵(PNG の data URL)。 */
  readonly imageDataUrl: string;
  /** 見出しに出す部品の名前。 */
  readonly title: string;
  /** 見出しに添える日時(すでに文字列にしてあるもの)。 */
  readonly printedAt: string;
}

/**
 * 紙面の組み立て図。DOM を作る前に決められることを全部ここへ入れ、
 * 実際に要素を作る `mountPrintSheetIn` はこの図をそのまま写すだけにする
 * (図の正しさは DOM の無い環境でも確かめられる)。
 */
export interface PrintNode {
  readonly tag: 'section' | 'h1' | 'p' | 'img';
  readonly className: string;
  /** 文字を持つ節だけが持つ。 */
  readonly text?: string;
  /** `img` だけが持つ(絵の場所と、絵が出ないときの代わりの文)。 */
  readonly src?: string;
  readonly alt?: string;
  readonly children?: readonly PrintNode[];
}

/**
 * 紙面を組む(§2.11)。**絵 1 枚と、部品名・日時の見出し**だけの簡素な作りにする。
 * 用紙の枠や表題欄は図面(P8)の持ちものなので、ここでは作らない(§0.a-0.39)。
 */
export function buildPrintSheet(sheet: PrintSheet): PrintNode {
  return {
    tag: 'section',
    className: PRINT_SHEET_CLASS,
    children: [
      { tag: 'h1', className: `${PRINT_SHEET_CLASS}__title`, text: sheet.title },
      { tag: 'p', className: `${PRINT_SHEET_CLASS}__date`, text: sheet.printedAt },
      {
        tag: 'img',
        className: `${PRINT_SHEET_CLASS}__image`,
        src: sheet.imageDataUrl,
        // 絵が出ないときに何の絵だったかが分かるようにする(NFR-UX-6)。
        alt: sheet.title,
      },
    ],
  };
}

/** 2 桁に揃える(日時の見出し用)。 */
function twoDigits(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

/**
 * 見出しに添える日時の文字列(`2026-09-06 10:27`)。端末の時刻をそのまま使う。
 *
 * 年月日を `-` で区切る並びにしてあるのは、どの国の読み手でも取り違えないため。
 * 秒は出さない(紙に残す情報として意味が薄い)。
 */
export function formatPrintedAt(date: Date): string {
  const year = String(date.getFullYear());
  const month = twoDigits(date.getMonth() + 1);
  const day = twoDigits(date.getDate());
  const hours = twoDigits(date.getHours());
  const minutes = twoDigits(date.getMinutes());
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// ---------------------------------------------------------------------------
// 印刷の手続き(純関数。実際の DOM と IPC は引数で受け取る)
// ---------------------------------------------------------------------------

/**
 * 印刷の結末。
 *
 * **取り消しは例外にしない**(NFR-RE-1)。断り(`refused`)だけが文言を持ち、
 * 取り消し(`canceled`)は何も出さずに終える(利用者が自分でやめたのだから)。
 */
export type PrintOutcome =
  | { readonly status: 'printed' }
  | { readonly status: 'canceled' }
  | { readonly status: 'refused'; readonly message: string };

/** 印刷に添える見出しの中身。 */
export interface PrintRequest {
  /** 部品の名前(名前が無いときは呼び手が `file.untitled` を入れる)。 */
  readonly title: string;
  /** 日時(`formatPrintedAt` で作った文字列)。 */
  readonly printedAt: string;
}

/** 印刷に要るもの。どれも差し替えられるので、検査は DOM もプリンタも無しで済む。 */
export interface PrintDeps {
  /** 印刷する 1 コマを PNG の data URL で作る。作れなければ null。 */
  readonly capture: () => string | null;
  /** デスクトップ版の印刷の口。無ければ null(Web の道筋を使う)。 */
  readonly printOnDesktop: ((png: Uint8Array) => Promise<boolean>) | null;
  /** 紙面を画面へ出し、**片付ける手**を返す。Web の道筋でだけ使う。無ければ null。 */
  readonly mount: ((sheet: PrintSheet) => () => void) | null;
  /** ブラウザの印刷を呼ぶ。`window.print` が無ければ null。 */
  readonly print: (() => void) | null;
}

/**
 * ビューポートの 1 コマを印刷する(§2.11)。
 *
 * デスクトップ版の口があればそちらを使う(隠しの窓で `webContents.print()`)。無ければ
 * 紙面を足して `window.print()` を呼ぶ。**どちらも無い環境は「印刷できません。」で断る**
 * (NFR-UX-5。印刷の窓が出ないまま何も起きないのが一番分かりにくいため)。
 */
export async function printViewport(
  request: PrintRequest,
  deps: PrintDeps,
): Promise<PrintOutcome> {
  const imageDataUrl = deps.capture();
  if (imageDataUrl === null) {
    return { status: 'refused', message: t('print.noImage') };
  }

  if (deps.printOnDesktop !== null) {
    const png = dataUrlToBytes(imageDataUrl);
    if (png === null) {
      return { status: 'refused', message: t('print.noImage') };
    }
    // 取り消しは false で返る約束(例外にしない。NFR-RE-1)。
    const printed = await deps.printOnDesktop(png);
    return printed ? { status: 'printed' } : { status: 'canceled' };
  }

  if (deps.print === null || deps.mount === null) {
    return { status: 'refused', message: t('print.unavailable') };
  }

  const unmount = deps.mount({ imageDataUrl, title: request.title, printedAt: request.printedAt });
  try {
    deps.print();
  } finally {
    // 印刷の窓を閉じたら紙面は必ず取り除く。残すと画面に大きな絵が居座る。
    unmount();
  }
  // ブラウザは印刷を取り消したかどうかを教えてくれないので、出したところまでを「印刷した」とする。
  return { status: 'printed' };
}

/** `window.print` を持つ相手。使う部分だけを書き写したもの。 */
interface PrintScope {
  readonly print: () => void;
}

function hasPrint(scope: object): scope is PrintScope {
  return 'print' in scope && typeof scope.print === 'function';
}

/**
 * ブラウザの印刷を呼ぶ手。`window.print` が無い環境(古いブラウザ、埋め込みの表示器)は null。
 *
 * 調べる相手を引数で受けるのは、検査から偽の `globalThis` を渡せるようにするため
 * (`fileGateway.ts` の `hasFileSystemAccess` と同じ考え方)。
 */
export function browserPrintOf(scope: object = globalThis): (() => void) | null {
  if (!hasPrint(scope)) {
    return null;
  }
  return (): void => {
    scope.print();
  };
}

/**
 * デスクトップ版の印刷の口。口を持たない(Web 版・古い preload)ときは null。
 *
 * 口を取り出して持たずに毎回 `gateway.print?.(…)` と呼ぶのは、`this` を失わないため。
 * 口が後から消えることは無いが、消えていたら「印刷できなかった」として扱う。
 */
export function desktopPrintOf(
  gateway: FileGateway,
): ((png: Uint8Array) => Promise<boolean>) | null {
  if (gateway.print === undefined) {
    return null;
  }
  return (png: Uint8Array): Promise<boolean> => gateway.print?.(png) ?? Promise.resolve(false);
}

// ---------------------------------------------------------------------------
// DOM を触る部分(ここだけ。上の純関数から呼ばれる形にしてある)
// ---------------------------------------------------------------------------

/**
 * 描き終わった canvas から、印刷用の PNG の data URL を作る(§2.11)。
 *
 * **呼ぶのは絵を描いた直後の同じ同期処理の中**(`captureThumbnailPng` と同じ理由。
 * WebGL の描画バッファは画面へ出した時点で捨てられる)。**下地は必ず白**で塗ってから
 * 絵を写すので、画面のテーマがダークでも紙は白い(FR-908)。
 * 用意ができていない・書き出しに失敗したときは null を返す(例外を投げない)。
 */
export function capturePrintPng(
  source: HTMLCanvasElement,
  max: number = PRINT_IMAGE_MAX,
  background: CanvasBackground = PRINT_BACKGROUND,
): string | null {
  const size = printImageSize(source.width, source.height, max);
  if (size === null) {
    return null;
  }
  try {
    const target = source.ownerDocument.createElement('canvas');
    target.width = size.width;
    target.height = size.height;
    const context = target.getContext('2d');
    if (context === null) {
      return null;
    }
    fillCanvasBackground(context, size.width, size.height, background);
    context.drawImage(source, 0, 0, size.width, size.height);
    return target.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** 紙面を組むのに使う部分だけを書き写した要素(`as` を使わずに絞るため)。 */
interface PrintElement {
  className: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  append(child: unknown): void;
  remove(): void;
}

/** 紙面を足す先。 */
interface PrintDocument {
  createElement(tagName: string): unknown;
  readonly body: { append(node: unknown): void };
}

interface PrintDocumentScope {
  readonly document: PrintDocument;
}

function isRecordLike(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isPrintElement(value: unknown): value is PrintElement {
  return (
    isRecordLike(value) &&
    'setAttribute' in value &&
    typeof value.setAttribute === 'function' &&
    'append' in value &&
    typeof value.append === 'function' &&
    'remove' in value &&
    typeof value.remove === 'function'
  );
}

function isPrintDocument(value: unknown): value is PrintDocument {
  return (
    isRecordLike(value) &&
    'createElement' in value &&
    typeof value.createElement === 'function' &&
    'body' in value &&
    isRecordLike(value.body) &&
    'append' in value.body &&
    typeof value.body.append === 'function'
  );
}

function hasPrintDocument(scope: object): scope is PrintDocumentScope {
  return 'document' in scope && isPrintDocument(scope.document);
}

/** 組み立て図の 1 節を要素にする。作れなければ null(呼び手が紙面ごとあきらめる)。 */
function renderPrintNode(document: PrintDocument, node: PrintNode): PrintElement | null {
  const created = document.createElement(node.tag);
  if (!isPrintElement(created)) {
    return null;
  }
  created.className = node.className;
  if (node.text !== undefined) {
    created.textContent = node.text;
  }
  if (node.src !== undefined) {
    created.setAttribute('src', node.src);
  }
  if (node.alt !== undefined) {
    created.setAttribute('alt', node.alt);
  }
  for (const child of node.children ?? []) {
    const rendered = renderPrintNode(document, child);
    if (rendered === null) {
      return null;
    }
    created.append(rendered);
  }
  return created;
}

/**
 * 紙面を body の末尾へ足す手を作る。`document` が無い相手には null を返す。
 *
 * 返ってくる手を呼ぶと紙面が足され、その戻り値(片付ける手)を呼ぶと取り除かれる。
 * 画面には出ない(`appShell.css` の `.pcad-print-sheet` が `display: none`)。
 * 出るのは印刷のときだけで、そのとき他の 4 区画は `@media print` で隠れている。
 */
export function mountPrintSheetIn(
  scope: object = globalThis,
): ((sheet: PrintSheet) => () => void) | null {
  if (!hasPrintDocument(scope)) {
    return null;
  }
  const { document } = scope;
  return (sheet: PrintSheet): (() => void) => {
    const element = renderPrintNode(document, buildPrintSheet(sheet));
    if (element === null) {
      // 組めなかった。片付けるものも無いので、何もしない手を返す。
      return (): void => {
        // 何もしない。
      };
    }
    document.body.append(element);
    return (): void => {
      element.remove();
    };
  };
}
