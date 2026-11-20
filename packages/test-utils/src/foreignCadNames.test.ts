import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The product, its help, the screen checks and the scripts do not name other CAD products (M06-0c; user's answer
 * 2026-11-19 21:2x: CAD product names only). standardSourceNames.test.ts checks the reference publishers instead.
 * Names of analysis programs that receive an exported file and the third-party notices under packages/fem/runtime are
 * outside this check (the notices are not under a src folder).
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
// Base64 keeps the names out of the published source, including this test.
const decode = (word: string): string => Buffer.from(word, 'base64').toString('utf8');
const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** Names matched in any letter case as a whole word: a longer word or identifier around them does not match. */
const anyCaseNames = [
  'YXV0b2NhZA==', 'YWNhZC5wZ3A=', 'c29saWR3b3Jrcw==', 'c29saWQgd29ya3M=', 'ZnVzaW9uIDM2MA==', 'ZnVzaW9uMzYw', 'b25zaGFwZQ==',
  'ZnJlZWNhZA==', 'c2tldGNodXA=', 'Y2F0aWE=', 'Y3Jlbw==', 'YnJpY3NjYWQ=', 'ZHJhZnRzaWdodA==', 'dmVjdG9yd29ya3M=', 'dGlua2VyY2Fk',
  'c2hhcHIzZA==', 'enczZA==', 'aXJvbmNhZA==', 'aWNhZA==', 'and3X2NhZA==', 'and3Y2Fk', 'cmV2aXQ=', 'YXJjaGljYWQ=',
  'bWljcm9zdGF0aW9u', 'bGlicmVjYWQ=', 'cWNhZA==', 'b3BlbnNjYWQ=', 'cmhpbm9jZXJvcw==', 'c2llbWVucyBueA==', 'bngtaWRlYXM=',
  'c29sdmVzcGFjZQ==', 'c2Fsb21l', 'Y2FkcXVlcnk=', 'YnVpbGQxMjNk', 'a2ljYWQ=', 'YWxpYnJl', 'bW9pM2Q=', 'c3BhY2VjbGFpbQ==',
].map(decode);
/**
 * Names spelled like ordinary English words (merging solids, the edge of a solid, a person who invents, an animal):
 * matched only in the capitalised product spelling, or in lower case as a whole quoted identifier. The joined
 * spelling of the second one is not listed: it is the ordinary type name of a solid's edge in this code.
 */
const ordinaryWordNames = ['RnVzaW9u', 'U29saWQgRWRnZQ==', 'SW52ZW50b3I=', 'Umhpbm8='].map(decode);
const patterns: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  ...anyCaseNames.map(name => ({ name, pattern: new RegExp(`(?<![a-z0-9])${escape(name)}(?![a-z0-9])`, 'iu') })),
  ...ordinaryWordNames.map(name => ({ name, pattern: new RegExp(
    `(?<![A-Za-z0-9])${escape(name)}(?![a-z0-9])|(?<=['"\`])${escape(name.toLowerCase())}(?=['"\`])`, 'u') })),
];
/** The two programs that receive a STEP file in the hand-off help: an open-source one and a personal-use edition. */
const [HANDOFF_OPEN_SOURCE, HANDOFF_PERSONAL_USE] = ['ZnJlZWNhZA==', 'RnVzaW9u'].map(decode);
/**
 * Narrow exceptions by exact path and name. The help that hands an exported file to other software, and the checks
 * of that help, keep the receiving software's names (user's answer 2026-11-19 21:2x); any other name is still refused
 * in these files.
 */
const handOffNames: ReadonlyMap<string, readonly string[]> = new Map([
  ['packages/help-content/docs/ja/cam.md', [HANDOFF_OPEN_SOURCE, HANDOFF_PERSONAL_USE]],
  ['packages/help-content/docs/ja/strength.md', [HANDOFF_OPEN_SOURCE]],
  ['packages/ui/src/i18n/ja/file.json', [HANDOFF_OPEN_SOURCE, HANDOFF_PERSONAL_USE]],
  ['packages/ui/src/file/openWith.test.ts', [HANDOFF_OPEN_SOURCE, HANDOFF_PERSONAL_USE]],
  ['e2e/tests/camFlow.ts', [HANDOFF_OPEN_SOURCE, HANDOFF_PERSONAL_USE]],
]);
const skippedDirectories = new Set(['node_modules', 'test-results', 'playwright-report', '__pycache__', 'build', 'dist', 'out', 'coverage']);
const textFile = (path: string): boolean => /\.(?:[cm]?[jt]sx?|json|mdx?|css|html|svg|py|ps1|psm1|rs|cpp|h|ya?ml|txt)$/iu.test(path);

function textFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) return skippedDirectories.has(entry.name) ? [] : textFiles(path);
    return entry.isFile() && textFile(path) ? [path] : [];
  }).sort();
}

function namesIn(text: string): string[] {
  const normalized = text.normalize('NFKC');
  return patterns.filter(({ pattern }) => pattern.test(normalized)).map(({ name }) => name);
}

describe('ほかの CAD の製品の名前を製品・ヘルプ・画面検査・道具に書かない(M06-0c)', () => {
  it('当たる書き方と当たらない書き方を見分ける', () => {
    const [product, mergeWord] = [HANDOFF_PERSONAL_USE, HANDOFF_PERSONAL_USE.toLowerCase()];
    expect(namesIn(`${product}の個人利用版`)).toEqual([product]);
    expect(namesIn(`entry ${mergeWord} keeps one face`)).toEqual([]);
    expect(namesIn(`preset: '${mergeWord}'`)).toEqual([product]);
    expect(namesIn(`${HANDOFF_OPEN_SOURCE.toUpperCase()} の手順`)).toEqual([HANDOFF_OPEN_SOURCE]);
    expect(namesIn(`${HANDOFF_OPEN_SOURCE}Url and x${HANDOFF_OPEN_SOURCE}`)).toEqual([]);
    expect(namesIn('circular solid edge, solidEdge: key')).toEqual([]);
    expect(namesIn('ほかの CAD 2 種と比べた')).toEqual([]);
  });

  it('製品・ヘルプ・画面検査・道具の文字のファイルに、例外の表にない名前が無い', () => {
    const directories = ['packages', 'apps'].flatMap(group => readdirSync(join(root, group), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => `${group}/${entry.name}/src`)
      .filter(directory => existsSync(join(root, directory))));
    directories.push('packages/help-content/docs', 'e2e', 'scripts');
    const hits: string[] = [];
    for (const directory of directories) {
      for (const path of textFiles(directory)) {
        const allowed = handOffNames.get(path) ?? [];
        for (const name of namesIn(readFileSync(join(root, path), 'utf8'))) {
          if (!allowed.includes(name)) hits.push(`${path}: ${Buffer.from(name).toString('base64')}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('例外の表のファイルは実在し、表の名前を今も使っている(使わなくなった例外を残さない)', () => {
    for (const [path, allowed] of handOffNames) {
      expect(existsSync(join(root, path)), path).toBe(true);
      const used = namesIn(readFileSync(join(root, path), 'utf8'));
      for (const name of allowed) expect(used, `${path}: ${Buffer.from(name).toString('base64')}`).toContain(name);
    }
  });
});
