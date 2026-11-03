/** Fixed TR_SHELL02 wrapper (loaded as shell_analysis.py). Registration request for Root: these are the size and
 * SHA-256 of the unchanged packages/fem/src/shellAnalysis.py (LF) that the native shell tests run; Root copies the
 * identical bytes to runtime/assets/shellAnalysis.py, which the manifest entry assets/shellAnalysis.py pins. */
export const SHELL_ASSETS = [{ file: 'shellAnalysis.py', bytes: 20375,
  sha256: '4319a6b5943d1144637329f9911b15e3074d190e9beb86976654c9b4717018cf' }] as const;
