import type { DimensionTarget, DrawingDocument } from '@pointercad/drawing';

/** 選択対象を増やさず、表・投影線・風船の対応表示にだけ使う配置ID。 */
export function selectedDrawingComponents(document: DrawingDocument, ids: readonly string[], targets: readonly DimensionTarget[]): ReadonlySet<string> {
  const components = new Set(ids.filter((id) => id.startsWith('component:')).map((id) => id.slice('component:'.length)));
  for (const target of targets) if (target.kind === 'subShape' && target.componentId !== undefined) components.add(target.componentId);
  for (const balloon of document.balloons) if (ids.includes(balloon.id)) {
    for (const id of balloon.componentIds) components.add(id);
  }
  return components;
}

/** rowは見出しを0とした紙上の行番号。配置や部品表の並び替えに依存しない形式にする。 */
export function drawingTableRowOwner(tableId: string, row: number): string {
  return row === 0 ? tableId : `bom-row:${JSON.stringify([tableId, row])}`;
}

export function selectedDrawingTableRows(
  tables: readonly { readonly id: string; readonly rowComponentIds: readonly (readonly string[])[] }[],
  selectedIds: readonly string[], components: ReadonlySet<string>,
): ReadonlySet<string> {
  const owners = new Set<string>();
  for (const table of tables) table.rowComponentIds.forEach((ids, index) => {
    if (selectedIds.includes(table.id) || ids.some((id) => components.has(id))) owners.add(drawingTableRowOwner(table.id, index + 1));
  });
  return owners;
}
