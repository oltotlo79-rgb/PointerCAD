/** Span-only fixed Python programs; Root supplies matching physical files separately. Old FEM_ASSETS stay unchanged. */
export const WELD_SPAN_CONTACT_ASSETS = [
  { file: 'beamWeldSpanBase.py', bytes: 34386, sha256: '917def52a0b14e620ba497bb56eaa28e2ba546b664429bfb0c4704d71cb00562' },
  { file: 'beamWeldSpan.py', bytes: 15620, sha256: '7ff11d7154c67200d4635adfbfb19145d0312ab726b178cceb5a3e3a161cd326' },
  { file: 'beamWeldSpanContact.py', bytes: 4911, sha256: 'b2e0af35d952ed84d122dc0f5fc2c7d7fc429816c0bdf213978f97c2792f33d1' },
] as const;
