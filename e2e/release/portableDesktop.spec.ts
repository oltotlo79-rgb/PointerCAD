/// <reference lib="dom" />
import { type ChildProcess } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { assertPortableLaunchEnvironment, readPortableLaunchTarget } from '../../scripts/release/portableLaunch.mjs';
import { uiMessage } from '../tests/uiMessages.js';
import { verifyPackagedStartup } from './packagedStartup.js';
import { connectPortable, EXIT_TIMEOUT_MS, LAUNCH_TIMEOUT_MS, pathExists, portableProcesses,
  preparePortableIsolation, remainingPortableTime, startPortable, stopFailedPortable, verifyPortableExtraction,
  type PortableIsolation } from './portableDesktopSupport.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('単一ポータブル exe の展開・窓の準備・正常終了・一時展開物の片付け', async ({ playwright }, info) => {
  // This guard runs before creating folders or starting any executable. It is intentionally not a skip.
  assertPortableLaunchEnvironment(process.env, process.platform);
  const candidatePath = process.env.PCAD_PACKAGED_CANDIDATE;
  if (candidatePath === undefined || candidatePath.trim() === '') throw new Error('PCAD_PACKAGED_CANDIDATE is required.');
  const evidence: Record<string, unknown> = {}, output: string[] = [], errors: string[] = [];
  let isolation: PortableIsolation | undefined, child: ChildProcess | undefined, browser: Browser | undefined, page: Page | undefined;
  let completed = false;
  try {
    const target = await test.step('候補記録から単一 portable exe を選び、中身を照合する', () => readPortableLaunchTarget(resolve(root, candidatePath)));
    evidence.source = { executable: target.executable, candidatePath, version: target.candidate.version, sourceCommit: target.candidate.sourceCommit };
    const isolated = await preparePortableIsolation(root, target.executable);
    isolation = isolated;
    evidence.isolation = isolation;
    const launcher = startPortable(isolated, output);
    child = launcher;
    const lifetime = { exitedAt: 0 };
    launcher.once('exit', () => { lifetime.exitedAt = Date.now(); });
    const exitTimeLeft = (): number => remainingPortableTime(lifetime.exitedAt + EXIT_TIMEOUT_MS);
    evidence.launcherPid = child.pid;
    browser = await test.step('単一 exe そのものを起動して接続する（60秒）', () => connectPortable(playwright, launcher, isolated));
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('Portable browser context is missing.');
    const first = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 30_000 });
    page = first;
    first.on('pageerror', error => { errors.push(error.message); });
    first.on('crash', () => { errors.push('renderer crashed'); });
    await test.step('(a) 窓の表示と最初の読込み（既存の配布検査と同じ上限）', async () => {
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      await first.waitForURL('app://pointercad/index.html', { waitUntil: 'load', timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => first.evaluate(() => document.visibilityState), { timeout: remainingPortableTime(deadline) }).toBe('visible');
      await expect(first.getByRole('button', { name: uiMessage('toolbar', 'toolbar.file.open'), exact: true })).toBeVisible();
      expect(context.pages(), '空の文書の窓が1つだけであること').toHaveLength(1);
    });
    const extraction = await test.step('起動した子の実パスと、実際に展開された配布物の版・全ファイルを照合する',
      () => verifyPortableExtraction(root, isolated, launcher, target.candidate));
    evidence.extraction = extraction;
    await test.step('(c) 主要な画面・3D描画・ビューキューブ・入力・再読込み', async () => {
      await expect(first).toHaveTitle(uiMessage('view', 'app.title'));
      await verifyPackagedStartup(first, info);
      expect(errors, 'pageerror と crash が0件であること').toEqual([]);
    });
    await test.step('(f) 窓を通常終了し、本体と単一 exe が終了コード0で終わる', async () => {
      // No document was changed. Window.close follows BrowserWindow's ordinary close/quit path.
      await first.evaluate(() => { setTimeout(() => { window.close(); }, 0); });
      await expect.poll(() => [launcher.exitCode, launcher.signalCode], { timeout: EXIT_TIMEOUT_MS }).toEqual([0, null]);
      expect(lifetime.exitedAt, '終了の時刻を観測できたこと').toBeGreaterThan(0);
      await expect.poll(() => portableProcesses(isolated.temporary, exitTimeLeft()), { timeout: exitTimeLeft(), intervals: [1_000] }).toEqual([]);
      evidence.exit = { code: launcher.exitCode, signal: launcher.signalCode };
    });
    // v1.0.2 restores the post-exit cleanup (apps/desktop/src/main/portableCleanup.ts), now started as a staged script
    // file with -File instead of the encoded command line Defender blocked in v1.0.0. Judge before this test deletes
    // anything: the isolation folder is removed only after success, below. Both waits share the 30 s after exit.
    await test.step('(g) 終了後30秒以内に当該TEMPのNSIS展開先と片付けの写しが無くなる（終了後の片付け）', async () => {
      await expect.poll(() => pathExists(extraction.directory),
        { timeout: exitTimeLeft(), intervals: [500], message: '当該TEMPのNSIS展開先が終了後30秒以内に無くなること' }).toBe(false);
      await expect.poll(async () => (await readdir(isolated.temporary)).filter(name => name.startsWith('pointercad-cleanup-')),
        { timeout: exitTimeLeft(), intervals: [500], message: '片付けの台本の写しも消えること' }).toEqual([]);
      evidence.extractionRemovedWithinMs = Date.now() - lifetime.exitedAt;
      // The app's cleanup removed it (not something else): its log in the dedicated profile, written last, says so.
      // Waiting for it also keeps the folder removal below from racing the cleanup's final write.
      await expect.poll(async () => (await readFile(join(isolated.userData, 'portable-cleanup.log'), 'utf8').catch(() => ''))
        .includes('"result":"completed"'), { timeout: exitTimeLeft(), intervals: [500], message: '片付けが完了を記録すること' }).toBe(true);
      expect(await readFile(join(isolated.userData, 'portable-cleanup-startup.json'), 'utf8'), '片付けを起動した記録').toContain('"result":"started"');
    });
    completed = true;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (!completed && page !== undefined && !page.isClosed()) {
      await page.screenshot({ path: info.outputPath('portable-desktop-failure.png'), timeout: 30_000 }).catch(() => undefined);
      await page.evaluate(() => { setTimeout(() => { window.close(); }, 0); }).catch(() => undefined);
    }
    if (!completed && child !== undefined && child.exitCode === null && child.signalCode === null) {
      // Preserve a failed check and its extraction. Do not report a forced stop as normal termination.
      await expect.poll(() => child?.exitCode !== null || child?.signalCode !== null, { timeout: EXIT_TIMEOUT_MS }).toBe(true)
        .catch((error: unknown) => { evidence.cleanupFailure = error instanceof Error ? error.message : String(error); });
    }
    if (!completed && child !== undefined && isolation !== undefined) {
      evidence.forcedStopsAfterFailure = await stopFailedPortable(child, isolation.temporary)
        .catch((error: unknown) => [error instanceof Error ? error.message : String(error)]);
    }
    await browser?.close().catch(() => undefined);
    if (isolation !== undefined) {
      evidence.remainingTemporaryEntries = await readdir(isolation.temporary).catch(() => []);
      for (const name of ['portable-cleanup-startup.json', 'portable-cleanup.log']) {
        evidence[name] = await readFile(join(isolation.userData, name), 'utf8').catch(() => null);
      }
    }
    evidence.output = output; evidence.pageErrors = errors; evidence.completed = completed;
    const summary = JSON.stringify(evidence, null, 2);
    await writeFile(info.outputPath('portable-desktop-results.json'), summary + '\n');
    await info.attach('portable-desktop-results', { body: summary, contentType: 'application/json' });
    console.log(`[ポータブルの起動] ${summary}`);
    // A failure keeps the evidence; success removes only this test's already verified isolation folder.
    if (completed && isolation !== undefined) await rm(isolation.base, { recursive: true, force: true });
  }
});
