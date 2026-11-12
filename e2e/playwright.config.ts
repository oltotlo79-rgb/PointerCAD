import { defineConfig, devices } from '@playwright/test';
import { FIREFOX_GRAPHICS_PREFS } from './firefoxLaunch.js';

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

const FIREFOX_USE = {
  ...devices['Desktop Firefox'],
  // Same OS-provided software renderer locally and on Windows CI without a GPU.
  // Mozilla: modules/libpref/init/StaticPrefList.yaml, webgl.angle.force-warp.
  launchOptions: { firefoxUserPrefs: FIREFOX_GRAPHICS_PREFS },
};
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
  workers: 2,
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
      name: 'functional',
      ...(manualCapture === '1' ? { workers: 1 } : {}),
      testIgnore: [ELECTRON_TEST_FILE, FIREFOX_GRAPHICS_TEST, ...(selectedMeasurement === null ? dedicatedFiles.map(name => `**/${name}`) : [])],
      ...(selectedMeasurement === null ? {} : { testMatch: dedicatedMatch(false) }),
      grepInvert: VIEWPORT_PERFORMANCE_TEST,
      dependencies: ['viewport-performance'],
    },
    {
      // CI run 43102593955 e2e (ubuntu-latest, 5)、2026-11-12: firefox-graphicsが描画を禁じて起こすFirefoxとsmokeのFirefoxの起動が重なり、
      // smoke:11のFirefoxがWebGLを作れなかった。2つのspecを同時に流さない。
      name: 'startup-firefox', testMatch: WEB_STARTUP_TEST, use: FIREFOX_USE, workers: 1,
      dependencies: ['viewport-performance'],
    },
    {
      name: 'firefox',
      // Electron専用ケースの末尾がWebの名前と重なっても、Firefox枠へ混入させない。
      testIgnore: [ELECTRON_TEST_FILE, WEB_STARTUP_TEST, ...(selectedMeasurement === null ? dedicatedFiles.map(name => `**/${name}`) : [])],
      // 実カーネル・保存再読込・復元・製作図・F1・CSPを既存の同じ操作で検査する。
      // 板金の操作検査は分割した新ファイルも自動的に対象へ入れる。
      // 名前はパスの区切りの直後からファイル名の全体で一致させ、末尾だけの一致で別の spec が増えないようにする。板金は sheet- で始まる名前だけ。
      testMatch: /(?:^|[\\/])(?:smoke|solid|solid-finite-worker|solid-finite-authoring|solid-finite-field|analysis-entry|analysis-result-binding|analysis-static-connections|analysis-connections-persistence|analysis-bolt-persistence|analysis-advanced|analysis-plastic-persistence|plastic-bar-plateau|analysis-fatigue-native|analysis-resources|shell-analysis-connections|solid-boundary-authoring|extrude-operation|direct-edit-operations|bolted-joint|fillet-weld|circular-weld|steel-editable-stock|assembly-coupled-drag|assembly-flexible-motion|steel-bend|steel-bend-stock|gdt|drawing-recovery|browser-security|sketch-intersections|strength|dwg|surfaces|cam|scripts|math-input|math-high-dpi|history-notes|document-diff|named-save-points|name-search|parameter-search-csv|auto-save-settings|command-registry|tutorial|shortcut-settings|camera-controls-settings|camera-controls-presets|radial-menu|connect-points|canvas|drawing-delete-elements|drawing-navigation|reference-ambiguity|usability-keyboard|offline-routing|offline-editions|function-plot|function-spline-surface|memory-highwater|impact-browser|machining-surface|sheet-[\w-]+|a-math-input|draggable-input-solid|drawing-sheet-expressions|ex18-routes-solid|ex18-surface-sew-solid|expression-math-input|face-offset-solid|fatigue-local-cycle-strength|fatigue-paired-strength|geometry-math-input|named-view-unavailable-smoke|pg5a-solid|planar-machining-surface|properties-input-layout-smoke|startup-failed-overlay-smoke|startup-navigation-smoke|tool-defaults-auto-save-settings|tree-name-search|z-math-input|appearance|assembly|bolt-preload|bolted-joint-tapped|bolted-joint-through-thread|combined-weld-stress|context-reference-cycle-open|context-reference-repair|context-reference-route5|cut-plane-materials|drawing-source-refresh|ex18-math-bracket|ex18-sew-bracket|exchange|fatigue-detail-browser|file-open-rejection|friction-browser|friction-cancel-browser|gdt-all|gdt-position|local-data|math-keyboard|measurement-printcheck-fix02|p4b-command-line|p4b-constraints|p4b-parameters|p4b-timeline|p4b-tracking|p5-cut-mirror|p5-primitive-pick|p6-view|p7-standard-parts|p8-drawing|parameter-math-name-blur|primitives|semantic-origin-reopen|sketch-connected-1000|sketch-corner-boundary|sketch-extended|sketch|solid-material-authoring|status-guidance|thread|unsaved-reload|viewcube|weld-layer-browser|weld-span-author|welding|workplane-3d)\.spec\.ts$/u,
      ...(selectedMeasurement === null ? {} : { testMatch: dedicatedMatch(false) }),
      grepInvert: VIEWPORT_PERFORMANCE_TEST,
      use: FIREFOX_USE,
      dependencies: ['viewport-performance', 'startup-firefox'],
    },
    {
      name: 'startup-electron', testMatch: ELECTRON_STARTUP_TEST, workers: 1,
      dependencies: ['viewport-performance'],
    },
    {
      name: 'electron',
      testMatch: dedicatedMatch(true) ?? ELECTRON_TEST_FILE,
      testIgnore: [ELECTRON_STARTUP_TEST, ...(selectedMeasurement === null ? dedicatedFiles.map(name => `**/${name}`) : [])],
      workers: 1,
      dependencies: ['viewport-performance', 'startup-electron'],
    },
  ],
  webServer: {
    // preview は事前にビルドが必要なため、ビルド→preview の順で実行する。
    // apps/web の preview は COOP/COEP ヘッダーを付ける(vite.config.ts)。
    // --host 127.0.0.1 を明示しないと、この環境の vite preview は IPv6 ループバック(::1)
    // だけに bind し、127.0.0.1 への接続が確立できず webServer の起動待ちがタイムアウトする(実測)。
    command: `pnpm --filter @pointercad/desktop run build && pnpm --filter @pointercad/web run build && pnpm --filter @pointercad/web run preview --port ${PREVIEW_PORT} --strictPort --host 127.0.0.1`,
    env: { VITE_PCAD_E2E: '1' },
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
