/// <reference lib="dom" />
import { expect, test as base, type Locator, type TestInfo } from '@playwright/test';
import { startAssembly } from './aluminumFrameCatalogFlow.js';
import { boxPartFile, installAssemblyFileGateway } from './assemblyTestSupport.js';
import { chooseToolMenuItemByKeyboard, expectDialogFocusCycle, toolMenuTrigger } from './dialogFocusSupport.js';
import { blockAssembly, TITLE as FILLET_WELD_TITLE, weldDialog } from './filletWeldFlow.js';
import { jointCheckPanel, openJointCheck, placeLFrames } from './frameJointCheckFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * C-03 の続き(持ち主の決まっていない組立の窓): メニューの項目をキーボードで選んで開き、中に焦点 → Tab で確定・取消の釦まで届く →
 * Esc → 「組む」の釦へ焦点が戻る。開いた時に効かない確定の釦(選ぶ前・量を入れる前)は焦点を受けないので、効かない事だけを見る。
 * 1. 部品を置く: 項目の後に部品のファイルを選んでから開く窓(開くまでの間にメニューの外の押下・キーが無いので、覚えた釦を使う)。
 * 2. すみ肉溶接: 項目を選んだ押下の中で開く窓(filletWeldFlow.ts の blockAssembly の組立)。
 * 3. ボルトで締結: 同じ組立(部品 2 つ)で、項目から開く窓。
 * 4. L 字の 2 本の組立(frameJointCheckFlow.ts の placeLFrames)で、フレームの溝に締結・伸縮(項目から開く)と、接続を留める
 *    (接合チェックの行の「留める」から開く。閉じると「留める」へ戻る)。
 */
const button = (dialog: Locator, key: string): Locator => dialog.getByRole('button', { name: uiMessage('assembly', key), exact: true });

export function registerDialogFocusAssemblyTests(test: typeof base): void {
  test.describe('C-03 組立の窓のフォーカス', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('距離の合致を開くと値の欄に焦点が入り、Esc で「合わせる」へ戻る', async ({ page }, info) => {
      await blockAssembly(page, info);
      const menu = uiMessage('assembly', 'assembly.menu.mate');
      const dialog = page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.mate.title'), exact: true });
      await expectDialogFocusCycle(page, {
        open: () => chooseToolMenuItemByKeyboard(page, menu, uiMessage('assembly', 'assembly.tool.mateDistance')),
        dialog,
        initial: dialog.getByRole('textbox'),
        opener: toolMenuTrigger(page, menu),
      });
    });

    test('球ジョイントを開くと文字欄のない窓に焦点が入り、Esc で「合わせる」へ戻る', async ({ page }, info) => {
      await blockAssembly(page, info);
      const menu = uiMessage('assembly', 'assembly.menu.mate');
      const dialog = page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.joint.title'), exact: true });
      await expectDialogFocusCycle(page, {
        open: () => chooseToolMenuItemByKeyboard(page, menu, uiMessage('assembly', 'assembly.tool.jointBall')),
        dialog,
        initial: dialog,
        opener: toolMenuTrigger(page, menu),
      });
    });

    test('部品を置く: 部品のファイルを選んだ後に開く窓も、Esc で閉じると「組む」の釦へ戻る', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, undefined);
      await installAssemblyFileGateway(page, { parts: [{ fileName: '箱.pcad', bytes: boxPartFile() }] });
      const build = uiMessage('assembly', 'assembly.menu.build');
      const dialog = page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.place.title'), exact: true });
      await expectDialogFocusCycle(page, {
        open: () => chooseToolMenuItemByKeyboard(page, build, '部品を置く'),
        dialog,
        opener: toolMenuTrigger(page, build),
        tabStops: [button(dialog, 'assembly.place.commit'), button(dialog, 'assembly.place.cancel')],
      });
      expect(errors).toEqual([]);
    });

    test('すみ肉溶接: 項目から開くと中に焦点、Esc で閉じると「組む」の釦へ戻る', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await blockAssembly(page, info);
      const build = uiMessage('assembly', 'assembly.menu.build');
      await expectDialogFocusCycle(page, {
        open: () => chooseToolMenuItemByKeyboard(page, build, FILLET_WELD_TITLE),
        dialog: weldDialog(page),
        opener: toolMenuTrigger(page, build),
        tabStops: [button(weldDialog(page), 'assembly.filletWeld.cancel')],
        disabledActions: [button(weldDialog(page), 'assembly.filletWeld.commit')],
      });
      expect(errors).toEqual([]);
    });

    test('ボルトで締結: 項目から開くと中に焦点、Esc で閉じると「組む」の釦へ戻る', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await blockAssembly(page, info);
      const build = uiMessage('assembly', 'assembly.menu.build');
      const dialog = page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.boltedJoint.title'), exact: true });
      await expectDialogFocusCycle(page, {
        open: () => chooseToolMenuItemByKeyboard(page, build, uiMessage('assembly', 'assembly.boltedJoint.tool')),
        dialog,
        opener: toolMenuTrigger(page, build),
        tabStops: [button(dialog, 'assembly.boltedJoint.cancel')],
        disabledActions: [button(dialog, 'assembly.boltedJoint.commit')],
      });
      expect(errors).toEqual([]);
    });

    test('L 字の 2 本: 溝に締結・伸縮は「組む」の釦へ、接続を留めるは接合チェックの「留める」へ、Esc で閉じると戻る', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, undefined);
      await placeLFrames(page);
      const build = uiMessage('assembly', 'assembly.menu.build');
      const slot = page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.frameSlot.title'), exact: true });
      await expectDialogFocusCycle(page, {
        open: () => chooseToolMenuItemByKeyboard(page, build, uiMessage('assembly', 'assembly.frameSlot.tool')),
        dialog: slot,
        opener: toolMenuTrigger(page, build),
        tabStops: [button(slot, 'assembly.frameSlot.cancel')],
        disabledActions: [button(slot, 'assembly.frameSlot.commit')],
      });
      const stretch = page.getByTestId('member-stretch');
      await expectDialogFocusCycle(page, {
        open: () => chooseToolMenuItemByKeyboard(page, build, uiMessage('assembly', 'assembly.tool.memberStretch')),
        dialog: stretch,
        opener: toolMenuTrigger(page, build),
        tabStops: [button(stretch, 'assembly.memberStretch.cancel')],
        disabledActions: [button(stretch, 'assembly.memberStretch.commit')],
      });
      await openJointCheck(page);
      const fasten = jointCheckPanel(page).getByTestId('joint-check-fasten');
      const bracket = page.getByTestId('frame-joint-bracket');
      await expectDialogFocusCycle(page, {
        open: async () => { await fasten.focus(); await page.keyboard.press('Enter'); },
        dialog: bracket,
        opener: fasten,
        tabStops: [button(bracket, 'assembly.jointBracket.cancel')],
        disabledActions: [button(bracket, 'assembly.jointBracket.commit')],
      });
      expect(errors).toEqual([]);
    });
  });
}
