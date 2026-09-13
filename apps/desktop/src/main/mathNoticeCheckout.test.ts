import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const notices = 'docs/standards/licenses';
type Notice = { notice: string; sha256: string };
const manifest = JSON.parse(readFileSync(join(root, notices, 'math-notices.json'), 'utf8')) as {
  packages: Notice[]; additionalNotices: Notice[];
};
const records = [...manifest.packages, ...manifest.additionalNotices];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function removeNoticeTestRepository(repository: string, temporaryRoot: string): void {
  // Delete only the exact newly created directory, never a computed ancestor.
  if (dirname(resolve(repository)) !== temporaryRoot || !relative(temporaryRoot, repository).startsWith('pointercad-notice-checkout-')) {
    throw new Error('Refusing to remove a directory outside the notice test workspace');
  }
  rmSync(repository, { recursive: true, force: true });
}

describe('確認済みの許諾原文をGitの保存と取り出しでも保つ', () => {
  it.each(['false', 'true', 'input'])('core.autocrlf=%sでも改行を含む7原文の内容が変わらない', (autocrlf) => {
    const temporaryRoot = resolve(tmpdir());
    const repository = mkdtempSync(join(temporaryRoot, 'pointercad-notice-checkout-'));
    // A commit hook can inherit its real index and repository. Never use those here.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], {
      env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(repository, 'empty-user-config') },
      windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      writeFileSync(join(repository, 'empty-user-config'), '');
      git('init', '--quiet');
      git('config', 'core.autocrlf', autocrlf);
      git('config', 'core.safecrlf', 'false');
      writeFileSync(join(repository, '.gitattributes'), readFileSync(join(root, '.gitattributes')));
      mkdirSync(join(repository, notices), { recursive: true });
      for (const record of records) {
        const source = readFileSync(join(root, notices, record.notice));
        expect(digest(source), `verified original: ${record.notice}`).toBe(record.sha256);
        writeFileSync(join(repository, notices, record.notice), source);
      }
      git('add', '--', '.gitattributes', notices);
      for (const record of records) {
        expect(digest(git('show', `:${notices}/${record.notice}`)), `Git storage: ${record.notice}`).toBe(record.sha256);
      }
      const checkout = join(repository, 'fresh-checkout');
      mkdirSync(checkout);
      git('checkout-index', '--all', `--prefix=${checkout.replaceAll('\\', '/')}/`);
      for (const record of records) {
        expect(digest(readFileSync(join(checkout, notices, record.notice))), `fresh checkout: ${record.notice}`).toBe(record.sha256);
      }
    } finally {
      removeNoticeTestRepository(repository, temporaryRoot);
    }
  }, 15_000);
});
