import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { captureWebBuildSources } from '../../../../scripts/vite/webBuildSources.mjs';

it('未保存の追加・削除・同じ長さの変更も配布元の比較へ含め、報告だけの更新とは分ける', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const folder = execFileSync('python', ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), 'web-source-test'],
    { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '--quiet', folder], { cwd: root });
  mkdirSync(join(folder, 'packages/example/src'), { recursive: true });
  mkdirSync(join(folder, 'docs'));
  const original = join(folder, 'packages/example/src/main.ts'), added = join(folder, 'packages/example/src/new.ts');
  writeFileSync(original, 'first'); execFileSync('git', ['add', 'packages/example/src/main.ts'], { cwd: folder });
  const before = await captureWebBuildSources(folder);
  writeFileSync(join(folder, 'docs/report.md'), 'progress'); expect(await captureWebBuildSources(folder)).toEqual(before);
  writeFileSync(original, 'other'); expect(await captureWebBuildSources(folder)).not.toEqual(before);
  writeFileSync(original, 'first'); writeFileSync(added, 'new'); expect(await captureWebBuildSources(folder)).not.toEqual(before);
  unlinkSync(original); const removed = await captureWebBuildSources(folder);
  expect(removed).not.toHaveProperty(['packages/example/src/main.ts']); expect(removed).toHaveProperty(['packages/example/src/new.ts']);
});
