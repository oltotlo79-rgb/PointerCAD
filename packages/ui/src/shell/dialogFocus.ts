/**
 * その場の窓のフォーカス(C-03): 開いた時に窓の中へ焦点を入れ、閉じた時に開いた元へ戻す。キーボードだけで使う人が、窓を閉じた後に
 * 元の場所から続けられるようにする(点検の懸念 c)。決まりの本体は dialogFocusRules.ts(純関数)で、ここは React と DOM のつなぎ。
 */
import { useEffect, useLayoutEffect, useRef } from 'react';

import {
  enterDialogFocus, forgetMenuOpener, leaveDialogFocus, menuTriggerOf, noteMenuOpener, takeMenuOpener, type FocusScope, type FocusTarget,
} from './dialogFocusRules.js';

/** 窓の中で最初に焦点を入れる候補(使えない欄・隠した欄・tabIndex -1 は除く)。 */
const FOCUSABLE = [
  'button:not([disabled])', 'a[href]', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])', 'textarea:not([disabled])',
  'summary', '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface DialogFocusOptions {
  /** 開いた時に焦点を入れる物(無ければ窓の中の最初の焦点の当たる物)。 */
  readonly initial?: () => FocusTarget | null;
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
    const opener = enterDialogFocus(scope, active, document.body, optionsRef.current.initial?.() ?? null)
      ?? (scope.owns(active) ? null : takeMenuOpener());
    return () => {
      leaveDialogFocus(scope, document.activeElement, document.body, opener, optionsRef.current.fallback?.() ?? null);
    };
  }, [open]);
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
