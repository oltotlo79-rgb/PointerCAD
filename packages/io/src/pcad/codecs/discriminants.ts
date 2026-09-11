/** 部品 JSON: 複数の値型で共用する判別値。documentJson.ts への逆向きの依存を持たない。 */

import {
  type PlaneSpec,
  type PointReference,
  type RevolveAxis,
} from '@pointercad/model';

type VertexReference = Extract<PointReference, { readonly kind: 'vertex' }>;

export const VERTEX_NAMES: readonly VertexReference['vertex'][] = ['start', 'end', 'center'];

type WorldRevolveAxis = Extract<RevolveAxis, { readonly kind: 'world' }>;

export const WORLD_AXES: readonly WorldRevolveAxis['axis'][] = ['x', 'y', 'z'];

export type PointAndEdgeSpec = Extract<PlaneSpec, { readonly kind: 'pointAndEdge' }>;
