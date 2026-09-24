import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

describe('追加計算部の行列分解を独立な等式で照合する', () => {
  it('複素数・矩形・従属・微小成分を保ち、元の行列と恒等式へ戻る', () => {
    const script = fileURLToPath(new URL('./exactRuntime/cas_decompositions_test.py', import.meta.url));
    const result = spawnExactRuntime(['-B', '-X', 'utf8', script], {
      encoding: 'utf8', timeout: 45_000, maxBuffer: 2_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`行列分解の独立照合に失敗しました。Pythonと同梱の固定計算部を確認してください。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    }
  });
});
