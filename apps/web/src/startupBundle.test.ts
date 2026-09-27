import { describe, expect, it } from 'vitest';
import { assertStartupIsolation } from './startupBundle.js';

function fixture() {
  return {
    'index.js': { type: 'chunk' as const, isEntry: true, facadeModuleId: 'C:/repo/apps/web/index.html',
      imports: ['loader.js'], modules: { 'C:/repo/apps/web/src/bootstrap.ts': {}, 'C:/repo/apps/web/src/startupRecovery.ts': {} }, code: 'start()' },
    'loader.js': { type: 'chunk' as const, imports: [] as string[], modules: { '\0vite/preload-helper.js': {} }, code: 'helper()' },
    'app.js': { type: 'chunk' as const, imports: [], modules: { 'C:/repo/packages/ui/src/index.ts': {} }, code: 'app()' },
  };
}
describe('実際の組立てで起動復旧へ本体の依存を戻さない', () => {
  it('独立した起動入口を受け入れ、後から読む本体は別に保つ', () => {
    expect(() => assertStartupIsolation(fixture())).not.toThrow();
  });
  it('読み込み補助処理から本体へ間接依存すると組立てを止める', () => {
    const bundle = fixture(); bundle['loader.js'].imports.push('app.js');
    expect(() => assertStartupIsolation(bundle)).toThrow('Application dependency');
  });
  it('不明な外部読込み・入口欠落・大きな埋込みを拒否する', () => {
    const unresolved = fixture(); unresolved['loader.js'].imports.push('missing.js');
    expect(() => assertStartupIsolation(unresolved)).toThrow('Unresolved');
    expect(() => assertStartupIsolation({})).toThrow('Missing');
    const large = fixture(); large['index.js'].code = 'x'.repeat(65_537);
    expect(() => assertStartupIsolation(large)).toThrow('small and independent');
  });
});
