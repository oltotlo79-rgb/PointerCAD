import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Cloudflare Workers Builds が根で `npx wrangler deploy` を実行するため、根の wrangler.jsonc の
// 内容がサービス名・資産の場所・SPA の扱いを決める(2026-09-28 のログ:
// scratchpad/claude/ci-logs/cloudflare-build-20260928-0212.txt)。
// 参照: https://developers.cloudflare.com/workers/wrangler/configuration/
//       https://developers.cloudflare.com/workers/static-assets/

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** wrangler.jsonc はコメント付き JSON(JSONC)。行頭の `//` コメントだけを取り除いて JSON.parse する。 */
function readWranglerConfig(): Record<string, unknown> {
  const raw = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
  const withoutComments = raw
    .split(/\r?\n/u)
    .map(line => (/^\s*\/\//u.test(line) ? '' : line))
    .join('\n');
  return JSON.parse(withoutComments) as Record<string, unknown>;
}

describe('根の wrangler.jsonc(Cloudflare Workers の静的資産)', () => {
  it('サービス名は pointercad で、main(Worker script)を持たない静的資産だけの構成', () => {
    const config = readWranglerConfig();
    expect(config.name).toBe('pointercad');
    expect(config.main).toBeUndefined();
  });

  it('assets.directory は apps/web のビルド出力(既定の dist)と一致する', () => {
    const config = readWranglerConfig();
    const assets = config.assets as Record<string, unknown>;
    expect(assets.directory).toBe('./apps/web/dist');
    // apps/web/vite.config.ts が outDir を上書きしていないことを確かめる(上書きすると
    // 既定の "dist" とずれて、この一致が崩れる)。
    const viteConfig = readFileSync(join(root, 'apps/web/vite.config.ts'), 'utf8');
    expect(viteConfig).not.toMatch(/outDir\s*:/u);
  });

  it('not_found_handling は single-page-application(react-router 等のパス遷移が無いため直リンクの再読込みでも壊れない側を選ぶ)', () => {
    const config = readWranglerConfig();
    const assets = config.assets as Record<string, unknown>;
    expect(assets.not_found_handling).toBe('single-page-application');
  });
});
