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
const runtimeManifest = JSON.parse(readFileSync(join(root, notices, 'runtime-notices.json'), 'utf8')) as {
  packages: { name: string; notices: { file: string; installedFile: string; sha256: string }[] }[];
};
const occtNotice = runtimeManifest.packages.find(item => item.name === 'opencascade.js')?.notices
  .find(item => item.installedFile === 'LICENSE');
if (occtNotice === undefined) throw new Error('Missing verified opencascade.js license record');
const occtVendorPath = 'vendor/opencascade/opencascade.js-b5ff984-closed-0839d9bcc8ac4677/' + occtNotice.installedFile;
const records = [
  ...[...manifest.packages, ...manifest.additionalNotices].map(record => ({ path: `${notices}/${record.notice}`, sha256: record.sha256 })),
  { path: `${notices}/${occtNotice.file}`, sha256: occtNotice.sha256 },
  { path: occtVendorPath, sha256: occtNotice.sha256 },
];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function removeNoticeTestRepository(repository: string, temporaryRoot: string): void {
  // Delete only the exact newly created directory, never a computed ancestor.
  if (dirname(resolve(repository)) !== temporaryRoot || !relative(temporaryRoot, repository).startsWith('pointercad-notice-checkout-')) {
    throw new Error('Refusing to remove a directory outside the notice test workspace');
  }
  rmSync(repository, { recursive: true, force: true });
}

describe('確認済みの許諾原文をGitの保存と取り出しでも保つ', () => {
  it.each(['false', 'true', 'input'])('core.autocrlf=%sでも数学とOCCTの許諾原文のバイトが変わらない', (autocrlf) => {
    const temporaryRoot = resolve(tmpdir());
    const repository = mkdtempSync(join(temporaryRoot, 'pointercad-notice-checkout-'));
    // A commit hook can inherit its real index and repository. Never use those here.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', repository, ...args], {
      env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(repository, 'empty-user-config') },
      windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      writeFileSync(join(repository, 'empty-user-config'), '');
      git('init', '--quiet');
      git('config', 'core.autocrlf', autocrlf);
      git('config', 'core.safecrlf', 'false');
      writeFileSync(join(repository, '.gitattributes'), readFileSync(join(root, '.gitattributes')));
      const occtOriginal = readFileSync(join(root, notices, occtNotice.file));
      const sources = records.map(record => ({ ...record, source: readFileSync(join(root, record.path)) }));
      for (const record of sources) {
        expect(digest(record.source), `verified original: ${record.path}`).toBe(record.sha256);
        if (record.path === occtVendorPath) expect(record.source.equals(occtOriginal), 'vendor and docs original bytes').toBe(true);
        const target = join(repository, record.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, record.source);
      }
      git('add', '--', '.gitattributes', ...records.map(record => record.path));
      for (const record of sources) {
        const stored = git('show', `:${record.path}`);
        expect(digest(stored), `Git storage: ${record.path}`).toBe(record.sha256);
        expect(stored.equals(record.source), `Git storage bytes: ${record.path}`).toBe(true);
      }
      const checkout = join(repository, 'fresh-checkout');
      mkdirSync(checkout);
      git('checkout-index', '--all', `--prefix=${checkout.replaceAll('\\', '/')}/`);
      for (const record of sources) {
        const checkedOut = readFileSync(join(checkout, record.path));
        expect(digest(checkedOut), `fresh checkout: ${record.path} (${checkedOut.length} bytes)`).toBe(record.sha256);
        expect(checkedOut.equals(record.source), `fresh checkout bytes: ${record.path}`).toBe(true);
      }
    } finally {
      removeNoticeTestRepository(repository, temporaryRoot);
    }
  }, 15_000);
});
