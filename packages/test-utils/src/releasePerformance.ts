/** 2026-09-14利用者承認。適用範囲・実測・改善目標はrequirements §5.2を正とする。
 * 試験専用。端末/CI/環境変数で合格値を切り替えない。
 */
export const RELEASE_SOFTWARE_VIEWPORT_MIN_FPS = 25;
export const RELEASE_DRAWING_OPEN_MAX_MS = 7_500;
/** 初回のWASM取得・展開・初期化を含む画面検査の待機上限。
 * 実計算の500ms/5秒を測る性能検査と、製品の中止・数式期限は別に保持する。
 */
export const RECOMPUTE_TIMEOUT_MS = 90_000;
