import { describe, expect, it } from 'vitest';
import {
  DESKTOP_OCCT_TRANSPORT_ORIGIN, desktopOcctTransportUrl, validateDesktopOcctTransportReply,
} from './desktopOcctTransportContract.js';

const identity = { sha256: 'a'.repeat(64), byteLength: 42 };
const reply = { kind: 'http', url: desktopOcctTransportUrl(identity.sha256), ...identity };

describe('desktop OCCT transport contract', () => {
  it('keeps the product origin fixed independently of test listener ports', () => {
    expect(DESKTOP_OCCT_TRANSPORT_ORIGIN).toBe('http://127.0.0.1:49721');
  });
  it('pins the exact loopback authority and full decoded SHA path', () => {
    expect(reply.url).toBe(`${DESKTOP_OCCT_TRANSPORT_ORIGIN}/occt/${identity.sha256}.wasm`);
    expect(validateDesktopOcctTransportReply(reply, identity)).toEqual(reply);
  });
  it('permits direct transport only for an explicit unavailable owned port', () => {
    expect(validateDesktopOcctTransportReply({ kind: 'direct', reason: 'port-unavailable' }, identity))
      .toEqual({ kind: 'direct', reason: 'port-unavailable' });
    for (const reason of ['permission-denied', 'cache-miss', 'hash-mismatch', undefined]) {
      expect(() => validateDesktopOcctTransportReply({ kind: 'direct', reason }, identity)).toThrow();
    }
  });
  it('rejects foreign listeners, redirects, queries, fragments, credentials and altered identities', () => {
    for (const url of [reply.url.replace('49721', '49722'), reply.url.replace('127.0.0.1', 'localhost'),
      `${reply.url}?x=1`, `${reply.url}#x`, reply.url.replace('http://', 'http://user@'),
      reply.url.replace(identity.sha256, 'b'.repeat(64))]) {
      expect(() => validateDesktopOcctTransportReply({ ...reply, url }, identity)).toThrow();
    }
    for (const value of [null, {}, { ...reply, byteLength: 43 }, { ...reply, sha256: 'b'.repeat(64) },
      { ...reply, extra: true }, { kind: 'direct', reason: 'port-unavailable', url: reply.url }]) {
      expect(() => validateDesktopOcctTransportReply(value, identity)).toThrow();
    }
  });
  it('rejects malformed build identities before accepting a fallback', () => {
    expect(() => desktopOcctTransportUrl('A'.repeat(64))).toThrow();
    for (const byteLength of [0, -1, 1.5, Infinity, 64 * 1024 * 1024 + 1]) {
      expect(() => validateDesktopOcctTransportReply({ kind: 'direct', reason: 'port-unavailable' },
        { ...identity, byteLength })).toThrow();
    }
  });
});
