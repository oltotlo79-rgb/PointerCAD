import { loadOcctForNode } from '../occt/loadOcct.node.js';

export { loadOcctForNode };
export { STEP_READ_FAILED_MESSAGE } from '../occt/readStep.js';

/** Use the normal IGES writer to create the real inch-unit box used by the browser and Electron flows. */
export async function makeInchIgesBoxFixture(name: string): Promise<Uint8Array> {
  const [oc, { createAllocations }, { hasIgesBindings }, { writeIges }] = await Promise.all([
    loadOcctForNode(), import('../occt/allocations.js'), import('../occt/igesBindings.js'), import('../occt/writeIges.js'),
  ]);
  if (!hasIgesBindings(oc)) throw new Error('The installed kernel must expose IGES');
  const { keep, release } = createAllocations();
  try {
    const corner = keep(new oc.gp_Pnt_3(-12.7, -6.35, -3.175));
    const shape = keep(keep(new oc.BRepPrimAPI_MakeBox_3(corner, 25.4, 12.7, 6.35)).Shape());
    return writeIges(oc, [{ shape, name, color: [0.25, 0.5, 0.75] }], { unit: 'inch' }).bytes;
  } finally { release(); }
}
