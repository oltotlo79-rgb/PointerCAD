import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expect, type ElectronApplication, type PlaywrightWorkerArgs, type TestInfo } from '@playwright/test';
import { KERNEL_TIMEOUT_MS } from './recompute.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requireDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const requireTest = createRequire(import.meta.url);
const requirePlaywright = createRequire(requireTest.resolve('@playwright/test/package.json'));
const requireCore = createRequire(requirePlaywright.resolve('playwright/package.json'));
const electronLoader = join(dirname(requireCore.resolve('playwright-core/package.json')), 'lib/server/electron/loader.js');

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
  const profile = join(directory, 'profile');
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
require(${JSON.stringify(join(root, 'apps/desktop/dist/main/main.cjs'))});
`);
  // Explicit WebGL software rendering works without a physical GPU on hosted CI.
  // Keep the same path in local real-Electron tests; never pass this opt-in to the product launcher.
  // https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/swiftshader.md
  const app = await playwright._electron.launch({ executablePath: executable,
    args: ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', entry], cwd: root, timeout: 30_000 });
  return { app, directory };
}
