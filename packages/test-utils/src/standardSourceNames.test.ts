import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { productFiles } from './packageImportBoundary.testSupport.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// Base64 keeps the prohibited literal spellings out of the published source, including this test.
const decode = (word: string): string => Buffer.from(word, 'base64').toString('utf8');
const names = [
  '44Of44K544Of', 'bWlzdW1p', '5pel5pys6YmE6Yu86YCj55uf', 'amlzZg==', '5pel5pys6KaP5qC85Y2U5Lya',
  '5pel5pys6KO96YmE', 'bmlwcG9uc3RlZWw=', 'bmlwcG9uLQ==', '546L5a2Q6KO96YmE', '5aSn6Ziq6KO96ZC1',
  'b3Nha2E=', '5aSn5ZKM5bel5qWt', '44Ok44Oe44OI44K544OB44O844Or', 'eWFtYXRv', '5ZCI5ZCM6KO96ZC1',
  'Z29kby1zdGVlbA==', '5aSq5bmz6Yu85p2Q', 'dGFpaGVpa291emFp', 'amZl', '5pel5pys44Ki44Or44Of44OL44Km44Og5Y2U5Lya',
  'YWx1bWludW0ub3IuanA=', 'amFhLWE1MDUy', '5qS/5pys44OB44Ko44Kk44Oz', 'dHN1YmFraQ==', 'Y29yc3BhY2U=',
  'eWFtYXdh', '44Of44Or44Kz44Oz', 'bWlsY29u', '44OP44O844OJ44Ot44OD44Kv', 'aGFyZGxvY2s=',
  'ZmFzdGVuYWw=', 'aGVscC5zb2xpZHdvcmtzLmNvbQ==', 'c29saWR3b3Jrc+WFrOW8j+ODmOODq+ODlw==', 'cnVsZXMuZG52LmNvbQ==', 'd3d3Lm5hc2EuZ292L3dwLWNvbnRlbnQvdXBsb2Fkcy8yMDE4LzAxL25hc2Etc3Rk',
  'cmFub2Jsb2c=',
].map(decode);
const shortNames = ['anNh', 'bmJr', 'b3Nn'].map(decode);
// Match short initialisms as independent words or identifier prefixes. Preserve unrelated mixed-case API names.
const shortPatterns = shortNames.map(word => new RegExp(`(?<![a-z0-9])${word}(?![a-z0-9])`, 'iu'));
const textFile = (file: string): boolean => /\.(?:[cm]?[jt]sx?|json|mdx?|css|html|svg|py|rs|cpp|h|ya?ml|txt)$/iu.test(file);
const auditInventory = 'packages/test-utils/src/unusedExportsBaseline.json';

it('keeps material and dimensional reference publishers out of product sources and help', () => {
  const dirs = ['packages', 'apps'].flatMap(group => readdirSync(join(root, group), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => `${group}/${entry.name}/src`)
    .filter(dir => existsSync(join(root, dir))));
  dirs.push('packages/help-content/docs');
  const hits: string[] = [];
  for (const dir of dirs) {
    for (const path of productFiles(root, dir, textFile)) {
      if (path === auditInventory) continue;
      const original = readFileSync(join(root, path), 'utf8').normalize('NFKC');
      const text = original.toLowerCase();
      if (names.some(word => text.includes(word)) || shortNames.some(word => original.includes(word.toUpperCase()))
        || shortPatterns.some(pattern => pattern.test(original))) hits.push(path);
    }
  }
  expect(hits).toEqual([]);
});
