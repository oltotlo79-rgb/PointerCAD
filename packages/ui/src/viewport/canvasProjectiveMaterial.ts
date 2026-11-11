/**
 * MeshBasicMaterialの色空間・透過・両面/深度の挙動を保ったまま、下絵の標本位置だけを
 * 真の射影へ置き換える。4頂点の通常UV補間では内部の格子点がずれるため、fragmentで
 * 同次除算する。係数を解く正本はmodelのcanvasHomography.tsだけ。
 */

import type { CanvasHomography } from '@pointercad/model';
import * as THREE from 'three';

const MAP_FRAGMENT = `
#ifdef USE_MAP
  vec2 destination = vec2( vMapUv.x, 1.0 - vMapUv.y );
  vec3 source = canvasHomography * vec3( destination, 1.0 );
  if ( source.z <= 1.0e-10 ) discard;
  vec2 sourceUv = vec2( source.x / source.z, 1.0 - source.y / source.z );
  vec4 sampledDiffuseColor = texture2D( map, sourceUv );
  #ifdef DECODE_VIDEO_TEXTURE
    sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
  #endif
  diffuseColor *= sampledDiffuseColor;
#endif
`;

export interface CanvasProjectiveMapping {
  /** 行優先のmodel行列をthree.jsの列優先uniform表現へ入れる。 */
  readonly setHomography: (homography: CanvasHomography) => void;
}

/**
 * 既存のMeshBasicMaterialへ射影標本だけを付ける。material.mapは呼出側が持ち、
 * 画像差替え・削除時のtexture/material/geometry dispose契約はそのまま。
 */
export function attachCanvasProjectiveMapping(material: THREE.MeshBasicMaterial): CanvasProjectiveMapping {
  const uniform = { value: new THREE.Matrix3() };
  material.onBeforeCompile = shader => {
    const common = '#include <common>';
    const map = '#include <map_fragment>';
    if (!shader.fragmentShader.includes(common) || !shader.fragmentShader.includes(map)) {
      throw new Error('Three.js canvas map shader chunks changed');
    }
    shader.uniforms['canvasHomography'] = uniform;
    shader.fragmentShader = shader.fragmentShader
      .replace(common, `${common}\nuniform mat3 canvasHomography;`)
      .replace(map, MAP_FRAGMENT);
  };
  material.customProgramCacheKey = () => 'pointercad-canvas-projective-v1';
  return {
    setHomography(homography): void {
      uniform.value.set(
        homography[0], homography[1], homography[2],
        homography[3], homography[4], homography[5],
        homography[6], homography[7], homography[8],
      );
    },
  };
}
