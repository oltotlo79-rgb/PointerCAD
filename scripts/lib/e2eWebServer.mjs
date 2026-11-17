/*
 * 画面検査の組み立て(e2e/playwright.config.ts の webServer)を、流す project に要る側だけに絞る(2026-11-16、統括の決定 案 (b))。
 * 夜の RUN 20261116-225521 は --project=electron --no-deps なのに、使わない web の build と preview まで流し、上限 180 秒に達した。
 * 絞るのは、--project=名前 が全部、知っている project の名前と完全に一致し、かつ --no-deps がある時だけ。
 * それ以外(--project が無い・知らない名前・glob・空白で区切った --project・desktop と web の混在・--no-deps 無し)は両方を組み立てる。
 * 外部検査(scripts/check.ps1 -CIStage E2E -E2EShard k/6)と手元の全体検査は --project を付けないか混ぜるので、今までどおり両方。
 * 使う側(electron なら desktop、web の project なら web)は毎回組み立て直すので、古い組み立てで検査が通る事は無い。
 */

/** Electron を起動する project(apps/desktop/dist を使う。baseURL と preview は使わない)。 */
export const E2E_DESKTOP_PROJECTS = Object.freeze(['startup-electron', 'electron']);
/** ブラウザーで preview を開く project(apps/web/dist を使う)。 */
export const E2E_WEB_PROJECTS = Object.freeze(['viewport-performance', 'functional', 'startup-firefox', 'firefox']);
/** Web と Electron の両方を使う project(応答の検査。chromium・firefox・electron の版を 1 つの project で流す)。絞らない。 */
export const E2E_BOTH_PROJECTS = Object.freeze(['response-performance']);

const PROJECT_OPTION = '--project';

/** 流す project に要る組み立て('desktop' | 'web' | 'both')。argv は Playwright の主の処理の process.argv。 */
export function e2eBuildTargets(argv) {
  if (!argv.includes('--no-deps')) return 'both';
  const names = [];
  for (const value of argv) {
    // 空白で区切った形は、後ろの値が project か spec かを読み違えるので絞らない(安全な側)。
    if (value === PROJECT_OPTION) return 'both';
    if (value.startsWith(`${PROJECT_OPTION}=`)) names.push(value.slice(PROJECT_OPTION.length + 1));
  }
  if (names.length === 0) return 'both';
  if (names.every(name => E2E_DESKTOP_PROJECTS.includes(name))) return 'desktop';
  if (names.every(name => E2E_WEB_PROJECTS.includes(name))) return 'web';
  return 'both';
}

/** 組み立ての命令と、済んだ事の見分け方(url か、desktop だけの時は済んだ印の行)。 */
export function e2eWebServer(targets, port, readyScript) {
  const desktop = 'pnpm --filter @pointercad/desktop run build';
  const web = `pnpm --filter @pointercad/web run build && pnpm --filter @pointercad/web run preview --port ${port} --strictPort --host 127.0.0.1`;
  if (targets === 'desktop') {
    return { command: `${desktop} && node "${readyScript}"`, wait: { stdout: /^PCAD_E2E_DESKTOP_BUILD_READY$/mu } };
  }
  return { command: targets === 'web' ? web : `${desktop} && ${web}`, url: `http://127.0.0.1:${port}` };
}
