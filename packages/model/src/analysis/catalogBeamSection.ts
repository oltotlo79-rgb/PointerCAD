import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../assembly/catalog/registry.js';
import { catalogItemRow } from '../assembly/catalog/source.js';
import { FAMILY_KEY } from '../assembly/componentNames.js';
import type { ComponentSource } from '../assembly/types.js';

type CatalogBeamSection = {
  readonly ok: true;
  readonly areaMm2: number;
  readonly ixCm4: number;
  readonly iyCm4: number;
  readonly cx: 0;
  readonly cy: 0;
  readonly principalAngle: 0;
  readonly reference: string;
} | {
  readonly ok: false;
  readonly reason: 'not-catalog-item' | 'unresolved-row' | 'unsupported-family' | 'missing-properties' | 'unverified-symmetry';
};

const positive = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

/** In the rectangular grid generator each face uses centred slots and each corner the same radius and hole pattern. */
const matchingFaces = (first: number | undefined, opposite: number | undefined): boolean =>
  (first === 0 || first === 1) && first === opposite;

/** Published section properties in the printed units. The two mirror axes meet at the local origin. */
export function catalogBeamSection(source: ComponentSource, registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): CatalogBeamSection {
  if (source.kind !== 'standardPart' || source.catalog !== 'catalogItem') return { ok: false, reason: 'not-catalog-item' };
  const familyId = source.options[FAMILY_KEY];
  const family = familyId === undefined ? undefined : registry.loaded(familyId);
  if (family === undefined) return { ok: false, reason: 'unresolved-row' };
  if (family.diagram !== 'tSlotSeries') return { ok: false, reason: 'unsupported-family' };
  const row = catalogItemRow(source, registry);
  if (row === null) return { ok: false, reason: 'unresolved-row' };
  const { areaMm2, ixCm4, iyCm4, outlineSection, armWidth, slotTop, slotBottom, slotLeft, slotRight } = row.dims;
  if (!row.verified || row.verification !== 'manufacturer-catalog' || !positive(areaMm2) || !positive(ixCm4) || !positive(iyCm4)) {
    return { ok: false, reason: 'missing-properties' };
  }
  if (outlineSection !== undefined || armWidth !== undefined || row.simplifiedKinds?.includes('slotPositionSymmetric')
    || !matchingFaces(slotTop, slotBottom) || !matchingFaces(slotLeft, slotRight)) {
    return { ok: false, reason: 'unverified-symmetry' };
  }
  return { ok: true, areaMm2, ixCm4, iyCm4, cx: 0, cy: 0, principalAngle: 0,
    reference: `${row.evidence.title} ${row.evidence.locator}` };
}
