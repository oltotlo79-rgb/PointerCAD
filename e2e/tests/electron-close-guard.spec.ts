import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { CLOSE_CONFIRM_BYPASS_ENV, diskFile, launchDesktop, saveTarget } from './electronAppFlow.js';
import { uiMessage } from './uiMessages.js';

/**
 * デスクトップ版の窓を閉じるときの未保存の確認(レビュー R03)を実 Electron で確かめる。
 *
 * 本体の確認の窓(`dialog.showMessageBox`)は OS の窓なので、偽物へ差し替えて、出された
 * ボタンの文言を本体の中に記録し、検査が答えを渡すまで待たせる(答える前に窓が残っている
 * ことを見るため)。×の代わりに `BrowserWindow.close()` を呼ぶ(Electron の説明どおり、
 * 利用者が×を押したのと同じ効果)。
 */

const DIALOG_LOG = '__pcadCloseDialogButtons';
const DIALOG_ANSWER = '__pcadCloseDialogAnswer';

/** 確認の窓を偽物へ替える。出されたボタンを記録し、`answerDialog` まで答えを待たせる。 */
async function holdDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }, [logKey, answerKey]) => {
    const log: string[][] = [];
    const waiting: Array<(response: number) => void> = [];
    Reflect.set(globalThis, logKey, log);
    Reflect.set(globalThis, answerKey, (response: number) => { waiting.shift()?.(response); });
    dialog.showMessageBox = (...args: unknown[]) => {
      const options: unknown = args.at(-1);
      const buttons: unknown = typeof options === 'object' && options !== null ? Reflect.get(options, 'buttons') : undefined;
      log.push(Array.isArray(buttons) ? buttons.map(String) : []);
      return new Promise((resolve) => { waiting.push((response) => { resolve({ response, checkboxChecked: false }); }); });
    };
  }, [DIALOG_LOG, DIALOG_ANSWER] as const);
}

async function answerDialog(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate((_electron, [answerKey, value]) => {
    const answer: unknown = Reflect.get(globalThis, answerKey);
    if (typeof answer !== 'function') throw new Error('確認の窓の偽物がありません');
    Reflect.apply(answer, undefined, [value]);
  }, [DIALOG_ANSWER, response] as const);
}

async function dialogButtons(app: ElectronApplication): Promise<string[][]> {
  return app.evaluate((_electron, key) => {
    const log: unknown = Reflect.get(globalThis, key);
    return Array.isArray(log) ? log.map((buttons: unknown) => (Array.isArray(buttons) ? buttons.map(String) : [])) : [];
  }, DIALOG_LOG);
}

async function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length);
}

/**
 * 利用者が×を押したのと同じく主窓を閉じ、確認の窓が `count` 回目まで出るのを待つ。
 * 前の問合せの答えが本体へ届く前の×は、確認を重ねないために受け流される。届いた後の×で
 * 新しく聞かれるまで押し直す。
 */
async function closeUntilAsked(app: ElectronApplication, count: number, how: 'close' | 'quit' = 'close'): Promise<void> {
  await expect.poll(async () => {
    if (how === 'quit') await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
    else await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); });
    return (await dialogButtons(app)).length;
  }, { message: `閉じる確認が${count}回目まで出ること` }).toBe(count);
}

/**
 * 検査の後片付けで終了の確認を省く印(`launchDesktop` が付ける)を付け外しする。外している間は、
 * 利用者の環境と同じく、アプリ全体の終了(`app.quit()`)でも確認が出る。
 */
async function setQuitConfirmBypass(app: ElectronApplication, bypass: boolean): Promise<void> {
  await app.evaluate((_electron, [name, value]) => {
    if (value) process.env[name] = '1';
    else Reflect.deleteProperty(process.env, name);
  }, [CLOSE_CONFIRM_BYPASS_ENV, bypass] as const);
}

async function startEditor(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
  return page;
}

/** 箱を1つ作り、保存していない変更(見出しの `*`)がある状態にする。 */
async function createUnsavedBox(page: Page): Promise<void> {
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^作る/ }).first().click();
  await page.getByRole('group', { name: '作る', exact: true }).getByRole('button', { name: '箱', exact: true }).click();
  const created = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, created);
  if (await page.locator('.pcad-popover').count()) await page.locator('.pcad-popover input').first().press('Escape');
  await expect.poll(() => page.title()).toContain('*');
}

const CHOICES = [uiMessage('file', 'file.closeGuard.save'), uiMessage('file', 'file.closeGuard.discard'),
  uiMessage('file', 'file.closeGuard.cancel')];
