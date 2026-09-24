/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { focusField, waitForMathEditorText } from './mathEditorReady.js';
import { uiMessage } from './uiMessages.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { functionPlotMessage } from './functionMessages.js';

/*
 * MC-27b: 構造入力の欄(実際の MathLive)のキー操作を、実際の数式の画面で確かめる。
 * - 式の端の Tab・Shift+Tab・→・← は、文字入力の欄でブラウザー自身が Tab・Shift+Tab で移す先と同じ部品へ移る。
 * - 「\」で始めた命令の候補を出している間の Enter は候補を確定し、Esc は候補だけを閉じて入力画面を残す。
 * - 候補を出していない間の Enter・Esc は従来どおり(Enter は確定しない、Esc は取り消して閉じる)。
 * 判定の処理と変換中の扱いの網羅は packages/ui/src/math/mathEditorKeyboard.test.ts・mathFieldFocusOrder.test.ts。
 */
test.use({ viewport: { width: 1440, height: 900 } });

/** 新しい名前付きの数値の数式の画面を開き、文字入力の欄へ 1+2 を入れて結果を待つ。 */
async function openMathEditor(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.getByRole('tab', { name: uiMessage('propertyPanel', 'propertyPanel.tabParameters'), exact: true }).click();
  await page.getByRole('button', { name: uiMessage('parameters', 'parameterPanel.addTooltip'), exact: true }).click();
  await page.locator('.pcad-parameter').last().getByRole('button', { name: uiMessage('math', 'math.open'), exact: true }).click();
  const dialog = page.locator('.pcad-math-dialog');
  await waitForMathEditorText(dialog);
  await dialog.locator('textarea').fill('1+2');
  await expect(dialog.locator('.pcad-math-editor__result')).toHaveText('= 3');
  return dialog;
}

/** 構造入力へ切り替え、画面が入力欄へ焦点を移すのを待つ。 */
async function switchToStructured(dialog: Locator): Promise<Locator> {
  await dialog.getByRole('button', { name: uiMessage('math', 'math.structured'), exact: true }).click();
  const field = dialog.locator('math-field');
  await expect(field).toBeFocused();
  return field;
}

/** MathLive の欄の mode(math・text・latex)または value(LaTeX)を読む。 */
function fieldProperty(field: Locator, name: 'mode' | 'value'): () => Promise<string> {
  return async () => {
    const found: unknown = await field.evaluate((element, property) => Reflect.get(element, property), name);
    if (typeof found !== 'string') throw new Error(`構造入力の欄の ${name} が文字列ではありません`);
    return found;
  };
}

test('MC-27b 構造入力の欄の端の Tab・Shift+Tab・→・← は文字入力の欄の Tab と同じ前後の部品へ移る', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  const dialog = await openMathEditor(page);
  // 基準: 文字入力の欄からブラウザー自身の Tab・Shift+Tab が移す先(記号の挿入の最初のボタンと角度の単位)。
  const text = dialog.locator('textarea');
  const next = dialog.locator('.pcad-math-editor__symbols button').first();
  const previous = dialog.getByTitle(uiMessage('math', 'math.guide.angleUnit'), { exact: true });
  await text.press('Tab');
  await expect(next).toBeFocused();
  await text.press('Shift+Tab');
  await expect(previous).toBeFocused();

  const field = await switchToStructured(dialog);
  // 構造入力へ切り替えた式の表記(変換の結果)は検査の対象外。移動の前後で変わらないことだけを見る。
  const initial = await fieldProperty(field, 'value')();
  const moves = [
    { edge: 'End', key: 'Tab', target: next },
    { edge: 'Home', key: 'Shift+Tab', target: previous },
    { edge: 'End', key: 'ArrowRight', target: next },
    { edge: 'Home', key: 'ArrowLeft', target: previous },
  ];
  for (const { edge, key, target } of moves) {
    await focusField(field);
    await page.keyboard.press(edge);
    await page.keyboard.press(key);
    await expect(target, `式の${edge === 'End' ? '終わり' : '始め'}の ${key}`).toBeFocused();
  }
  // 焦点の移動だけで、式・画面・確定の状態は変えない。
  await expect(dialog).toBeVisible();
  expect(await fieldProperty(field, 'value')()).toBe(initial);
  await expect(dialog.locator('.pcad-math-editor__result')).toHaveText('= 3');
  expect(errors).toEqual([]);
});

