import { defineConfig, devices } from '@playwright/test';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIREFOX_GRAPHICS_PREFS } from './firefoxLaunch.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.PCAD_OFFLINE_REPORT;
if (output === undefined) throw new Error('PCAD_OFFLINE_REPORT must name a task folder inside scratchpad/.');
const local = relative(resolve(root, 'scratchpad'), resolve(output));
if (local === '' || isAbsolute(local) || local.startsWith('..')) throw new Error('Offline check output must stay in scratchpad/.');
export default defineConfig({
  testDir: './release', testMatch: 'offlineCandidate.spec.ts', outputDir: resolve(output, 'browser-results'),
  workers: 1, timeout: 300_000, expect: { timeout: 30_000 }, reporter: [['list']],
  use: { viewport: { width: 1440, height: 900 }, actionTimeout: 15_000,
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'offline-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'offline-firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 },
      launchOptions: { firefoxUserPrefs: FIREFOX_GRAPHICS_PREFS } } },
  ],
});
