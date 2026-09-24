import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { expect, type ElectronApplication, type PlaywrightWorkerArgs, type TestInfo } from '@playwright/test';
import { KERNEL_TIMEOUT_MS } from './recompute.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requireDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const requireTest = createRequire(import.meta.url);
const requirePlaywright = createRequire(requireTest.resolve('@playwright/test/package.json'));
const requireCore = createRequire(requirePlaywright.resolve('playwright/package.json'));
const electronLoader = join(dirname(requireCore.resolve('playwright-core/package.json')), 'lib/server/electron/loader.js');

// Electron's userData becomes the root of Chromium's own cache/IndexedDB files, which it
// creates using Windows file APIs that -- unlike Node's fs module -- do not opt into the
// \\?\ long-path prefix, so they are subject to Windows' 260-character MAX_PATH. userData
// used to live under Playwright's per-test output directory (`info.outputPath('native')`),
// nested under this project's diagnostic tool's per-run folder plus the test's own (often
// long, Japanese) title; see the budget comment below for what that broke. Keep userData
// short, fixed, and independent of the test title or output location instead.
const ELECTRON_PROFILE_ROOT = join(root, 'scratchpad', 'temp', 'e');
// Guard rail, not the fix itself: keep this comfortably below Windows' MAX_PATH minus
// Chromium's own deepest subpath below userData, so that if userData ever loses its
// safety margin again (e.g. a deeper checkout path), Electron fails fast and legibly
// before it starts, instead of Chromium failing silently deep inside a cache file. The
// original break (R12, electron-flows.spec.ts) came from IndexedDB/LevelDB:
// "\IndexedDB\app_pointercad_0.indexeddb.leveldb\MANIFEST-000001" (61 characters) pushed
// the full path to 263 when userData lived under Playwright's per-test output directory
// (nested under this project's diagnostic tool's per-run folder plus the test's own long
// Japanese title) -- Node had already created the shorter LOCK/LOG files alongside it, so
// only the longer names failed (scratchpad/claude/agents/w8d-p13-5-electron/progress.md,
// 2026-09-24 07:35). Walking a real profile from this fix's own verification run found an
// even deeper entry: "\Code Cache\electron-preload\<64-hex>-<64-hex>.cache" reaches 164
// characters, rounded up to DEEPEST_CHROMIUM_INTERNAL_PATH below, so USER_DATA_PATH_BUDGET
// = WINDOWS_MAX_PATH - DEEPEST_CHROMIUM_INTERNAL_PATH = 90. That must clear every place
// userData actually lands: ~73 characters at the project root (root + "\scratchpad\temp\e\"
// + a 6-character name); ~87 characters when the whole suite runs from the independent
// copy at "<root>\scratchpad\c3" (same layout, nested one level deeper) -- 87 exceeding
// the old fixed budget of 80 is this fix's own reason for existing (E2E-01b); and ~51
// characters in CI, where actions/checkout puts the root at "D:\a\PointerCAD\PointerCAD"
// instead of a local checkout's deeper path.
const WINDOWS_MAX_PATH = 260;
const DEEPEST_CHROMIUM_INTERNAL_PATH = 170;
const USER_DATA_PATH_BUDGET = WINDOWS_MAX_PATH - DEEPEST_CHROMIUM_INTERNAL_PATH;
// A single test's Electron instance cannot outlive Playwright's own per-test timeout
// (180_000ms, e2e/playwright.config.ts). 15 minutes is a 5x margin past that, so an
// entry this old can only be leftover from an earlier launch, never one still in use.
const STALE_PROFILE_AGE_MS = 15 * 60_000;

function assertUserDataPathBudget(profile: string): void {
  if (profile.length <= USER_DATA_PATH_BUDGET) return;
  throw new Error(`Electronのuserdata絶対パスが長すぎます(${profile.length}文字。上限${USER_DATA_PATH_BUDGET}文字): ${profile}\n`
    + `WindowsのMAX_PATH(${WINDOWS_MAX_PATH}文字)に、ChromiumがuserdataやCode Cacheの下に作る内部ファイル名`
    + `(実測164文字を${DEEPEST_CHROMIUM_INTERNAL_PATH}文字に切り上げ)を足すと超える恐れがあるため、Electron起動前に止めています。`);
}

function createProfileDirectoryName(): string {
  // Kept short on purpose: every character here subtracts directly from the margin
  // Chromium's own subpaths have before hitting Windows' MAX_PATH (see budget comment
  // above). Staleness is judged by sweepStaleElectronProfiles() via the directory's own
  // mtime, so the name itself carries no timestamp.
  return randomUUID().replace(/-/g, '').slice(0, 6);
}

