export const face = '{"bodyFeatureId":"sheet","origin":{"identity":{"featureId":"sheet","kind":"box-face","role":"top"},"shapeKind":"face","version":1}}';
export const edge = { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'sheet', role: 'top-front' } };
export const vertex = { version: 1, shapeKind: 'vertex', identity: { kind: 'box-vertex', featureId: 'sheet', role: 'top-front-left' } };
export function shellAnalysisInput(documentId: string) {
  return { schema: 'pointercad-shell-cad-analysis/1', id: 'shell-cad-analysis', source: { documentId },
    geometry: { schema: 'pointercad-shell-cad-input/1', id: 'shell-cad', source: { documentId }, bodyFeatureId: 'sheet',
      midsurfaceFaces: [face], thicknessMm: 2, offsetMm: 0 },
    material: { id: 'steel', youngMPa: 210000, poisson: 0.3, source: { kind: 'user-supplied', reference: 'example', condition: '20 C' } },
    supports: [{ kind: 'vertex', origin: vertex, fixed: [true, true, true, true, true, true] },
      { kind: 'edge', origin: edge, fixed: [true, false, true, false, true, false] }],
    edgeLoads: [{ origin: edge, forceNPerMm: [1, -2, 3], momentNmmPerMm: [4, -5, 6] }],
    surface: { linearDeflection: 0.1, angularDeflection: 0.3, maximumNodes: 1000, maximumTriangles: 2000,
      minimumTriangleAreaMm2: 0, minimumAngleDeg: 1, maximumAspectRatio: 20 } };
}
