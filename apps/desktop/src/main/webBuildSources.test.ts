import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { captureWebBuildSources } from '../../../../scripts/vite/webBuildSources.mjs';
import { localGitEnvironment } from '../../../../scripts/lib/gitEnvironment.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
function workspace(): string {
  return execFileSync('python', ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), 'web-source-test'],
    { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}
function git(folder: string, ...args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd: folder, env: localGitEnvironment(), encoding: 'utf8', windowsHide: true,
  });
}

it('未保存の追加・削除・同じ長さの変更も配布元の比較へ含め、報告だけの更新とは分ける', async () => {
  const folder = workspace();
  git(folder, 'init', '--quiet');
  mkdirSync(join(folder, 'packages/example/src'), { recursive: true });
  mkdirSync(join(folder, 'docs'));
  const original = join(folder, 'packages/example/src/main.ts'), added = join(folder, 'packages/example/src/new.ts');
  writeFileSync(original, 'first'); git(folder, 'add', 'packages/example/src/main.ts');
  const before = await captureWebBuildSources(folder);
  writeFileSync(join(folder, 'docs/report.md'), 'progress'); expect(await captureWebBuildSources(folder)).toEqual(before);
  writeFileSync(original, 'other'); expect(await captureWebBuildSources(folder)).not.toEqual(before);
  writeFileSync(original, 'first'); writeFileSync(added, 'new'); expect(await captureWebBuildSources(folder)).not.toEqual(before);
  unlinkSync(original); const removed = await captureWebBuildSources(folder);
  expect(removed).not.toHaveProperty(['packages/example/src/main.ts']); expect(removed).toHaveProperty(['packages/example/src/new.ts']);
  mkdirSync(join(folder, 'scripts/lib'), { recursive: true });
  writeFileSync(join(folder, 'scripts/lib/helper.mjs'), 'export const version = 1;');
  const helper = await captureWebBuildSources(folder);
  expect(helper).toHaveProperty(['scripts/lib/helper.mjs']);
  writeFileSync(join(folder, 'scripts/lib/helper.mjs'), 'export const version = 2;');
  expect(await captureWebBuildSources(folder)).not.toEqual(helper);
});

it('呼出元のGit保存先が渡されても別の配布元を読み、元の設定・保存対象・編集中の内容を保つ', async () => {
  const foreign = workspace(), target = workspace();
  for (const folder of [foreign, target]) {
    git(folder, 'init', '--quiet');
    mkdirSync(join(folder, 'packages/example'), { recursive: true });
    writeFileSync(join(folder, 'packages/example/value.ts'), folder === foreign ? 'foreign' : 'target');
    git(folder, 'add', 'packages');
  }
  writeFileSync(join(foreign, 'packages/example/value.ts'), 'unstaged');
  const protectedFiles = ['.git/config', '.git/HEAD', '.git/index', 'packages/example/value.ts'];
  const snapshot = () => protectedFiles.map(name => readFileSync(join(foreign, name)));
  const before = snapshot(), expected = await captureWebBuildSources(target);
  const variables = {
    GIT_DIR: join(foreign, '.git'), GIT_INDEX_FILE: join(foreign, '.git/index'), GIT_WORK_TREE: foreign,
    GIT_PREFIX: 'packages/', GIT_COMMON_DIR: join(foreign, '.git'),
    GIT_OBJECT_DIRECTORY: join(foreign, '.git/objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(foreign, '.git/objects'),
    GIT_QUARANTINE_PATH: join(foreign, '.git/objects'),
  };
  try {
    for (const [name, value] of Object.entries(variables)) vi.stubEnv(name, value);
    const child = join(target, 'fixture'); mkdirSync(child);
    git(child, 'init', '--quiet');
    writeFileSync(join(child, 'fixture.txt'), 'fixture'); git(child, 'add', 'fixture.txt');
    expect(await captureWebBuildSources(target)).toEqual(expected);
    expect(git(child, 'show', ':fixture.txt')).toBe('fixture');
    expect(snapshot()).toEqual(before);
    for (const [name, value] of Object.entries(variables)) expect(process.env[name]).toBe(value);
  } finally { vi.unstubAllEnvs(); }
});
