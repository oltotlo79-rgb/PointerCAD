import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { FIREFOX_GRAPHICS_PREFS } from './firefoxLaunch.js';
import { e2eBuildTargets, e2eWebServer } from '../scripts/lib/e2eWebServer.mjs';

// Dedicated measurements require the existing owned-input runners, never ordinary CI.
const MEASUREMENT_FILES = {
  w21: ['occt-compile-reuse-solid.spec.ts', 'electron-occt-compile-reuse.spec.ts'],
  w22: ['math-pace-slow-function-plot.spec.ts', 'electron-math-pace-slow.spec.ts'],
  ex12host: ['assembly-1000-host.spec.ts', 'electron-assembly-1000-host.spec.ts'],
} as const;
const measurementMode = process.env.PCAD_DEDICATED_MEASUREMENT;
if (measurementMode !== undefined && measurementMode !== 'w21' && measurementMode !== 'w22' && measurementMode !== 'ex12host') {
  throw new Error('Unknown dedicated measurement mode');
}
// Manual screenshots isolate cold mathematics preparation; ordinary CI keeps its two workers.
const manualCapture = process.env.PCAD_MANUAL_CAPTURE;
if (manualCapture !== undefined && manualCapture !== '1') {
  throw new Error('Unknown manual capture mode');
}
if (manualCapture === '1' && (process.env.CI !== undefined || measurementMode !== undefined)) {
  throw new Error('Manual capture cannot run in CI or dedicated measurement mode');
}
const selectedMeasurement = measurementMode === undefined ? null : MEASUREMENT_FILES[measurementMode];
const requestedSpecs = process.argv.filter(value => value.endsWith('.spec.ts')).map(value => value.split(/[\\/]/u).at(-1));
if (selectedMeasurement !== null && requestedSpecs.some(name => !selectedMeasurement.some(file => file === name))) {
  throw new Error('Dedicated measurement mode and explicit spec disagree');
}
const dedicatedFiles = Object.values(MEASUREMENT_FILES).flat();
const dedicatedMatch = (electron: boolean) => selectedMeasurement?.filter(name => name.startsWith('electron-') === electron)
  .map(name => `**/${name}`);

