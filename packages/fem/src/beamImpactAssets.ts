/** Fixed impact kernel wrapper (beam_impact.py). Registration request for Root: these are the size and SHA-256 of
 * the reviewed kernel before/impact-contact-r130/numerics-r3/packages/fem/src/beamImpact.py that Root ran locally
 * and natively; Root copies it to packages/fem/src/beamImpact.py and runtime/assets/beamImpact.py and regenerates
 * the manifest. The extracted beamAnalysis.py (fb018e81) stays the FEM_ASSETS entry once Root adopts it. */
export const BEAM_IMPACT_ASSETS = [{ file: 'beamImpact.py', bytes: 31767,
  sha256: '25aa6572c4dcd9891f5321151e02bc05c8eb2132e3233872f093cdf6fa6254a4' }] as const;
