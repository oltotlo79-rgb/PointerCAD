import { readFileSync } from 'node:fs';
import { createFontStore } from '@pointercad/drawing';
import { DRAWING_EXAMPLES } from '@pointercad/model';
import { expect, it } from 'vitest';
import { drawingParameterRows } from './drawingNoteFields.js';
import { displayDrawingTables } from './tableDisplay.js';

it('フランジの係数表は埋め込んだ穴径と個数を表示し、用紙の内側で全行が解ける', async () => {
  const { document, library } = await DRAWING_EXAMPLES[0].create();
  expect(document.tables).toHaveLength(1);
  const [table] = document.tables;
  expect(table).toMatchObject({ kind: 'parameter', options: { scope: 'all' },
    columns: ['name', 'value', 'unit', 'description'] });
  expect(table.rows).toBeUndefined();
  expect(drawingParameterRows(document, library, 'all')?.map(row => [row.name, row.value]))
    .toEqual([['boltDia', '8'], ['boltCount', '4']]);
  const fontFile = new URL('../../../../apps/web/public/fonts/NotoSansJP-Regular.otf', import.meta.url);
  const font = createFontStore({ read: () => Promise.resolve(Uint8Array.from(readFileSync(fontFile)).buffer) });
  expect(await font.load()).toBe('ready');
  const display = displayDrawingTables(document, null, library, font.outline);
  expect(display.unresolved).toEqual([]);
  expect(display.items.map(item => item.id)).toEqual([table.id]);
  expect(display.items[0].rowHeights).toHaveLength(3);
});
