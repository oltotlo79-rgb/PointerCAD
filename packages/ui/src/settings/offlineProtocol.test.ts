import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as protocol from '@pointercad/ui/offline-protocol';
import * as legacyProtocol from '../../../../scripts/vite/offlineProtocol.mjs';
import * as productProtocol from './offlineProtocol.mjs';

describe('offline protocol has one product implementation shared with build tools', () => {
  it('exposes identical functions, values and object instances through both public entries', () => {
    expect(Object.keys(protocol).sort()).toEqual(Object.keys(productProtocol).sort());
    expect(Object.keys(legacyProtocol).sort()).toEqual(Object.keys(productProtocol).sort());
    for (const name of Object.keys(productProtocol)) {
      expect(Reflect.get(protocol, name)).toBe(Reflect.get(productProtocol, name));
      expect(Reflect.get(legacyProtocol, name)).toBe(Reflect.get(productProtocol, name));
    }
  });

  it('retains only forwarding exports in the legacy implementation and declaration paths', () => {
    for (const suffix of ['mjs', 'd.mts']) {
      const source = readFileSync(new URL(`../../../../scripts/vite/offlineProtocol.${suffix}`, import.meta.url), 'utf8');
      expect(source.trim()).toBe("export * from '../../packages/ui/src/settings/offlineProtocol.mjs';");
    }
  });
});
