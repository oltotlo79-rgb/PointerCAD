import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

it('実際のE2E規則が縦横の線の面積判定を拒否し、描線と塗り文字の確認を許す', async () => {
  const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
  for (const filePath of ['e2e/tests/p8-drawing.spec.ts', 'e2e/tests/recompute.ts']) {
    for (const selector of ['path', '.pcad-drawing-svg [data-owner-id="view-1"] path']) {
      const [result] = await eslint.lintText(`await expect(page.locator('${selector}').first()).toBeVisible();`, { filePath });
      expect(result?.messages.some(message => message.ruleId === 'no-restricted-syntax' && message.message.includes('SVGの線'))).toBe(true);
    }
    for (const source of ["await expectDrawingStroke(page.locator('path'));",
      "await expect(row.locator('path[fill=\"#2563eb\"]').first()).toBeVisible();",
      "await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible();"]) {
      const [result] = await eslint.lintText(source, { filePath });
      expect(result?.messages.filter(message => message.ruleId === 'no-restricted-syntax')).toEqual([]);
    }
  }
});
