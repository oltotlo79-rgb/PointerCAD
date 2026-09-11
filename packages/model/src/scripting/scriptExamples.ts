export type ScriptExampleId = 'plate' | 'sketch' | 'grid' | 'read';
export interface ScriptExampleProgram { readonly id: ScriptExampleId; readonly source: string }
export const SCRIPT_EXAMPLE_PROGRAMS: readonly ScriptExampleProgram[] = [
  { id: 'plate', source: `cad.parameters.set('板厚', '5');
const plate = cad.solid.box({ x: '60', y: '40', z: '板厚' });
cad.solid.hole(plate, {
  origin: ['10', '0', '-板厚/2'], axis: 'z',
  diameter: '8', depth: '板厚'
});
console.log('穴あき板を作りました');` },
  { id: 'sketch', source: `const sketch = cad.sketch.create('四角い輪郭', 'xy');
const points = [['0','0','0'], ['30','0','0'],
  ['30','20','0'], ['0','20','0']]
  .map(position => cad.sketch.point(sketch, position));
const edges = points.map((point, i) =>
  cad.sketch.line(sketch, point, points[(i+1)%4]));
const face = cad.sketch.face(sketch, edges);
cad.solid.extrude(face, '10');` },
  { id: 'grid', source: `for (let y = 0; y < 5; y++) {
  for (let x = 0; x < 5; x++) {
    cad.solid.box({ origin: [String(x*15), String(y*15), '0'],
      x: '10', y: '10', z: '5' });
  }
}
console.log('25個の箱を作りました');` },
  { id: 'read', source: `const document = cad.document.read();
console.log(document.name);
console.log(JSON.stringify(document.parameters));
console.log(JSON.stringify(document.sketches));
console.log(JSON.stringify(document.solids));` },
];