// A test that restarts the app within itself (closes and re-launches, to check a setting or an
// autosaved document survives the restart) must see the same userData both times; a different test,
// or a retried attempt of the same test, must not inherit another attempt's userData. Playwright keeps
// (testInfo.testId, testInfo.retry) stable across repeated launchDesktop() calls within one attempt and
// unique across the whole run, so this process-lifetime Map, keyed by that pair, remembers the first
// call's short directory name for every later call in the same attempt (E2E-01c, 2026-09-24: E2E-01b's
// new random name on every call broke every spec that restarts mid-test -- the second launch could no
// longer see the first launch's settings or autosaved state, e.g. electron-auto-save-settings.spec.ts).
const profileDirectoryByAttempt = new Map<string, string>();

// Exported so electron-profile.spec.ts can check the (testId, retry) keying directly, without
// needing a second real Electron launch just to prove two attempts would get different directories.
export function profileDirectoryFor(info: Pick<TestInfo, 'testId' | 'retry'>): string {
  const key = `${info.testId}#${info.retry}`;
  const existing = profileDirectoryByAttempt.get(key);
  if (existing !== undefined) return existing;
  const profile = join(ELECTRON_PROFILE_ROOT, createProfileDirectoryName());
  profileDirectoryByAttempt.set(key, profile);
  return profile;
}

// Best-effort housekeeping for the short-path profile directories above: since they live
// outside Playwright's own per-test output directory, nothing else clears them. Only
// previous launches' directories are ever removed (never the one this call is about to
// create), and only once they are old enough that no test could still be using them, so
// this can never race a concurrently running Electron instance. A failing test's profile
// therefore survives at least until the next launchDesktop() call, giving the same
// "kept as evidence until superseded" behaviour Playwright's own output directory gives
// passing and failing tests alike. A directory still held by profileDirectoryByAttempt is
// skipped regardless of age, so a restart late in a long test can never race this sweep.
async function sweepStaleElectronProfiles(): Promise<void> {
  let entries: string[];
  try { entries = await readdir(ELECTRON_PROFILE_ROOT); }
  catch { return; }
  const active = new Set([...profileDirectoryByAttempt.values()].map(profile => basename(profile)));
  const cutoff = Date.now() - STALE_PROFILE_AGE_MS;
  await Promise.all(entries.map(async (name) => {
    if (active.has(name)) return;
    const entryPath = join(ELECTRON_PROFILE_ROOT, name);
    try {
      const entryInfo = await stat(entryPath);
      if (entryInfo.mtimeMs < cutoff) await rm(entryPath, { recursive: true, force: true });
    } catch { /* best-effort; already gone, or another sweep is racing this one */ }
  }));
}

export async function openTarget(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [filePath] });
  }, path);
}
export async function saveTarget(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
  }, path);
}
export async function diskFile(path: string): Promise<Buffer> {
  await expect.poll(async () => {
    try { return (await readFile(path)).length; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
      throw error;
    }
  }, { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(100);
  return readFile(path);
}
export async function launchDesktop(playwright: PlaywrightWorkerArgs['playwright'], info: TestInfo) {
  const executable: unknown = requireDesktop('electron');
  if (typeof executable !== 'string') throw new Error('Electron実行ファイルなし');
  const directory = info.outputPath('native');
  await mkdir(directory, { recursive: true });
  await sweepStaleElectronProfiles();
  const profile = profileDirectoryFor(info);
  assertUserDataPathBudget(profile);
  await mkdir(profile, { recursive: true });
  const entry = join(directory, 'entry.cjs');
  // executablePath bypasses Playwright's automatic loader. Install its ready barrier
  // before the product creates a window, so CDP attachment cannot race app startup.
  await writeFile(entry, `require(${JSON.stringify(electronLoader)});
const { app, BrowserWindow } = require('electron');
const startup = { loader: typeof globalThis.__playwright_run === 'function', ready: app.isReady(), windows: BrowserWindow.getAllWindows().length };
if (!startup.loader || startup.ready || startup.windows !== 0) throw new Error('Electron startup barrier missing');
require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'bootstrap.json'))}, JSON.stringify(startup));
app.setPath('userData', ${JSON.stringify(profile)});
// Native desktop input must not enter an automated test window.
// Playwright sends input directly to webContents; the real window still renders.
app.on('browser-window-created', (_event, window) => {
  window.setFocusable(false);
  window.setIgnoreMouseEvents(true);
});
require(${JSON.stringify(join(root, 'apps/desktop/dist/main/main.cjs'))});
`);
  // Explicit WebGL software rendering works without a physical GPU on hosted CI.
  // Keep the same path in local real-Electron tests; never pass this opt-in to the product launcher.
  // https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/swiftshader.md
  const app = await playwright._electron.launch({ executablePath: executable,
    args: ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', entry], cwd: root, timeout: 30_000 });
  try {
    await app.firstWindow();
    // CDP can attach before ready-to-show. Start gestures only after the actual
    // window is shown and its initial main-frame navigation has finished.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window !== undefined && window.isVisible() && !window.webContents.isLoadingMainFrame();
    }), { message: '実Electronの表示と初回の読込が完了すること', timeout: 30_000 }).toBe(true);
    return { app, directory };
  } catch (error) {
    await app.close();
    throw error;
  }
}
