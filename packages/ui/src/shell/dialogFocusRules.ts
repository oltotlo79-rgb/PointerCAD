/**
 * その場の窓のフォーカスの決まり(C-03)。DOM に頼らない純関数にして、単体(node の環境)で小さな偽物で確かめる。
 * React の口と DOM のつなぎは dialogFocus.ts。
 *
 * - 開いた時: 焦点が窓の中に無ければ中へ入れ、開いた元を覚える。
 * - 閉じた時: 焦点が窓の中に残るか body へ落ちた(窓の中身が消えた)時だけ、開いた元(消えていれば代わり)へ戻す。窓の外へ移した焦点は奪わない。
 * - メニューの項目から開いた窓: 項目はメニューと一緒に消えるので、そのメニューを開く釦(印 data-menu-trigger)を開いた元にする。
 *   どのメニューも同じ形(項目は .pcad-menu__panel の中、釦は同じ .pcad-menu の中で印を持つ)なので、窓ごとの特別扱いはしない。
 */

/** 焦点を置ける物(HTMLElement のうち、ここで使う所だけ)。 */
export interface FocusTarget {
  focus(): void;
  readonly isConnected: boolean;
}

/** 窓の箱: その物が窓の中にあるか、窓の中で最初に焦点を入れる候補。 */
export interface FocusScope {
  readonly owns: (node: unknown) => boolean;
  readonly first: () => unknown;
}

function isFocusTarget(value: unknown): value is FocusTarget {
  return typeof value === 'object' && value !== null && 'focus' in value && typeof value.focus === 'function' && 'isConnected' in value;
}

/**
 * 焦点を持っていた物が、文書から外れた物か。Firefox は、焦点のある物を文書から外しても blur を出さず、activeElement に外した物が
 * 残る事がある(メニューの項目を選ぶと、項目は一覧と一緒に外れる)。外れた物は焦点を失った物として扱い、body と同じにする。
 */
function isDetached(active: unknown): boolean {
  return isFocusTarget(active) && !active.isConnected;
}

/**
 * 開いた時: 焦点が窓の中に無ければ、initial(無ければ窓の中の最初の焦点の当たる物)へ入れる。
 * 閉じた時の戻り先(開いた元)は、この関数を呼ぶ前に、開く前の焦点から dialogOpenerOf で決める。
 */
export function enterDialogFocus(scope: FocusScope, active: unknown, initial: FocusTarget | null): void {
  if (scope.owns(active)) return;
  const first = initial ?? scope.first();
  if (isFocusTarget(first)) first.focus();
}

/**
 * 閉じた時: 焦点が窓の中に残っているか、body へ落ちている(文書から外れた物に残っている)時だけ、開いた元へ戻す。開いた元が消えている時は
 * fallback へ。窓の外へ焦点が移っている時は何もしない。
 */
export function leaveDialogFocus(scope: FocusScope, active: unknown, body: unknown, opener: FocusTarget | null,
  fallback: FocusTarget | null): void {
  if (!(active === null || active === body || isDetached(active) || scope.owns(active))) return;
  const target = opener?.isConnected === true ? opener : fallback?.isConnected === true ? fallback : null;
  target?.focus();
}

/** 押した物から、その物を含むメニューの、印のある釦。メニューの項目でなければ null。 */
export function menuTriggerOf(item: { closest(selectors: string): { querySelector(selectors: string): unknown } | null }): FocusTarget | null {
  if (item.closest('.pcad-menu__panel') === null) return null;
  const trigger = item.closest('.pcad-menu')?.querySelector('[data-menu-trigger]');
  return isFocusTarget(trigger) ? trigger : null;
}

/**
 * 項目を押した時に覚えた釦。次に開いた窓が 1 回使う。項目の後にファイルを選ぶ・書き出すなどを待ってから開く窓(部品を置く・加工ソフトへ
 * 渡す)も使えるよう、押下の処理の後も残し、メニューの外の押下・キー(利用者がほかの事を始めた印)で忘れる。
 */
let menuOpener: FocusTarget | null = null;

/** メニューの項目を押した時: 釦を覚える。 */
export function noteMenuOpener(trigger: FocusTarget | null): void {
  if (trigger !== null) menuOpener = trigger;
}

/** メニューの外の押下・キー: 覚えた釦を忘れる(関係の無い押下・近道の後に開いた窓が使わないように)。 */
export function forgetMenuOpener(): void {
  menuOpener = null;
}

/** 覚えた釦を 1 回だけ渡して忘れる(開いた窓が dialogOpenerOf を通して使う)。 */
function takeMenuOpener(): FocusTarget | null {
  const trigger = menuOpener;
  menuOpener = null;
  return trigger;
}

/**
 * 閉じた時の戻り先(開いた元)を、開く前に焦点を持っていた物から決める(開いた元を返す口はこの 1 つ)。焦点が窓の中にあれば null。
 * body・文書から外れた物・焦点の置けない物は戻り先にせず(メニューの項目が消えて焦点が落ちた時)、押したメニューの釦(覚えていれば。
 * 1 回で忘れる)を返す。useDialogFocus と、showModal を自分で呼ぶ窓(dialogFocus.ts の rememberDialogOpener)が、この同じ決まりを使う。
 */
export function dialogOpenerOf(scope: FocusScope, active: unknown, body: unknown): FocusTarget | null {
  if (scope.owns(active)) return null;
  return active !== body && isFocusTarget(active) && active.isConnected ? active : takeMenuOpener();
}
