import { describe, expect, it } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY, FEM_WORKER_CONTENT_SECURITY_POLICY,
  appendCloudflareSecurityHeaders, contentSecurityPolicyFor, isFemWorkerAsset } from './contentSecurityPolicy.js';

describe('owned local FEM Worker policy', () => {
  it('grants verified glue execution only to the exact fixed Worker route', () => {
    expect(contentSecurityPolicyFor('/fem/worker.js')).toBe(FEM_WORKER_CONTENT_SECURITY_POLICY);
    expect(FEM_WORKER_CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(FEM_WORKER_CONTENT_SECURITY_POLICY).toContain("worker-src 'none'");
    expect(FEM_WORKER_CONTENT_SECURITY_POLICY).toContain("script-src 'self' blob: 'unsafe-eval'");
    expect(APP_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    expect(APP_CONTENT_SECURITY_POLICY).not.toContain('blob: https:');
    const headers = appendCloudflareSecurityHeaders('');
    expect(headers.split('/fem/worker.js')).toHaveLength(2);
    expect(headers).toContain(`/fem/worker.js\n  Content-Security-Policy: ${FEM_WORKER_CONTENT_SECURITY_POLICY}`);
  });

  it.each(['/fem/worker.js.map', '/fem/worker.js/extra', '/fem/assets/pyodide.js', '/FEM/worker.js',
    '/other/fem/worker.js', '/fem/other.js', '/index.html'])(
    'does not broaden policy for %s', path => {
      expect(isFemWorkerAsset(path)).toBe(false);
      expect(contentSecurityPolicyFor(path)).toBe(APP_CONTENT_SECURITY_POLICY);
    },
  );
});
