import { createStandardPartSource, steelProductOptions, steelProducts } from '@pointercad/model';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { BeamCatalogMaterial } from './BeamCatalogMaterial.js';

describe('beam material candidates', () => {
  it('starts with an empty selection and distinguishes the three thickness ranges', () => {
    const row = steelProducts('SS400', 'flatBar')[0];
    if (!row) throw new Error('Missing flat bar fixture');
    const source = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: '100' });
    const html = renderToStaticMarkup(<BeamCatalogMaterial source={source} />);
    expect(html).toMatch(/<option value="" selected=""/u);
    expect(html).toContain(t('beam.catalogMaterialChoose'));
    for (const bound of [16, 40, 100]) expect(html).toContain(`t ≤ ${bound} mm`);
  });

  it('leaves the material fields alone when there is no grade', () => {
    const source = createStandardPartSource('hexBolt', 'M6', { length: '20' });
    expect(renderToStaticMarkup(<BeamCatalogMaterial source={source} />)).toBe('');
  });
});