test('MC-27b 構造入力で命令の候補を出している間の Enter は候補を確定し、Esc は候補だけを閉じて入力画面を残す', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  const dialog = await openMathEditor(page);
  const field = await switchToStructured(dialog);
  const mode = fieldProperty(field, 'mode'), value = fieldProperty(field, 'value');
  const suggestions = page.locator('#mathlive-suggestion-popover');
  const initial = await value(), sqrt = String.raw`\sqrt`, pi = String.raw`\pi`;

  // 候補を出していない間の Enter は従来どおり式を確定せず、画面も閉じない。
  await focusField(field);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  expect(await value()).toBe(initial);

  // 「\」で命令を打ち始めると MathLive が候補を出す。Enter は候補(\sqrt)を確定し、画面は開いたまま。
  await page.keyboard.type(String.raw`+\sqr`);
  await expect.poll(mode).toBe('latex');
  await expect(suggestions).toHaveClass(/is-visible/u);
  const shown = await suggestions.evaluate(panel => {
    const box = panel.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return top !== null && panel.contains(top) ? 'front' : `covered by ${top?.tagName ?? 'nothing'}`;
  });
  // 候補の一覧は MathLive が文書の最後へ置くため、モーダルの画面の下になり得る。判定には使わず記録だけ残す。
  console.log(`[観察] LaTeX の命令の候補の一覧の重なり: ${shown}`);
  test.info().annotations.push({ type: 'MathLive の候補の一覧', description: shown });
  await page.keyboard.press('Enter');
  await expect.poll(mode).toBe('math');
  const completed = await value();
  expect(completed.startsWith(`${initial}+${sqrt}`), completed).toBe(true);
  await expect(dialog).toBeVisible();
  await expect(suggestions).toBeHidden();

  // 式の終わりへ移って次の命令を打つ。途中の Esc は候補だけを閉じ、打った命令(\pi)を式に残して画面を閉じない。
  await page.keyboard.press('End');
  await page.keyboard.type(String.raw`+\pi`);
  await expect.poll(mode).toBe('latex');
  await expect(suggestions).toHaveClass(/is-visible/u);
  await page.keyboard.press('Escape');
  await expect.poll(mode).toBe('math');
  await expect(dialog).toBeVisible();
  await expect(suggestions).toBeHidden();
  expect(await value()).toBe(`${completed}+${pi}`);

  // 候補を出していない間の Esc は従来どおり入力画面を取り消して閉じる。
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

/*
 * MC-27c: 「\」で打ち始めた命令の候補の一覧と、補完の直後の入力。
 * - 一覧は MathLive が文書の最後に置くとモーダルの画面(showModal)の下に隠れ、押せなかった。一覧が画面の最前面に
 *   見え(elementFromPoint が一覧の中を返す)、候補を押すと命令が入ることを、数式の画面と関数作図の画面から開いた
 *   数式の画面の両方で確かめる。
 * - \sqrt など引数のある命令を補完で確定した直後に数字を打つと、√ ごと置き換わっていた。数字が √ の中へ入り、
 *   引数の無い命令(\pi)の後は従来どおり後ろへ続くことを確かめる。
 * 判定の処理の網羅は packages/ui/src/math/mathCommandCompletion.test.ts。
 */

/** 一覧の中央と最初の候補の中央で最前面の要素(elementFromPoint)が一覧の中かを読み、最初の候補の命令と中央の座標を返す。 */
async function suggestionListFront(list: Locator) {
  return list.evaluate(panel => {
    const inside = (x: number, y: number): boolean => {
      const top = document.elementFromPoint(x, y);
      return top !== null && panel.contains(top);
    };
    const box = panel.getBoundingClientRect(), item = panel.querySelector('li');
    const itemBox = item?.getBoundingClientRect();
    const x = itemBox === undefined ? 0 : itemBox.x + itemBox.width / 2, y = itemBox === undefined ? 0 : itemBox.y + itemBox.height / 2;
    return {
      center: inside(box.x + box.width / 2, box.y + box.height / 2),
      item: itemBox !== undefined && inside(x, y),
      command: item?.getAttribute('data-command') ?? '',
      x, y,
    };
  });
}

/** 構造入力の欄の式の終わりで「+」と命令を打ち、候補の一覧が出るまで待つ。 */
async function typeCommand(page: Page, field: Locator, command: string): Promise<Locator> {
  const list = page.locator('#mathlive-suggestion-popover');
  await focusField(field);
  await page.keyboard.press('End');
  await page.keyboard.type(`+${command}`);
  await expect.poll(fieldProperty(field, 'mode')).toBe('latex');
  await expect(list).toHaveClass(/is-visible/u);
  return list;
}

/** 候補の一覧が画面の最前面にあり、最初の候補(\sqrt)を押すと入って画面は開いたまま、次の数字は √ の中へ入る。 */
async function expectSuggestionsUsable(page: Page, dialog: Locator, field: Locator): Promise<void> {
  const value = fieldProperty(field, 'value'), sqrt = String.raw`\sqrt`;
  const list = await typeCommand(page, field, String.raw`\sqr`);
  const front = await suggestionListFront(list);
  expect(front, '一覧の中央と最初の候補の中央の最前面の要素が一覧の中にある(画面に隠れない)')
    .toMatchObject({ center: true, item: true, command: sqrt });
  await page.mouse.click(front.x, front.y);
  await expect.poll(fieldProperty(field, 'mode')).toBe('math');
  await expect(list).toBeHidden();
  await expect(dialog).toBeVisible();
  // 編集した後の式の表記(例 X^2 の ^{2} と ^2)は MathLive が決めるので、押した直後の式を基準に比べる(rules/06 §10.329)。
  const completed = await value(), before = completed.replace(/\\sqrt(?:\{\})?$/u, '');
  expect(before, `押した命令が式の終わりに入っている: ${completed}`).not.toBe(completed);
  expect(before.endsWith('+'), completed).toBe(true);
  await page.keyboard.type('25');
  expect(await value()).toBe(`${before}${sqrt}{25}`);
}

test('MC-27c 構造入力の命令の候補の一覧は数式の画面の上に見え、候補を押すと命令が入って √ の中から打てる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  const dialog = await openMathEditor(page);
  const field = await switchToStructured(dialog);
  await expectSuggestionsUsable(page, dialog, field);
  // 閉じた後に一覧を残さない。
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#mathlive-suggestion-popover')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('MC-27c 関数作図の画面から開いた数式の画面でも、候補の一覧が上に見えて押せる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  await page.goto('/');
  await chooseToolMenuItem(page, '作図', functionPlotMessage('menuTitle'));
  const plot = page.locator('.pcad-function-dialog');
  await expect(plot).toBeVisible();
  await plot.getByRole('textbox', { name: `Y ${functionPlotMessage('formula')}`, exact: true }).fill('X^2');
  await plot.getByRole('button', { name: `Y: ${uiMessage('math', 'math.open')}`, exact: true }).click();
  const dialog = page.locator('.pcad-math-dialog');
  await waitForMathEditorText(dialog);
  const field = await switchToStructured(dialog);
  await expectSuggestionsUsable(page, dialog, field);
  await expect(plot).toBeVisible();
  expect(errors).toEqual([]);
});

