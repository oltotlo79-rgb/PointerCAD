import { describe, expect, it } from 'vitest';
import { femAssetFailureKey, femRuntimeFailureText } from './femFailureMessage.js';
import { t } from './i18n/t.js';

describe('計算部の断りの共通の文(A-24)', () => {
  it.each([
    ['asset-missing', 'strength.femFailure.assetMissing'], ['asset-corrupt', 'strength.femFailure.assetCorrupt'],
    ['asset-missing: python_stdlib.zip (HTTP 404)', 'strength.femFailure.assetMissing'],
    ['asset-missing: asset-missing: python_stdlib.zip (network: Failed to fetch)', 'strength.femFailure.assetMissing'],
    ['asset-corrupt: pyodide.asm.wasm (SHA-256)', 'strength.femFailure.assetCorrupt'],
  ] as const)('資産の失敗 %s を共通の鍵にする', (value, key) => {
    expect(femAssetFailureKey(value)).toBe(key);
    expect(femRuntimeFailureText(value.split(':', 1)[0])).toBe(t(key));
  });
  it.each([null, undefined, '', 'solver-failed', 'asset-missingness', 'Preload source changed', 'cad-solid'])('資産の失敗でない %s は null', value => {
    expect(femAssetFailureKey(value)).toBeNull();
  });
  it.each(['offline-request-denied', 'runtime-initialization', 'solver-failed', 'invalid-protocol', 'worker-failed', 'deadline'])(
    '計算部の code %s は内部の文を出さず code を添える', code => {
      expect(femRuntimeFailureText(code)).toBe(t('strength.femFailure.runtime').replace('{code}', code));
      expect(femRuntimeFailureText(code)).not.toContain('{code}');
    });
  it.each(['cad-solid', 'cad-solid-plastic', 'cad-solid-finite', 'stale', ''])('計算部の code でない %s は呼び手の文のまま(null)', code => {
    expect(femRuntimeFailureText(code)).toBeNull();
  });
  it('共通の文は 150 字以内で、次にする事を書く', () => {
    for (const key of ['strength.femFailure.assetMissing', 'strength.femFailure.assetCorrupt'] as const) {
      expect([...t(key)].length).toBeLessThanOrEqual(150);
    }
    expect(t('strength.femFailure.assetMissing')).toContain('もう一度計算を始めてください');
    expect(t('strength.femFailure.assetCorrupt')).toContain('入れ直してください');
  });
});
