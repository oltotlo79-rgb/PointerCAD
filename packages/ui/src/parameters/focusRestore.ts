/** 焦点を戻す先として探せる要素の最小の形(DOM の要素がそのまま当てはまる)。 */
export interface FocusableByLabel {
  getAttribute(name: string): string | null;
  focus(): void;
}

export interface FocusSearchRoot {
  querySelectorAll(selector: string): ArrayLike<FocusableByLabel>;
}

/**
 * 操作の間は欄が無効になり、焦点が文書の外へ落ちる。aria-label が一致する欄を探して焦点を戻す。
 * 見つかって焦点を移せたときだけ true(まだ描画されていなければ false で、呼び出し側は覚えを残す)。
 */
export function focusByAriaLabel(root: FocusSearchRoot | null | undefined, label: string): boolean {
  if (root === null || root === undefined) return false;
  const found = Array.from(root.querySelectorAll('[aria-label]')).find(element => element.getAttribute('aria-label') === label);
  if (found === undefined) return false;
  found.focus();
  return true;
}

/** DOM の要素の中から探す(要素そのものは focus を持つ HTMLElement として引く)。 */
export function focusByAriaLabelIn(element: Element | null | undefined, label: string): boolean {
  if (element === null || element === undefined) return false;
  return focusByAriaLabel({ querySelectorAll: selector => element.querySelectorAll<HTMLElement>(selector) }, label);
}
