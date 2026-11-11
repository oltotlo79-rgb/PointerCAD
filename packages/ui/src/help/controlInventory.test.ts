import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildNativeControlInventory, assertNativeControlDescriptions } from '../../../../scripts/manual/control-inventory.mjs';

describe('操作欄の説明漏れを実際の画面ソースから見つける', () => {
  it('新しい画面も含む全ての通常欄から、説明を付け忘れた変更を検出する', () => {
    // Enumerate the actual source tree so a new component cannot be omitted from a manual allowlist.
    const root = new URL('../', import.meta.url), files: string[] = [];
    const collect = (folder: string): void => {
      for (const entry of readdirSync(new URL(folder, root), { withFileTypes: true })) {
        const path = folder + entry.name;
        if (entry.isSymbolicLink()) throw new Error(`Unexpected source link: ${path}`);
        if (entry.isDirectory()) collect(path + '/');
        else if (entry.isFile() && path.endsWith('.tsx') && !path.endsWith('.test.tsx')) files.push(path);
      }
    };
    collect(''); files.sort();
    const inventory = buildNativeControlInventory(files.map(path => ({ path,
      source: readFileSync(new URL(path, root), 'utf8') })));
    expect(inventory.sources).toHaveLength(files.length);
    assertNativeControlDescriptions(inventory);
    expect(inventory.requiresRenderedCheck.length).toBeGreaterThan(0);
  });
});
