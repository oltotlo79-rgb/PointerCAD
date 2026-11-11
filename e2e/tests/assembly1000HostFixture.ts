import { writeDocumentBundle } from '../../packages/io/src/index.js';
import {
  buildHostAssembly, HOST_GROUPS, HOST_SAVED_AT, HOST_TOTAL, hostComponentName, hostJointId,
} from '../../packages/io/src/pcad/assemblyDistinctPartsFixture.testSupport.js';
import { createAssemblyDocumentBundle } from '../../packages/model/src/index.js';

/**
 * EX12 W01 host fixture: an ordinary .pcada of 1000 placed components with 1000 distinct embedded definitions, built
 * from the same size table as the io round trip (packages/io/src/pcad/assemblyDistinctPartsFixture.testSupport.ts, which
 * also holds the closed-form volume/XYZ range of every definition and the real-kernel check in
 * assemblyDistinctPartsRoundtrip.test.ts). Layout (successor of the r141 host fixture, which reused 12 shapes):
 * - definition i is a box, a cylinder or a box with a through hole by i % 3, sizes (i + 1, 2 + i / 10, 3 + i % 7);
 * - components 2g / 2g + 1 are anchor-g (fixed) / member-g (movable) at (300g, 0, 0), both turned by 2g mrad about z,
 *   joined between their origin z axes: groups 0 and 1 by sliders (the two driven groups), the other 118 by revolutes;
 * - components 240.. are 760 fixed stock parts stock-k on a 40-column grid, turned by i mrad about z.
 * Every joint holds at rest, so the written placements are the expected resolved/displayed ones. The saved time is
 * historical fixture data.
 */
export const HOST_NAMES: readonly string[] = Array.from({ length: HOST_TOTAL }, (_, index) => hostComponentName(index));
export const HOST_JOINT_IDS: readonly string[] = Array.from({ length: HOST_GROUPS }, (_, group) => hostJointId(group));

export async function assembly1000HostFile(): Promise<Uint8Array> {
  const host = await buildHostAssembly();
  return writeDocumentBundle(createAssemblyDocumentBundle(host.document, host.library), { savedAt: HOST_SAVED_AT });
}
