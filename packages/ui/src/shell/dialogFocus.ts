/**
 * その場の窓のフォーカス(C-03): 開いた時に窓の中へ焦点を入れ、閉じた時に開いた元へ戻す。キーボードだけで使う人が、窓を閉じた後に
 * 元の場所から続けられるようにする(点検の懸念 c)。決まりの本体は dialogFocusRules.ts(純関数)で、ここは React と DOM のつなぎ。
 */
import { useEffect, useLayoutEffect, useRef } from 'react';

import {
  dialogOpenerOf, enterDialogFocus, forgetMenuOpener, leaveDialogFocus, menuTriggerOf, noteMenuOpener, type FocusScope, type FocusTarget,
} from './dialogFocusRules.js';

/** 窓の中で最初に焦点を入れる候補(使えない欄・隠した欄・tabIndex -1 は除く)。 */
const FOCUSABLE = [
  'button:not([disabled])', 'a[href]', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])', 'textarea:not([disabled])',
  'summary', '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface DialogFocusOptions {
  /** 開いた時の焦点。省略時は最初の候補、'managed' は窓自身が欄の選択まで行う時。 */
  readonly initial?: (() => FocusTarget | null) | 'managed';
  /** 開いた元が消えた時に焦点を戻す物(例: 設定の一覧から開いた窓は、一覧と一緒に消えるボタンの代わりに歯車)。 */
  readonly fallback?: () => FocusTarget | null;
}

/**
 * その場の窓に、開いた時・閉じた時の焦点の決まりを付ける。windowOf は今の窓の箱(開いている間に中身の form が替わる窓〔規格部品の窓の
 * 分類ごとの形〕も、毎回今の箱を返す)。開け閉め(open)が変わった時だけ動くので、開いたまま中身が替わっても焦点は動かさない。
 * 閉じる時の処理は、窓の中身を外した直後(layout の片付け)に行う。
 */
export function useDialogFocus(windowOf: () => HTMLElement | null, open: boolean, options: DialogFocusOptions = {}): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const windowRef = useRef(windowOf);
  windowRef.current = windowOf;
  useLayoutEffect(() => {
    const element = windowRef.current();
    if (!open || element === null) return undefined;
    const scope: FocusScope = {
      owns: (node) => node instanceof Node && (windowRef.current() ?? element).contains(node),
      first: () => element.querySelector(FOCUSABLE),
    };
    const active = document.activeElement;
    // 開いた元が無い(メニューの項目が消えて焦点が body へ落ちた)時は、押したメニューの釦を開いた元にする。
    const opener = dialogOpenerOf(scope, active, document.body);
    const initial = optionsRef.current.initial;
    if (initial !== 'managed') enterDialogFocus(scope, active, initial?.() ?? null);
    return () => {
      leaveDialogFocus(scope, document.activeElement, document.body, opener, optionsRef.current.fallback?.() ?? null);
    };
  }, [open]);
}

/**
 * showModal を自分で呼ぶ窓(開いた時の焦点は showModal と窓の側に任せる)の、閉じた時の焦点の戻し。showModal の前に呼んで開いた元を
 * 覚え、返す関数を窓を閉じた後に呼ぶ。決まりは useDialogFocus と同じ(dialogOpenerOf・leaveDialogFocus): body を戻り先にせず、
 * メニューの項目から開いた時はメニューを開く釦へ戻し、窓の外へ移した焦点は奪わない。
 */
export function rememberDialogOpener(dialog: HTMLElement | null): () => void {
  const scope: FocusScope = { owns: (node) => dialog !== null && node instanceof Node && dialog.contains(node), first: () => null };
  const opener = dialogOpenerOf(scope, document.activeElement, document.body);
  return () => { leaveDialogFocus(scope, document.activeElement, document.body, opener, null); };
}

let trackingUsers = 0;
const insideMenuPanel = (target: EventTarget | null): boolean => target instanceof Element && target.closest('.pcad-menu__panel') !== null;
const onMenuClick = (event: MouseEvent): void => {
  if (event.target instanceof Element) noteMenuOpener(menuTriggerOf(event.target));
};
/** メニューの外の押下・キーは、利用者がほかの事を始めた印なので、覚えた釦を忘れる(項目の Enter・押下はメニューの中なので忘れない)。 */
const onOtherInput = (event: Event): void => {
  if (!insideMenuPanel(event.target)) forgetMenuOpener();
};

/** メニューの項目の押下を見張る(メニューの部品が 1 つでも出ている間だけ。捕捉の段なので、項目の押下の処理より前に釦を覚える)。 */
export function useMenuOpenerTracking(): void {
  useEffect(() => {
    if (trackingUsers === 0) {
      globalThis.addEventListener('click', onMenuClick, true);
      globalThis.addEventListener('pointerdown', onOtherInput, true);
      globalThis.addEventListener('keydown', onOtherInput, true);
    }
    trackingUsers += 1;
    return () => {
      trackingUsers -= 1;
      if (trackingUsers === 0) {
        globalThis.removeEventListener('click', onMenuClick, true);
        globalThis.removeEventListener('pointerdown', onOtherInput, true);
        globalThis.removeEventListener('keydown', onOtherInput, true);
      }
    };
  }, []);
}
