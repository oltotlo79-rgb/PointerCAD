import { describe, expect, it } from 'vitest';
import { findStartupGuardChunk, insertStartupGuard } from '../../../scripts/vite/startupGuard.mjs';

const GUARD = 'C:/repo/packages/ui/src/shell/startupGuardEntry.ts';
function guardChunk(overrides: Record<string, unknown> = {}) {
  return { type: 'chunk', fileName: 'assets/startup-guard-1.js', isEntry: true, facadeModuleId: GUARD,
    imports: [] as string[], dynamicImports: [] as string[], code: 'guard()', ...overrides };
}

describe('起動入口の前に、他を読まない小さな見張りを置く', () => {
  it('見張りを起動入口の直前、セキュリティの設定の後へ1つだけ差し込む', () => {
    const html = '<head><meta http-equiv="Content-Security-Policy" content="x">\n    <script type="module" crossorigin src="/assets/index-1.js"></script></head>';
    const result = insertStartupGuard(html, '/assets/startup-guard-1.js');
    const guardAt = result.indexOf('<script type="module" crossorigin src="/assets/startup-guard-1.js" data-startup-guard></script>');
    expect(guardAt).toBeGreaterThan(result.indexOf('Content-Security-Policy'));
    expect(result.indexOf('src="/assets/index-1.js"')).toBeGreaterThan(guardAt);
    expect(() => insertStartupGuard('<head></head>', '/x.js')).toThrow('Missing startup entry');
    expect(() => insertStartupGuard(result, '/x.js')).toThrow('second module script');
  });

  it('見張りが他のファイルを読む・大きくなる・見つからない組立てを止める', () => {
    expect(findStartupGuardChunk({ 'assets/startup-guard-1.js': guardChunk(), 'index.js': guardChunk({ facadeModuleId: '/apps/web/index.html' }) }).fileName)
      .toBe('assets/startup-guard-1.js');
    expect(() => findStartupGuardChunk({ a: guardChunk({ imports: ['assets/shared.js'] }) })).toThrow('must not load other files');
    expect(() => findStartupGuardChunk({ a: guardChunk({ dynamicImports: ['assets/app.js'] }) })).toThrow('must not load other files');
    expect(() => findStartupGuardChunk({ a: guardChunk({ code: 'x'.repeat(8_193) }) })).toThrow('remain small');
    expect(() => findStartupGuardChunk({})).toThrow('Missing startup guard');
  });
});
