import { test } from '@playwright/test';
import { assembly1000HostFlow } from './assembly1000HostFlow.js';
import { disableFilePickers } from './boltedJointTestSupport.js';

/**
 * Own limit of this one test (Root's decision 2026-10-25 for EX12 W01; playwright.config.ts keeps its 180 s default for
 * every other test): the flow generates 1000 distinct definitions three times (open, reopen and a cancelled third open)
 * and checks interference 5 times; the real kernel needed about 0.13 s per definition (0.3 s for a box with a boolean
 * hole) in the io unit test of the same table. Each single recompute still waits at most recompute.ts
 * KERNEL_TIMEOUT_MS, and the flow judges every stage time against requirements §5.2 (EX12 W02).
 */
const HOST_1000_TEST_TIMEOUT_MS = 900_000;

// The real-drawing judgement uses the measuring conditions of the viewport-performance project (playwright.config.ts):
// the WebGL software path SwiftShader that measureViewportFps checks, and no trace recording while measuring. Both are
// browser-level options, so they are set for this file (Playwright refuses them inside a describe group).
test.use({ trace: 'off', launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'] } });

test.describe('EX12 W01 host: 1000 distinct real shapes in one assembly', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opens and draws 1000 distinct definitions, drives two slider groups without moving the other 998, saves and reopens', async ({ page }, info) => {
    test.setTimeout(HOST_1000_TEST_TIMEOUT_MS);
    await disableFilePickers(page);
    await page.goto('/');
    await assembly1000HostFlow(page, info, undefined);
  });
});
