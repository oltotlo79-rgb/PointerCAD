import { describe, expect, it } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY, APP_META_CONTENT_SECURITY_POLICY, MANUAL_CONTENT_SECURITY_POLICY,
  MANUAL_META_CONTENT_SECURITY_POLICY, KERNEL_CONTENT_SECURITY_POLICY, FEM_WORKER_CONTENT_SECURITY_POLICY,
  contentSecurityPolicyFor, appendCloudflareSecurityHeaders } from './contentSecurityPolicy.js';

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
  it('保存専用module Workerは同一配信元だけを許可し、配信条件を緩めない', () => {
    expect(directives(APP_CONTENT_SECURITY_POLICY).get('worker-src')).toEqual(["'self'"]);
    const path = '/assets/pcadSave.worker-ab_CD.js';
    expect(contentSecurityPolicyFor(path)).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(appliedPolicies('/index.html').map(policy => directives(policy).get('worker-src'))).toEqual([["'self'"]]);
    expect(directives(APP_CONTENT_SECURITY_POLICY).get('worker-src')).not.toContain('blob:');
  });
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
  it('固定FEM Workerにだけ blob の実行と unsafe-eval を許し、接続・子Worker・既定は広げない', () => {
    expect(contentSecurityPolicyFor('/fem/worker.js')).toBe(FEM_WORKER_CONTENT_SECURITY_POLICY);
    expect(appliedPolicies('/fem/worker.js')).toEqual([FEM_WORKER_CONTENT_SECURITY_POLICY]);
    const fem = directives(FEM_WORKER_CONTENT_SECURITY_POLICY);
    expect([...fem.keys()].sort()).toEqual(['connect-src', 'default-src', 'script-src', 'worker-src']);
    expect(fem.get('default-src')).toEqual(["'none'"]);
    expect(fem.get('script-src')).toEqual(["'self'", 'blob:', "'unsafe-eval'"]);
    expect(fem.get('connect-src')).toEqual(["'self'"]);
    expect(fem.get('worker-src')).toEqual(["'none'"]);
  });
  it.each(['/fem/worker.js/', '/fem/worker.jsx', '/fem/worker.js.map', '/fem/Worker.js', '/FEM/worker.js', '/fem/worker.mjs',
    '/fem/worker-ab_CD.js', '/fem//worker.js', '/fem/sub/worker.js', '/assets/fem/worker.js', '/xfem/worker.js', '/fem', '/fem/',
    '/fem/assets/pyodide.asm.js', '/fem/worker%2Ejs', '/manual/fem/worker.js', '/assets/kernel.worker-ab_CD.js',
    '/assets/pcadSave.worker-ab_CD.js'])('FEM Workerに似た場所%sへその例外を漏らさない', path => {
    expect(contentSecurityPolicyFor(path)).not.toBe(FEM_WORKER_CONTENT_SECURITY_POLICY);
    expect(appliedPolicies(path)).not.toContain(FEM_WORKER_CONTENT_SECURITY_POLICY);
  });
  it('通常画面・保存Worker・説明書・計算部・許諾の条件は blob を実行元にせず、計算部以外は unsafe-eval も持たない', () => {
    for (const path of ['/', '/index.html', '/assets/pcadSave.worker-ab_CD.js', '/licenses/index.html', '/manual/index.html',
      '/manual/chapters/start.html', '/assets/kernel.worker-ab_CD.js']) {
      for (const policy of [contentSecurityPolicyFor(path), ...appliedPolicies(path)]) {
        const script = directives(policy).get('script-src') ?? [];
        expect(script, path).not.toContain('blob:');
        if (policy !== KERNEL_CONTENT_SECURITY_POLICY) expect(script, path).not.toContain("'unsafe-eval'");
      }
    }
  });
  it('公開ヘッダーで blob の実行を許す条件は /fem/worker.js の1か所だけ', () => {
    const lines = appendCloudflareSecurityHeaders('').split('\n'), owners: string[] = [];
    let pattern = '';
    for (const line of lines) {
      if (line.startsWith('/')) { pattern = line; continue; }
      if (!line.trim().startsWith('Content-Security-Policy:')) continue;
      const policy = line.trim().slice('Content-Security-Policy:'.length).trim();
      if ((directives(policy).get('script-src') ?? []).includes('blob:')) owners.push(pattern);
    }
    expect(owners).toEqual(['/fem/worker.js']);
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
