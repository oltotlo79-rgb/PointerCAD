import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testOnlyFile } from './packageImportBoundary.testSupport.js';

/**
 * Every external address in the product code (not the tests) and the help is listed here with the files that may hold
 * it and why (M06-0c). A new address, an address in another file, or a listed address that is no longer used fails,
 * so each one is added or removed on purpose. standardSourceNames.test.ts checks publisher names, not addresses.
 * - opened: a page the user opens from the app or the help (software that receives an exported file, this project's
 *   release page).
 * - method: the source of a calculation, an algorithm or a platform behaviour named in a comment or the help.
 * - format: the specification of a file or configuration format that the code reads or writes.
 * - namespace: an XML namespace written into files; it is never fetched.
 * - license: the license text of bundled third-party content.
 * - bundled-source: where a bundled or built third-party file comes from, pinned by version.
 * Loopback addresses and the reserved .invalid names are allowed by rule.
 */
type Reason = 'opened' | 'method' | 'format' | 'namespace' | 'license' | 'bundled-source';
interface AllowedUrl { readonly url: string; readonly reason: Reason; readonly files: readonly string[] }
const allowedUrls: readonly AllowedUrl[] = [
  { url: 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel', reason: 'namespace', files: ['packages/io/src/threemf/writeThreeMf.ts'] },
  { url: 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02', reason: 'namespace', files: ['packages/io/src/threemf/writeThreeMf.ts'] },
  { url: 'http://schemas.openxmlformats.org/package/2006/content-types', reason: 'namespace', files: ['packages/io/src/threemf/writeThreeMf.ts'] },
  { url: 'http://schemas.openxmlformats.org/package/2006/relationships', reason: 'namespace', files: ['packages/io/src/threemf/writeThreeMf.ts'] },
  { url: 'http://scripts.sil.org/OFL', reason: 'license', files: ['packages/help-content/docs/ja/font-licenses.md'] },
  { url: 'http://www.w3.org/2000/svg', reason: 'namespace', files: ['packages/drawing/src/render/toSvg.ts', 'packages/ui/src/drawing/drawingSvgPreview.ts'] },
  { url: 'https://codeload.github.com/quickjs-ng/quickjs/tar.gz/65641a0c1e85cc266d7613d6673a22ec834bb941', reason: 'bundled-source', files: ['packages/model/src/vendor/script-runtime/build-config.json'] },
  { url: 'https://dev.opencascade.org/doc/occt-7.7.0/refman/html/class_b_rep_class3d___solid_classifier.html', reason: 'method', files: ['packages/kernel/src/occt/classifyFunctionSurface.ts'] },
  { url: 'https://developers.cloudflare.com/pages/configuration/headers/', reason: 'format', files: ['packages/ui/src/security/contentSecurityPolicy.ts'] },
  { url: 'https://developers.cloudflare.com/pages/configuration/serving-pages/#route-matching', reason: 'format', files: ['apps/web/src/pwa/offlineNetwork.ts'] },
  { url: 'https://dlmf.nist.gov/4.35', reason: 'method', files: ['packages/expression/src/math/hyperbolicIntervals.ts'] },
  { url: 'https://dlmf.nist.gov/4.37', reason: 'method', files: ['packages/expression/src/math/hyperbolicIntervals.ts'] },
  { url: 'https://dlmf.nist.gov/5.12#E1', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://dlmf.nist.gov/7.6', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://dlmf.nist.gov/7.9', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://dlmf.nist.gov/8.17', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://dlmf.nist.gov/8.9', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://docs.grid.space/kiri-moto/interface/', reason: 'opened', files: ['packages/help-content/docs/ja/cam.md', 'packages/ui/src/file/openWith.ts'] },
  { url: 'https://docs.sympy.org/latest/modules/matrices/matrices.html#sympy.matrices.matrixbase.MatrixBase.singular_value_decomposition', reason: 'method', files: ['packages/expression/src/math/exactSvdDecomposition.ts'] },
  { url: 'https://docs.sympy.org/latest/tutorials/intro-tutorial/matrices.html#eigenvalues-eigenvectors-and-diagonalization', reason: 'method', files: ['packages/expression/src/math/exactEigenspace.ts'] },
  { url: 'https://github.com/Open-Cascade-SAS/OCCT/blob/V7_7_0/src/BRepAlgoAPI/BRepAlgoAPI_Check.cxx', reason: 'method', files: ['packages/kernel/src/occt/classifyFunctionSurface.ts'] },
  { url: 'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-32/libclang_rt-32.0.tar.gz', reason: 'bundled-source', files: ['packages/model/src/vendor/script-runtime/build-config.json'] },
  { url: 'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-32/wasi-sysroot-32.0.tar.gz', reason: 'bundled-source', files: ['packages/model/src/vendor/script-runtime/build-config.json'] },
  { url: 'https://github.com/oltotlo79-rgb/PointerCAD/releases', reason: 'opened', files: ['packages/help-content/docs/ja/desktop-install.md'] },
  { url: 'https://grid.space/kiri/', reason: 'opened', files: ['packages/ui/src/file/openWith.ts'] },
  { url: 'https://help.prusa3d.com/article/first-print-with-prusaslicer-2-9_1753', reason: 'opened', files: ['packages/help-content/docs/ja/cam.md', 'packages/ui/src/file/openWith.ts'] },
  { url: 'https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers', reason: 'method', files: ['packages/kernel/src/worker/yieldToMessages.ts'] },
  { url: 'https://itl.nist.gov/div898/handbook/eda/section3/eda3661.htm', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://itl.nist.gov/div898/handbook/eda/section3/eda3662.htm', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://itl.nist.gov/div898/handbook/eda/section3/eda3664.htm', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://itl.nist.gov/div898/handbook/eda/section3/eda3665.htm', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://itl.nist.gov/div898/handbook/eda/section3/eda3666.htm', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://itl.nist.gov/div898/handbook/eda/section3/eda3667.htm', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://itl.nist.gov/div898/handbook/eda/section3/eda366h.htm', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://itl.nist.gov/div898/handbook/eda/section3/eda366j.htm', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://netlib.org/lapack/explore-html/d0/da1/group__geqrf_gade26961283814bb4e62183d9133d8bf5.html', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT', reason: 'format', files: ['packages/io/src/pcad/zipDirectory.ts'] },
  { url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/LICENSE', reason: 'license', files: ['packages/drawing/src/text/fontAsset.ts'] },
  { url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf', reason: 'bundled-source', files: ['packages/drawing/src/text/fontAsset.ts'] },
  { url: 'https://stat.ethz.ch/R-manual/R-devel/library/stats/html/Binomial.html', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://stat.ethz.ch/R-manual/R-devel/library/stats/html/Poisson.html', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://stat.ethz.ch/R-manual/R-devel/library/stats/html/quantile.html', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://www.itl.nist.gov/div898/handbook/eda/section3/eda366b.htm', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://www.itl.nist.gov/div898/handbook/eda/section3/eda366i.htm', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://www.netlib.org/templates/templates.html', reason: 'method', files: ['packages/model/src/sketch/constraints/sparseSolve.ts'] },
  { url: 'https://www.opendesign.com/guestfiles/oda_file_converter', reason: 'opened', files: ['packages/help-content/docs/ja/dxf.md'] },
  { url: 'https://www.prusa3d.com/p/prusaslicer/', reason: 'opened', files: ['packages/help-content/docs/ja/cam.md', 'packages/ui/src/file/openWith.ts'] },
  { url: 'https://www.rfc-editor.org/rfc/rfc1951.html', reason: 'format', files: ['packages/io/src/pcad/deflateExpandedSize.ts'] },
  { url: 'https://www.stat.berkeley.edu/users/aldous/134/gravner.pdf', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
  { url: 'https://www.stat.berkeley.edu/~ani/s200af18/Lec_08_30.html', reason: 'method', files: ['packages/help-content/docs/ja/math-input.md'] },
];
const root = fileURLToPath(new URL('../../../', import.meta.url));
const urlPattern = /https?:\/\/[^\s'"`<>()[\]{}\\]+/gu;
const trailingPunctuation = /[.,;:!?、。]+$/u;
const allowedByRule = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|[a-z0-9-]+\.invalid)(?:[:/]|$)/u;
const skippedDirectories = new Set(['node_modules', 'test-results', 'playwright-report', '__pycache__', 'build', 'dist', 'out', 'coverage']);
const textFile = (path: string): boolean => /\.(?:[cm]?[jt]sx?|json|mdx?|css|html|svg|py|ps1|psm1|rs|cpp|h|ya?ml|txt)$/iu.test(path);

function productTextFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) return skippedDirectories.has(entry.name) ? [] : productTextFiles(path);
    return entry.isFile() && textFile(path) && !testOnlyFile.test(path) ? [path] : [];
  }).sort();
}

function urlsIn(text: string): string[] {
  return [...text.matchAll(urlPattern)].map(match => match[0].replace(trailingPunctuation, ''))
    .filter(url => !allowedByRule.test(url));
}

function externalUrls(): { url: string; files: string[] }[] {
  const directories = ['packages', 'apps'].flatMap(group => readdirSync(join(root, group), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => `${group}/${entry.name}/src`)
    .filter(directory => existsSync(join(root, directory))));
  directories.push('packages/help-content/docs');
  const found = new Map<string, Set<string>>();
  for (const directory of directories) {
    for (const path of productTextFiles(directory)) {
      for (const url of urlsIn(readFileSync(join(root, path), 'utf8'))) {
        const files = found.get(url) ?? new Set<string>();
        files.add(path);
        found.set(url, files);
      }
    }
  }
  return [...found].map(([url, files]) => ({ url, files: [...files].sort() })).sort((a, b) => (a.url < b.url ? -1 : 1));
}

describe('外のサイトの URL は、表にある物を表にある場所だけに置く(M06-0c)', () => {
  it('読み方: 末尾の句読点を外し、手元の画面と予約の名前は規則で通す', () => {
    expect(urlsIn('出典は https://example.org/a。')).toEqual(['https://example.org/a']);
    expect(urlsIn('[説明](https://example.org/b#c), "https://example.org/d"')).toEqual(['https://example.org/b#c', 'https://example.org/d']);
    expect(urlsIn("open('http://127.0.0.1:5173/'); new URL(href, 'https://manual.invalid/a.md')")).toEqual([]);
  });

  it('表は URL の並びで、同じ URL を 2 度持たない', () => {
    const urls = allowedUrls.map(({ url }) => url);
    expect(urls).toEqual([...new Set(urls)].sort((a, b) => (a < b ? -1 : 1)));
  });

  it('製品のコードとヘルプの URL と置き場所が、表と完全に一致する', () => {
    expect(externalUrls()).toEqual(allowedUrls.map(({ url, files }) => ({ url, files: [...files] })));
  });
});
