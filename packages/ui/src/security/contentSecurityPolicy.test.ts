import { describe, expect, it } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY, APP_META_CONTENT_SECURITY_POLICY, MANUAL_CONTENT_SECURITY_POLICY,
  MANUAL_META_CONTENT_SECURITY_POLICY, KERNEL_CONTENT_SECURITY_POLICY, contentSecurityPolicyFor,
  appendCloudflareSecurityHeaders } from './contentSecurityPolicy.js';

function directives(policy: string) {
  return new Map(policy.split(';').map(value => {
    const [name, ...sources] = value.trim().split(/\s+/u);
    return [name, sources] as const;
  }));
}

// Model only the documented splat/placeholder rules emitted by this generator.
// Public deployment checks must still verify the actual HTTP headers and font loading.
function appliedPolicies(path: string): readonly string[] {
  const result: string[] = [];
  let pattern = '';
  for (const line of appendCloudflareSecurityHeaders('').split('\n')) {
    if (line.startsWith('/')) { pattern = line; continue; }
    if (!line.trim().startsWith('Content-Security-Policy:')) continue;
    const source = pattern.split(/(\*|:[A-Za-z]\w*)/u).map(part => part === '*' ? '.*'
      : /^:[A-Za-z]\w*$/u.test(part) ? '[^/]+'
        : part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('');
    if (new RegExp(`^${source}$`, 'u').test(path)) result.push(line.trim().slice('Content-Security-Policy:'.length).trim());
  }
  return result;
}

describe('説明書に必要な字体の条件を通常画面と計算部へ混在させない', () => {
  it('説明書だけが埋込字体を読め、外部通信や動的なプログラムを許可しない', () => {
    const manual = directives(MANUAL_CONTENT_SECURITY_POLICY), app = directives(APP_CONTENT_SECURITY_POLICY);
    expect(manual.get('font-src')).toEqual(["'self'", 'data:']);
    expect(app.get('font-src')).toEqual(["'self'"]);
    expect(manual.get('script-src')).toEqual(["'self'"]);
    expect(manual.get('connect-src')).toEqual(["'none'"]);
    expect(manual.get('worker-src')).toEqual(["'none'"]);
    expect(manual.get('frame-ancestors')).toEqual(["'none'"]);
    expect(MANUAL_CONTENT_SECURITY_POLICY).not.toContain('unsafe-');
  });
  it.each(['/manual', '/manual/', '/manual/index.html', '/manual/chapters/start.html', '/manual/chapters/start',
    '/manual/volumes/guide.pdf'])('説明書%sへ矛盾のない配信条件を1つだけ適用する', path => {
    expect(contentSecurityPolicyFor(path)).toBe(MANUAL_CONTENT_SECURITY_POLICY);
    expect(appliedPolicies(path)).toEqual([MANUAL_CONTENT_SECURITY_POLICY]);
  });
  it.each(['/', '/index.html', '/other.html', '/manual.html', '/licenses', '/licenses/', '/licenses/index.html',
    '/licenses/exact-math/', '/licenses/exact-math/index.html'])('通常画面%sへ説明書用の許可を追加しない', path => {
    expect(contentSecurityPolicyFor(path)).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(appliedPolicies(path)).toEqual([APP_CONTENT_SECURITY_POLICY]);
  });
  it.each(['/manualish/start.html', '/assets/other.js'])('説明書に似た場所%sを同じ扱いにしない', path => {
    expect(contentSecurityPolicyFor(path)).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(appliedPolicies(path)).not.toContain(MANUAL_CONTENT_SECURITY_POLICY);
  });
  it('計算部の条件は既定の配信名にだけ適用し、説明書の中へ広げない', () => {
    expect(contentSecurityPolicyFor('/assets/kernel.worker-ab_CD.js')).toBe(KERNEL_CONTENT_SECURITY_POLICY);
    expect(appliedPolicies('/assets/kernel.worker-ab_CD.js')).toEqual([KERNEL_CONTENT_SECURITY_POLICY]);
    expect(contentSecurityPolicyFor('/manual/assets/kernel.worker-ab_CD.js')).toBe(MANUAL_CONTENT_SECURITY_POLICY);
  });
  it('HTML本文とHTTP応答の条件を共用し、本文で無効な祖先指定だけを外す', () => {
    for (const [header, meta] of [[APP_CONTENT_SECURITY_POLICY, APP_META_CONTENT_SECURITY_POLICY],
      [MANUAL_CONTENT_SECURITY_POLICY, MANUAL_META_CONTENT_SECURITY_POLICY]]) {
      expect(directives(meta).has('frame-ancestors')).toBe(false);
      for (const [name, sources] of directives(header)) {
        if (name !== 'frame-ancestors') expect(directives(meta).get(name)).toEqual(sources);
      }
    }
  });
});
