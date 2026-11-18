/// <reference lib="dom" />
import { expect, test as base, type TestInfo } from '@playwright/test';
import { startAssembly } from './aluminumFrameCatalogFlow.js';
import { boxPartFile, installAssemblyFileGateway } from './assemblyTestSupport.js';
import { chooseToolMenuItemByKeyboard, expectDialogFocusCycle, toolMenuTrigger } from './dialogFocusSupport.js';
import { blockAssembly, TITLE as FILLET_WELD_TITLE, weldDialog } from './filletWeldFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * C-03 の続き(持ち主の決まっていない組立の窓): メニューの項目をキーボードで選んで開き、中に焦点 → Esc → 「組む」の釦へ焦点が戻る。
 * 1. 部品を置く: 項目の後に部品のファイルを選んでから開く窓(開くまでの間にメニューの外の押下・キーが無いので、覚えた釦を使う)。
 * 2. すみ肉溶接: 項目を選んだ押下の中で開く窓(filletWeldFlow.ts の blockAssembly の組立)。
 */
export function registerDialogFocusAssemblyTests(test: typeof base): void {
  test.describe('C-03 組立の窓のフォーカス', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('部品を置く: 部品のファイルを選んだ後に開く窓も、Esc で閉じると「組む」の釦へ戻る', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, undefined);
      await installAssemblyFileGateway(page, { parts: [{ fileName: '箱.pcad', bytes: boxPartFile() }] });
      const build = uiMessage('assembly', 'assembly.menu.build');
      await expectDialogFocusCycle(page, {
        open: () => chooseToolMenuItemByKeyboard(page, build, '部品を置く'),
        dialog: page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.place.title'), exact: true }),
        opener: toolMenuTrigger(page, build),
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
      });
      expect(errors).toEqual([]);
    });
  });
}
