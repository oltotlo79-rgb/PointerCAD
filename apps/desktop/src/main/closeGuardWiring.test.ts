/**
 * 未保存の確認を、どのアプリの入口からも外さないための配線の検査(レビュー R03 の再発防止)。
 *
 * R03 は、Web 版の入口だけが未保存の確認を取り付け、デスクトップ版の入口が取り付けないまま
 * 説明書に「確認は出ません」と書いて残っていた。同じ種類の抜けを機械で見つけるため、次を確かめる。
 *  - Git が扱う全てのアプリの画面の入口(`apps/<名前>/index.html` の script)から、相対の読込みを
 *    たどった先で `attachUnsavedChangesGuard(` を呼んでいる。新しいアプリの入口を足しても対象になる。
 *  - 本体の入口 `main.ts` は、主窓を作る前に閉じるときの見張りを登録している。
 *  - preload が出す口の名前とチャンネル名が、画面の入口と本体(`closeGuard.ts`)の定数とそろっている
 *    (preload は本体のファイルを読み込めず、同じ文字列を書き写しているため)。
 *  - 終了の確認を省く印は画面検査の入口だけが付け、製品のコードは定義して読むだけにしている。
 *  - 説明書は、確認の窓のボタンを画面と同じ文言の参照で書き、古い「確認は出ません」を残していない。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { CLOSE_ANSWER_CHANNEL, CLOSE_CHOICE_CHANNEL, CLOSE_GUARD_READY_CHANNEL, CLOSE_GUARD_STATE_CHANNEL,
  CLOSE_GUARD_TEST_BYPASS_ENV, CLOSE_REQUEST_CHANNEL } from './closeGuard.js';

vi.mock('electron', () => ({ app: {}, dialog: {}, ipcMain: {} }));

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/** HTML の入口から、アプリの中の相対の読込み(静的・動的)をたどった全ファイル。 */
function reachableSources(appDirectory: string, entry: string): Map<string, string> {
  const sources = new Map<string, string>();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || sources.has(path)) continue;
    const source = readFileSync(path, 'utf8');
    sources.set(path, source);
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const imported = resolve(dirname(path), specifier);
      const found = [imported, imported.replace(/\.js$/u, '.ts'), imported.replace(/\.js$/u, '.tsx')]
        .find((candidate) => existsSync(candidate) && /\.(?:ts|tsx)$/u.test(candidate));
      if (found !== undefined && found.startsWith(appDirectory)) pending.push(found);
    }
  }
  return sources;
}

