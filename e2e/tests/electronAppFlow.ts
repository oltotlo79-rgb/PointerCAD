import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, type ElectronApplication, type PlaywrightWorkerArgs, type TestInfo } from '@playwright/test';
import { KERNEL_TIMEOUT_MS } from './recompute.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requireDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

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
  await writeFile(entry, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(profile)});\nrequire(${JSON.stringify(join(root, 'apps/desktop/dist/main/main.cjs'))});\n`);
  const app = await playwright._electron.launch({ executablePath: executable, args: [entry], cwd: root });
  return { app, directory };
}
