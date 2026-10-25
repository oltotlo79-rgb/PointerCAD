import { expect, type Locator } from '@playwright/test';

interface FlatBar50x6 {
  readonly grade: 'SS400' | 'S45C';
  readonly size: string;
  readonly condition: string;
}

/** Visible two-step picker for the existing FB 50×6 cases; expectations come from each flow's product/CSV columns. */
export async function chooseSteelFlatBar50x6(dialog: Locator, product: FlatBar50x6): Promise<void> {
  const grade = dialog.getByRole('combobox', { name: '鋼種', exact: true });
  const shape = dialog.getByRole('combobox', { name: '断面形状', exact: true });
  await grade.selectOption(product.grade);
  await shape.selectOption('flatBar');

  const thickness = dialog.getByRole('combobox', { name: '厚さ', exact: true });
  await expect(thickness).toBeVisible();
  await thickness.selectOption('6');
  const width = dialog.getByRole('combobox', { name: '幅', exact: true });
  await expect(width).toBeVisible();
  // steelChoice prefixes the catalog key. S45C's bright bar has no :hotRolled suffix.
  const choiceKey = `steel:${product.grade}:flatBar:${product.size}`;
  await width.selectOption(choiceKey);

  await expect(grade).toHaveValue(product.grade);
  await expect(grade.locator('option:checked')).toHaveText(product.grade);
  await expect(shape).toHaveValue('flatBar');
  await expect(thickness).toHaveValue('6');
  await expect(thickness.locator('option:checked')).toHaveText('6 mm');
  await expect(width).toHaveValue(choiceKey);
  // S45C has both bright and hot-rolled FB 50×6: assert width and condition independently of the key.
  await expect(width.locator('option:checked')).toHaveText(product.grade === 'S45C'
    ? `50 mm / ${product.condition}` : '50 mm');
  await expect(dialog.getByRole('status').filter({ hasText: product.condition })).toBeVisible();
}