const SAVE = 0;
const DISCARD = 1;
const CANCEL = 2;

test('R03 実Electronで未保存のまま閉じると3択を出し、戻る・保存の失敗では閉じず、保存に成功したら閉じる', async ({ playwright }, info) => {
  const { app, directory } = await launchDesktop(playwright, info);
  try {
    const page = await startEditor(app);
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await createUnsavedBox(page);
    await holdDialogs(app);
    // 戻る: 答えるまで窓は開いたまま。重ねて閉じても確認は1回だけで、戻ると窓も変更も残る。
    await closeUntilAsked(app, 1);
    expect(await dialogButtons(app)).toEqual([CHOICES]);
    expect(await windowCount(app)).toBe(1);
    await answerDialog(app, CANCEL);
    await expect.poll(() => page.title()).toContain('*');
    // 保存に失敗する先(無いフォルダー): 理由を出して閉じない。
    await saveTarget(app, join(directory, '無いフォルダー', '部品.pcad'));
    await closeUntilAsked(app, 2);
    await answerDialog(app, SAVE);
    await expect(page.locator('.pcad-statusbar')).toContainText(uiMessage('file', 'file.saveFailed'));
    expect(await windowCount(app)).toBe(1);
    expect(await page.title()).toContain('*');
    // 保存して閉じる: ファイルに書けたら窓が閉じてアプリが終わる。
    const partPath = join(directory, '閉じる前に保存.pcad');
    await saveTarget(app, partPath);
    await closeUntilAsked(app, 3);
    expect(await dialogButtons(app)).toEqual([CHOICES, CHOICES, CHOICES]);
    expect(errors).toEqual([]);
    const closed = app.waitForEvent('close');
    await answerDialog(app, SAVE);
    await closed;
    expect((await diskFile(partPath)).subarray(0, 2).toString()).toBe('PK');
  } finally { await app.close(); }
});

test('R03 実Electronで保存せずに閉じる・Windowsの終了要求・アプリ全体の終了・変更の無いときの閉じ方を確かめる', async ({ playwright }, info) => {
  const first = await launchDesktop(playwright, info);
  try {
    const page = await startEditor(first.app);
    await createUnsavedBox(page);
    await holdDialogs(first.app);
    // Windows の終了要求: 未保存があるので止めて同じ3択を出す。戻ると窓は残る。
    const prevented = await first.app.evaluate(({ BrowserWindow }) => {
      let stopped = false;
      BrowserWindow.getAllWindows()[0]?.emit('query-session-end', { preventDefault: () => { stopped = true; }, reasons: ['shutdown'] });
      return stopped;
    });
    expect(prevented).toBe(true);
    await expect.poll(() => dialogButtons(first.app)).toEqual([CHOICES]);
    await answerDialog(first.app, CANCEL);
    // アプリ全体の終了(Linux の終了の合図と同じ app.quit): 印を外すと、利用者の環境と同じく確認が出る。
    await setQuitConfirmBypass(first.app, false);
    await closeUntilAsked(first.app, 2, 'quit');
    expect(await windowCount(first.app)).toBe(1);
    await answerDialog(first.app, CANCEL);
    await expect.poll(() => page.title()).toContain('*');
    expect(await windowCount(first.app)).toBe(1);
    // 保存せずに閉じる: 答えるまで窓は残り、答えると何も書かずに閉じる。
    const before = await readdir(first.directory);
    await closeUntilAsked(first.app, 3);
    expect(await windowCount(first.app)).toBe(1);
    const closed = first.app.waitForEvent('close');
    await answerDialog(first.app, DISCARD);
    await closed;
    expect(await readdir(first.directory)).toEqual(before);
  } finally {
    // 途中で落ちても、後片付けの終了が確認で止まらないよう印を戻す(終わった後なら何もしない)。
    await setQuitConfirmBypass(first.app, true).catch(() => undefined);
    await first.app.close();
  }
  // 変更の無いまま閉じると、確認を出さずに閉じる。終了要求も止めない。
  const second = await launchDesktop(playwright, info);
  try {
    await startEditor(second.app);
    await holdDialogs(second.app);
    const shutdownPrevented = await second.app.evaluate(({ BrowserWindow }) => {
      let stopped = false;
      BrowserWindow.getAllWindows()[0]?.emit('query-session-end', { preventDefault: () => { stopped = true; }, reasons: ['logoff'] });
      return stopped;
    });
    expect(shutdownPrevented).toBe(false);
    const closed = second.app.waitForEvent('close');
    await second.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); });
    await closed;
  } finally { await second.app.close(); }
});
