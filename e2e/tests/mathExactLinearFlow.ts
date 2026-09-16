import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';

/** Independent known solutions exercise the bundled interpreter through the ordinary editor. */
export async function mathExactLinearFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('連立式の成分'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  // MathLive adds its own status announcer when structured input is opened.
  // Check the application result in either notation, never the shadow-DOM announcer.
  const input = dialog.locator('textarea'), status = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  await expect(apply).toBeEnabled();
  const dependent = '[[sqrt(2),1],[2,sqrt(2)]]';
  const unique = 'linearsolve([[sqrt(2),1],[1,sqrt(2)]],[2*sqrt(2)+3,2+3*sqrt(2)])';
  const samples: readonly (readonly [string, number])[] = [
    [`component(${unique},1)`, 2], [`component(${unique},2)`, 3],
    [`component(rowreduce(${dependent}),1,2)`, Math.SQRT1_2],
    [`component(component(rowreduce(${dependent}),1),2)`, Math.SQRT1_2],
    [`component(nullspace(${dependent}),1,1)`, -Math.SQRT1_2],
    [`component(columnspace(${dependent}),1,2)`, 2],
    [`component(rowspace(${dependent}),1,2)`, Math.SQRT1_2],
    [`component(linearsolutionspace(${dependent},[3*sqrt(2),6]),1,1)`, 3],
    [`component(linearsolutionspace(${dependent},[3*sqrt(2),6]),2,2)`, 1],
    // A tiny independent direction must not disappear through a numeric tolerance.
    ['component(rowreduce([[sqrt(2),0],[0,1e-40]]),2,2)', 1],
    ['im(component(rowreduce([[i,1],[1,-i]]),1,2))', -1],
    ['component(linearsolve([[i,1],[1,i]],[2*i+3,2+3*i]),2)', 3],
    // Rectangular systems may still have a unique solution if all rows agree.
    ['component(linearsolve([[sqrt(2),0],[0,1],[2,0]],[2*sqrt(2),3,4]),2)', 3],
  ];
  for (const [source, expected] of samples) {
    await input.fill(source);
    await expect.poll(async () => {
      const text = await status.innerText();
      return /^= /u.test(text) ? Number(text.slice(2)) : NaN;
    }, { timeout: 225_000 }).toBeCloseTo(expected, 10);
    await expect(apply).toBeEnabled();
  }
  const invalid = [
    `component(linearsolve(${dependent},[3*sqrt(2),6]),1)`,
    `component(linearsolve(${dependent},[0,1]),1)`,
    `component(nullspace(${dependent}),2,1)`,
    'component(nullspace([[sqrt(2),0],[0,1]]),1,1)',
    'component(rowreduce([[sqrt(2),1],[2]]),1,1)',
    `component(linearsolutionspace(${dependent},[0,1]),1,1)`,
  ];
  for (const source of invalid) {
    await input.fill(source);
    await expect(input).toHaveAttribute('aria-invalid', 'true', { timeout: 225_000 });
    await expect(apply).toBeDisabled();
  }
  const source = `component(${unique},1)`;
  await input.fill(source); await expect(status).toHaveText('= 2', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);
  const saved = await savePart(page, info, 'exact-linear.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '連立式の成分')?.value).toMatchObject({
    value: 2, source, mathDefinition: { source, angleUnit: 'degree' },
  });
  await reopenPart(page, info, 'exact-linear.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expect(status).toHaveText('= 2', { timeout: 225_000 });
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await expect(status).toHaveText('= 2', { timeout: 225_000 });
  await page.screenshot({ path: info.outputPath('exact-linear-structured.png') });
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source);
  await info.attach('exact-linear-identities', { body: JSON.stringify({ samples, invalid }, null, 2), contentType: 'application/json' });
}