const ELECTRON_TEST_FILE = /electron-[\w-]+\.spec\.ts$/u;
const PREVIEW_PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PREVIEW_PORT}`;
const VIEWPORT_PERFORMANCE_TEST = /見分けられる同じ箱50個|4分割の実描画性能|100フィーチャー・三面図・50寸法|板金100段の実描画性能|自動作図実行中の実描画性能/u;
// 読込・保存の中の100入力の応答(p95)を測る6本(chromium・firefox・electron)。2本の worker で並ぶと、読込と保存の検査が
// CPU を取り合って p95 が上限を超えた(A-20、2026-11-17 の実測: 1 本ずつなら p95 21.7〜32.5ms、並ぶと 77.2〜207.4ms。
// 外部検査 43755857947・43622465673 の windows 第3組)。専用の project で 1 本ずつ流す。上限・測り方・回数は変えない。
// 名前はパスの区切りの直後からファイル名の全体で一致させる(末尾だけの一致で別の spec が入らないように)。
const RESPONSE_PERFORMANCE_TEST = /(?:^|[\\/])(?:electron-|firefox-)?(?:read-response|save-performance)\.spec\.ts$/u;

const FIREFOX_USE = {
  ...devices['Desktop Firefox'],
  // Same OS-provided software renderer locally and on Windows CI without a GPU.
  // Mozilla: modules/libpref/init/StaticPrefList.yaml, webgl.angle.force-warp.
  launchOptions: { firefoxUserPrefs: FIREFOX_GRAPHICS_PREFS },
};
// 外部検査(GitHub Actions)の中だけ、落ちた操作の検査をその場で 1 回やり直す(利用者の決定 2026-11-17「その場で 1 回やり直す」)。
// 見分けは scripts/check.ps1 の $isRunningOnCI と同じ CI=true。手元(diag.py は CI を消し、全体検査も CI を持たない)は 0 のまま。
// やり直しで通った検査は Playwright の list の最後のまとめに「N flaky」と名前が出る(外部検査のログに残る)。2 回とも落ちれば失敗。
const CI_RETRIES = process.env.CI === 'true' ? 1 : 0;
// 外部検査の 1 組目(--shard=1/N)だけ、全体を 1 本の worker で流す(利用者の決定 2026-11-19「設定だけで直す」)。応答の検査
// (response-performance)は project の workers: 1 でも、もう 1 本の worker で functional が同時に走り、キーを送る往復が遅れた
// (2026-11-19 の Windows の第1組の E04 32MiB 読込。製品の遅れの証拠は無い)。応答の検査は依存でない project の先頭なので、
// Playwright の組分け(件数で前から切る)で全部 1 組目に入る。全部が 1 組目に入り、1 組目だけ 1 本になる事は
// packages/test-utils/src/ciSharding.test.ts が実際の --list で確かめる。手元(diag.py・全体検査)は --shard を渡さず 2 本のまま。
function shardOption(argv: readonly string[]): string | null {
  for (const [index, value] of argv.entries()) {
    if (value.startsWith('--shard=')) return value.slice('--shard='.length);
    if (value === '--shard') return argv[index + 1] ?? null;
  }
  return null;
}
const FIRST_SHARD_ALONE = (shardOption(process.argv) ?? '').startsWith('1/');
const WEB_STARTUP_TEST = /(?:^|[\\/])(?:smoke|firefox-graphics)\.spec\.ts$/u;
const FIREFOX_GRAPHICS_TEST = /(?:^|[\\/])firefox-graphics\.spec\.ts$/u;
const ELECTRON_STARTUP_TEST = /electron-startup\.spec\.ts$/u;

export default defineConfig({
  testDir: './tests',
  // 50MB の WASM を読み込むため、通常の Web アプリより長く待つ(この2値は変えない)。
  timeout: 180_000,
  // 個々の expect の上限。カーネル読込み等の長い待ちは spec 側で明示しているため、
  // ここは通常の失敗検出を速くするために短くする(P2 タスク1、P1 の残件)。
  expect: { timeout: 30_000 },
  // Publish each failing test as an annotation, so public CI evidence contains its
  // cause even when downloading the complete Actions log requires authentication.
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  /*
   * 並列で走らせる本数を 2 に固定する(指定が無いと Playwright は「論理コア数 ÷ 2」を選び、
   * この機械(12 コア)では 6 になる)。検査は 1 本ごとに新しいブラウザ文脈を作り、文脈ごとに
   * 50MB の OCCT WASM をコンパイルし直すため、**初回のカーネル読み込みが 1 並列の 17〜30 秒から
   * 6 並列では 55〜80 秒へ延び**、spec 側の待ちの上限(KERNEL_TIMEOUT_MS = 60 秒)を越えて落ちた
   * (push #14 の赤 3 本。docs/報告記録.md 2026-09-06 12:04)。初回読み込みを含む待機は利用者承認の90秒とする。
   * FPS・図面応答の測定は先行projectで専有し、残りの操作検査は2並列で実行する。
   */
  // 外部検査の 1 組目だけ 1(上の FIRST_SHARD_ALONE。応答の検査を、ほかの検査と同時に走らせない)。
  workers: FIRST_SHARD_ALONE ? 1 : 2,
  // 上限つきの測定(描画・応答)と起動の確かめの project は、下で 0 に戻す(やり直しで通すと測定の意味が変わる)。
  retries: CI_RETRIES,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    // TestConfig直下ではなくPlaywrightのuseへ置く。遮られたclick/fillを3分待たせない。
    // カーネルや再計算の長い待機はexpect.poll側で明示しており、この上限には含まれない。
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'viewport-performance',
      testMatch: /(?:assembly|p8-drawing|drawing-performance|sheet-performance|script-performance)\.spec\.ts$/u,
      workers: 1,
      retries: 0,
      grep: VIEWPORT_PERFORMANCE_TEST,
      // GPUの有無を揃え、別テストのWASM初期化とCPUを奪い合わずに測る。
      // 50部品・実描画回数・releasePerformanceの下限は手元でもCIでも同じ。
      // swiftshaderだけではブラウザの合成まで仮想GPUへ入り、Linuxでコンテキスト
      // 切替が律速になる。WebGL専用のソフトウェア経路を明示する(実測5.0→42.3fps)。
      // Chromium公式: https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md
      // opt-inはこのローカル検査ブラウザだけ。Web/desktopの製品起動には渡さない。
      use: { trace: 'off', launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'] } },
    },
    {
      // 応答の検査どうしを重ねない(上の RESPONSE_PERFORMANCE_TEST)。ほかの project の依存にはしない(依存にすると CI の6組の
      // 全部で重ねて流れる)。firefox・electron の版は spec の中の browserName と起動で動く(functional・electron の中と同じ形)。
      // ほかの project の検査とも重ねない: この project を依存でない project の先頭に置いたままにし(CI の組分けで全部 1 組目に
      // 入る)、1 組目は全体を 1 本で流す(上の FIRST_SHARD_ALONE)。
      name: 'response-performance', testMatch: RESPONSE_PERFORMANCE_TEST, workers: 1, retries: 0,
      dependencies: ['viewport-performance'],
    },
    {
      name: 'functional',
      ...(manualCapture === '1' ? { workers: 1 } : {}),
      testIgnore: [ELECTRON_TEST_FILE, FIREFOX_GRAPHICS_TEST, RESPONSE_PERFORMANCE_TEST, ...(selectedMeasurement === null ? dedicatedFiles.map(name => `**/${name}`) : [])],
      ...(selectedMeasurement === null ? {} : { testMatch: dedicatedMatch(false) }),
      grepInvert: VIEWPORT_PERFORMANCE_TEST,
      dependencies: ['viewport-performance'],
    },
    {
      // CI run 43102593955 e2e (ubuntu-latest, 5)、2026-11-12: firefox-graphicsが描画を禁じて起こすFirefoxとsmokeのFirefoxの起動が重なり、
      // smoke:11のFirefoxがWebGLを作れなかった。2つのspecを同時に流さない。
      name: 'startup-firefox', testMatch: WEB_STARTUP_TEST, use: FIREFOX_USE, workers: 1, retries: 0,
      dependencies: ['viewport-performance'],
    },
    {
      name: 'firefox',
      // Electron専用ケースの末尾がWebの名前と重なっても、Firefox枠へ混入させない。
      testIgnore: [ELECTRON_TEST_FILE, WEB_STARTUP_TEST, ...(selectedMeasurement === null ? dedicatedFiles.map(name => `**/${name}`) : [])],
      // 実カーネル・保存再読込・復元・製作図・F1・CSPを既存の同じ操作で検査する。
      // 板金の操作検査は分割した新ファイルも自動的に対象へ入れる。
      // 名前はパスの区切りの直後からファイル名の全体で一致させ、末尾だけの一致で別の spec が増えないようにする。板金は sheet- で始まる名前だけ。
      testMatch: /(?:^|[\\/])(?:smoke|solid|solid-finite-worker|solid-finite-authoring|solid-finite-field|analysis-entry|analysis-result-binding|analysis-static-connections|analysis-connections-persistence|analysis-bolt-persistence|analysis-advanced|analysis-plastic-persistence|plastic-bar-plateau|analysis-fatigue-native|analysis-resources|shell-analysis-connections|solid-boundary-authoring|extrude-operation|direct-edit-operations|bolted-joint|bolted-joint-same-holes|fillet-weld|circular-weld|steel-editable-stock|assembly-coupled-drag|assembly-flexible-motion|steel-bend|steel-bend-stock|aluminum-frame-catalog|frame-slot-fastening|frame-joint-check|frame-joint-bracket|frame-joint-swap-stretch|frame-panel|frame-door|frame-door-parts|safety-fence-feet|frame-edge-direct|frame-stroke-line|frame-end-caps|dialog-focus|dialog-focus-assembly|snap-radius|frame-dimension-basis|grid-fixed-placement|dimension-move|dimension-move-pick|place-point|gdt|drawing-recovery|browser-security|sketch-intersections|strength|dwg|surfaces|cam|scripts|math-input|math-high-dpi|history-notes|document-diff|named-save-points|name-search|parameter-search-csv|auto-save-settings|command-registry|tutorial|shortcut-settings|input-bindings|view-controls-stage3|camera-controls-settings|camera-controls-presets|radial-menu|connect-points|canvas|drawing-delete-elements|drawing-navigation|reference-ambiguity|usability-keyboard|offline-routing|offline-editions|function-plot|function-spline-surface|memory-highwater|impact-browser|machining-surface|sheet-[\w-]+|a-math-input|draggable-input-solid|drawing-sheet-expressions|ex18-routes-solid|ex18-surface-sew-solid|expression-math-input|face-offset-solid|fatigue-local-cycle-strength|fatigue-paired-strength|geometry-math-input|named-view-unavailable-smoke|pg5a-solid|planar-machining-surface|properties-input-layout-smoke|startup-failed-overlay-smoke|startup-navigation-smoke|tool-defaults-auto-save-settings|tree-name-search|z-math-input|appearance|assembly|bolt-preload|bolted-joint-tapped|bolted-joint-through-thread|combined-weld-stress|context-reference-cycle-open|context-reference-repair|context-reference-route5|cut-plane-materials|drawing-source-refresh|ex18-math-bracket|ex18-sew-bracket|exchange|fatigue-detail-browser|file-open-rejection|friction-browser|friction-cancel-browser|gdt-all|gdt-position|local-data|math-keyboard|measurement-printcheck-fix02|p4b-command-line|p4b-constraints|p4b-parameters|p4b-timeline|p4b-tracking|p5-cut-mirror|p5-primitive-pick|p6-view|p7-standard-parts|standard-part-search|p8-drawing|parameter-math-name-blur|primitives|semantic-origin-reopen|sketch-connected-1000|sketch-corner-boundary|sketch-extended|sketch|solid-material-authoring|status-guidance|thread|unsaved-reload|viewcube|weld-layer-browser|weld-span-author|welding|workplane-3d)\.spec\.ts$/u,
      ...(selectedMeasurement === null ? {} : { testMatch: dedicatedMatch(false) }),
      grepInvert: VIEWPORT_PERFORMANCE_TEST,
      use: FIREFOX_USE,
      dependencies: ['viewport-performance', 'startup-firefox'],
    },
    {
      name: 'startup-electron', testMatch: ELECTRON_STARTUP_TEST, workers: 1, retries: 0,
      dependencies: ['viewport-performance'],
    },
    {
      name: 'electron',
      testMatch: dedicatedMatch(true) ?? ELECTRON_TEST_FILE,
      testIgnore: [ELECTRON_STARTUP_TEST, RESPONSE_PERFORMANCE_TEST, ...(selectedMeasurement === null ? dedicatedFiles.map(name => `**/${name}`) : [])],
      workers: 1,
      dependencies: ['viewport-performance', 'startup-electron'],
    },
  ],
  webServer: {
    // preview は事前にビルドが必要なため、ビルド→preview の順で実行する。
    // apps/web の preview は COOP/COEP ヘッダーを付ける(vite.config.ts)。
    // --host 127.0.0.1 を明示しないと、この環境の vite preview は IPv6 ループバック(::1)
    // だけに bind し、127.0.0.1 への接続が確立できず webServer の起動待ちがタイムアウトする(実測)。
    // --project=名前 が全部 Electron か全部 Web で --no-deps の時だけ、要る側だけを組み立てる(scripts/lib/e2eWebServer.mjs)。
    // CI と手元の全体検査は --project を付けないか混ぜるので、今までどおり両方を組み立てる。
    ...e2eWebServer(e2eBuildTargets(process.argv), PREVIEW_PORT, fileURLToPath(new URL('../scripts/lib/e2eBuildReady.mjs', import.meta.url))),
    env: { VITE_PCAD_E2E: '1' },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