test('MC-27c 引数のある命令を補完の Enter で確定した直後の数字は最初の空欄へ入り、引数の無い \\pi の後は従来どおり続く', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  const dialog = await openMathEditor(page);
  const field = await switchToStructured(dialog);
  const mode = fieldProperty(field, 'mode'), value = fieldProperty(field, 'value');
  const initial = await value(), sqrt = String.raw`\sqrt`, frac = String.raw`\frac`, pi = String.raw`\pi`;
  const complete = async (command: string, digits: string): Promise<void> => {
    const list = await typeCommand(page, field, command);
    await page.keyboard.press('Enter');
    await expect.poll(mode).toBe('math');
    await expect(list).toBeHidden();
    await page.keyboard.type(digits);
  };
  // \sqrt は Enter の直後に √ の全体が選ばれていた。数字は √ の中へ入る。
  await complete(sqrt, '25');
  expect(await value()).toBe(`${initial}+${sqrt}{25}`);
  // \frac は MathLive が分子の空欄を選ぶ。数字は分子へ入る(従来どおり)。
  await complete(frac, '7');
  expect(await value()).toBe(`${initial}+${sqrt}{25}+${frac}{7}{${String.raw`\placeholder`}{}}`);
  // 引数の無い \pi の後の数字は、従来どおり π の後ろへ続く。
  await complete(pi, '3');
  expect(await value()).toBe(`${initial}+${sqrt}{25}+${frac}{7}{${String.raw`\placeholder`}{}}+${pi}3`);
  await expect(dialog).toBeVisible();
  expect(errors).toEqual([]);
});