describe('未保存の確認の配線(R03 の再発防止)', () => {
  it('全てのアプリの画面の入口から、未保存の確認を取り付けている', () => {
    // Per-command trust of this exact checkout supports a separate sandbox user without Git writes.
    const pages = execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', 'apps'],
      { cwd: root, encoding: 'utf8' }).split('\0').filter((name) => /^apps\/[^/]+\/index\.html$/u.test(name));
    expect(pages.sort()).toEqual(['apps/desktop/index.html', 'apps/web/index.html']);
    for (const page of pages) {
      const appDirectory = resolve(root, dirname(page));
      const script = /<script\b[^>]*\btype="module"[^>]*\bsrc="\/([^"]+)"/u.exec(read(page))?.[1];
      expect(script, `${page} の script が見つかりません`).toBeDefined();
      const sources = reachableSources(appDirectory, resolve(appDirectory, script ?? ''));
      const attached = [...sources.values()].some((source) => source.includes('attachUnsavedChangesGuard('));
      expect(attached, `${page} の入口から未保存の確認(attachUnsavedChangesGuard)を取り付けていません`).toBe(true);
    }
  });

  it('本体は主窓を作る前に、閉じるときの見張りを登録する', () => {
    const main = read('apps/desktop/src/main/main.ts');
    const ready = main.indexOf('app.whenReady()');
    const guard = main.indexOf('registerCloseGuard();', ready);
    const window = main.indexOf('createMainWindow();', ready);
    expect(ready).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(ready);
    expect(window).toBeGreaterThan(guard);
  });

  it('preload の口の名前とチャンネル名が、画面の入口と本体の定数とそろっている', () => {
    const preload = read('apps/desktop/src/preload/preload.ts');
    for (const channel of [CLOSE_GUARD_READY_CHANNEL, CLOSE_GUARD_STATE_CHANNEL, CLOSE_CHOICE_CHANNEL, CLOSE_ANSWER_CHANNEL]) {
      expect(preload).toContain(`ipcRenderer.invoke('${channel}'`);
    }
    expect(preload).toContain(`ipcRenderer.on('${CLOSE_REQUEST_CHANNEL}'`);
    expect(preload).toContain(`ipcRenderer.removeListener('${CLOSE_REQUEST_CHANNEL}'`);
    const renderer = [...reachableSources(resolve(root, 'apps/desktop'),
      resolve(root, 'apps/desktop/src/renderer/main.tsx')).values()].join('\n');
    const methods = /CLOSE_REQUEST_METHODS\b[^=]*= \{([^}]+)\}/u.exec(renderer)?.[1];
    const names = [...(methods ?? '').matchAll(/([A-Za-z]+): true/gu)].map((match) => match[1]);
    expect(names).toEqual(['closeGuardReady', 'reportUnsavedWork', 'onCloseRequest', 'chooseCloseAction', 'answerCloseRequest']);
    for (const name of names) expect(preload).toContain(`  ${name}: (`);
  });

  it('終了の確認を省く印は画面検査の入口だけが付け、製品のコードは読むだけにする', () => {
    const flow = read('e2e/tests/electronAppFlow.ts');
    expect(flow).toContain(`CLOSE_CONFIRM_BYPASS_ENV = '${CLOSE_GUARD_TEST_BYPASS_ENV}'`);
    expect(flow).toContain('process.env[${JSON.stringify(CLOSE_CONFIRM_BYPASS_ENV)}] = \'1\'');
    const products = execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', 'apps', 'packages'],
      { cwd: root, encoding: 'utf8' }).split('\0')
      .filter((name) => /\/src\/.+\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(name) && !/\.test\.[a-z]+$/u.test(name));
    const mentioning = products.filter((name) => read(name).includes(CLOSE_GUARD_TEST_BYPASS_ENV));
    // 定義する closeGuard.ts だけが名前を持つ。製品のどこも印を付けない。
    expect(mentioning).toEqual(['apps/desktop/src/main/closeGuard.ts']);
    expect(read('apps/desktop/src/main/closeGuard.ts')).toContain('process.env[CLOSE_GUARD_TEST_BYPASS_ENV] === \'1\'');
  });

  it('説明書は確認の窓のボタンを画面と同じ文言で書き、古い制約の記述を残さない', () => {
    const manual = read('packages/help-content/docs/ja/save-and-open.md');
    for (const key of ['message', 'save', 'discard', 'cancel', 'unresponsiveMessage', 'forceClose']) {
      expect(manual).toContain(`{{ui:file.closeGuard.${key}}}`);
    }
    expect(manual).not.toContain('窓を閉じるときに確認は出ません');
  });

  /**
   * `playwright._electron.launch(` を直接呼ぶ所を全て洗い、それぞれが未保存の確認(R03)の窓へ必ず答える
   * ことを確かめる(w84a: 確認を省く印 CLOSE_GUARD_TEST_BYPASS_ENV は launchDesktop の外へ効かないため、
   * launchDesktop を経由しない起動は自分で確認へ答えないと配布物の起動の検査が窓で止まる)。
   * 新しく直接呼ぶ所が増えても、launchDesktop の利用も終了の確認への答え方も持たなければここで落ちる。
   */
  it('_electron.launch を直接呼ぶ所は、launchDesktop を使うか終了の確認に自分で答える', () => {
    const definesLaunchDesktop = 'e2e/tests/electronAppFlow.ts';
    expect(read(definesLaunchDesktop)).toContain('_electron.launch(');
    const files = execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', 'apps', 'e2e', 'packages'],
      { cwd: root, encoding: 'utf8' }).split('\0')
      .filter((name) => /\.(?:ts|tsx|mts|cts)$/u.test(name) && !/\.test\.[a-z]+$/u.test(name))
      // --cached still lists a tracked file deleted in the working tree until the deletion is committed; it runs nothing.
      .filter((name) => existsSync(resolve(root, name)));
    const callers = files.filter((name) => name !== definesLaunchDesktop && /_electron\.launch\s*\(/u.test(read(name)));
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers) {
      const source = read(caller);
      const usesLaunchDesktop = /\blaunchDesktop\s*\(/u.test(source);
      // 終了の確認への答え方: dialog.showMessageBox を上書きする補助(w84a の answerCloseConfirmWithDiscard
      // と同じ形)を定義し、定義した名前を定義以外の場所でも呼んでいる(定義だけで未使用なら答えていない)。
      const assignAt = source.indexOf('dialog.showMessageBox = ');
      const helperName = assignAt === -1 ? undefined
        : [...source.slice(0, assignAt).matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gu)].pop()?.[1];
      const answersCloseConfirm = helperName !== undefined && source.split(`${helperName}(`).length - 1 >= 2;
      expect(usesLaunchDesktop || answersCloseConfirm, `${caller} は _electron.launch を直接呼びますが、`
        + 'launchDesktop も使わず、終了の確認(dialog.showMessageBox を上書きする補助)への答え方も持ちません。').toBe(true);
    }
  });
});
