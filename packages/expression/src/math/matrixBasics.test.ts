import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

describe('追加計算部の行列基本演算を独立な等式で照合する', () => {
  it('転置・随伴・逆・trace・detの恒等式と非正方・特異・記号成分の拒否を通す', () => {
    const script = fileURLToPath(new URL('./exactRuntime/cas_matrix_basics_test.py', import.meta.url));
    const result = spawnExactRuntime(['-B', '-X', 'utf8', script], {
      encoding: 'utf8', timeout: 45_000, maxBuffer: 2_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`行列基本演算の独立照合に失敗しました。Pythonと同梱の固定計算部を確認してください。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    }
  });
});
