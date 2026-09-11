/** 分割・曲げ済みのパネルを、正規Workerへ渡す板金の再構築段にする。 */
import type { SheetLineBendPartition } from './partitionLineBend.js';
import type { SheetBodyPlan } from './resolveSheetGeometry.js';

export function sheetLineBendPlan(partition: SheetLineBendPartition): SheetBodyPlan {
  return { kind: 'sheetBody', panels: [...partition.fixed, ...partition.moving].map((panel) => ({ kind: 'sheetBase',
    outer: panel.outer, holes: panel.holes, normal: panel.normal, reversed: false, thickness: partition.rule.thickness })),
    bends: partition.bands.map((band) => ({ kind: 'profile', frame: partition.frame, radius: partition.rule.radius,
      thickness: partition.rule.thickness, angle: partition.rule.angle, neutralRadius: partition.metrics.neutralRadius,
      outer: band.outer, holes: band.holes })) };
}
