import { describe, expect, it } from 'vitest';
import { ExportHandoffRegistry } from './exportHandoffRegistry.js';
describe('既定アプリへ渡す成功済みの書き出し先', () => {
  it('保存が完了するまで渡さず、異なる窓・偽の札や任意パスは拒む', () => {
    const registry = new ExportHandoffRegistry(), revision = registry.begin(1);
    expect(registry.resolve(1, 'part.stl')).toBeNull();
    const token = registry.complete(1, revision, 'stl', '/output/part.stl');
    expect(token).toBeTruthy(); expect(token).not.toContain('part');
    expect(registry.resolve(1, token)).toBe('/output/part.stl');
    expect(registry.resolve(2, token)).toBeNull(); expect(registry.resolve(1, '/output/part.stl')).toBeNull();
  });
  it('次の保存の取消・失敗でも、それ以前の保存先へ戻さない', () => {
    const registry = new ExportHandoffRegistry(), old = registry.begin(1);
    const token = registry.complete(1, old, 'step', '/output/part.step');
    registry.begin(1);
    expect(registry.resolve(1, token)).toBeNull();
    expect(registry.complete(1, old, 'step', '/output/late.step')).toBeNull();
  });
  it('完了が逆順になっても新しい操作の保存先を保持する', () => {
    const registry = new ExportHandoffRegistry(), old = registry.begin(1), current = registry.begin(1);
    const token = registry.complete(1, current, '3mf', '/output/current.3mf');
    expect(registry.complete(1, old, 'stl', '/output/old.stl')).toBeNull();
    expect(registry.resolve(1, token)).toBe('/output/current.3mf');
  });
  it('窓破棄や新規文書では進行中の保存も無効になる', () => {
    const registry = new ExportHandoffRegistry(), revision = registry.begin(1);
    registry.clear(1);
    expect(registry.complete(1, revision, 'stl', '/output/late.stl')).toBeNull();
  });
  it('STEPのstp拡張子は許可するが、実行形式・偽の二重拡張子は許可しない', () => {
    const registry = new ExportHandoffRegistry();
    expect(registry.complete(1, registry.begin(1), 'step', '/output/file.STP')).toBeTruthy();
    for (const path of ['/output/file.exe', '/output/file.stl.cmd', '/output/file', '/output/file.step']) {
      expect(() => registry.complete(1, registry.begin(1), 'stl', path)).toThrow('この種類');
    }
  });
});
