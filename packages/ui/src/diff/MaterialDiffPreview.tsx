import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MaterialComparisonGeometry } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { materialDiffBounds, MATERIAL_REGION_COLORS, selectedMaterialRegions, type MaterialRegionSelection } from './materialDiffView.js';

export function MaterialDiffPreview({ result, selection, onDisplay }: {
  readonly result: MaterialComparisonGeometry; readonly selection: MaterialRegionSelection;
  readonly onDisplay: (ready: boolean) => void;
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null), reset = useRef<(() => void) | null>(null);
  const select = useRef<((value: MaterialRegionSelection) => void) | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const element = canvas.current, bounds = materialDiffBounds(result);
    if (element === null || bounds === null) { onDisplay(false); return; }
    element.dataset.materialReady = 'false';
    const release: (() => void)[] = [];
    const cleanup = () => {
      reset.current = null;
      select.current = null; element.dataset.materialReady = 'false';
      let failed = false;
      for (const dispose of release.splice(0).reverse()) { try { dispose(); } catch { failed = true; } }
      if (failed) onDisplay(false);
    };
    try {
      const renderer = new THREE.WebGLRenderer({ canvas: element, alpha: true, antialias: true });
      release.push(() => { renderer.dispose(); renderer.forceContextLoss(); });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
      camera.up.set(0, 0, 1); camera.position.set(1.8, -2, 1.6);
      const regions: { name: string; mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> }[] = [];
      for (const { name, region } of selectedMaterialRegions(result, 'all')) {
        const geometry = new THREE.BufferGeometry(); release.push(() => geometry.dispose());
        geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(region.mesh.positions,
          (coordinate, index) => (coordinate - bounds.center[index % 3]) / bounds.span), 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(region.mesh.normals, 3));
        geometry.setIndex(new THREE.BufferAttribute(region.mesh.indices, 1));
        const faded = name === 'common';
        const material = new THREE.MeshStandardMaterial({ color: MATERIAL_REGION_COLORS[name], roughness: 0.65,
          side: THREE.DoubleSide, transparent: faded, opacity: faded ? 0.22 : 1, depthWrite: !faded });
        release.push(() => material.dispose()); const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh); regions.push({ name, mesh });
      }
      scene.add(new THREE.HemisphereLight(0xffffff, 0x697b88, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(2, -1, 3); scene.add(light);
      const controls = new OrbitControls(camera, element); release.push(() => controls.dispose());
      controls.enablePan = true; controls.minDistance = 0.2; controls.maxDistance = 20; controls.update(); controls.saveState();
      const render = () => renderer.render(scene, camera);
      // 表示する材料の切替ではカメラもWebGLの領域も作り直さない。
      select.current = value => {
        for (const { name, mesh } of regions) {
          mesh.visible = value === 'all' || value === name;
          const faded = name === 'common' && value === 'all';
          mesh.material.transparent = faded; mesh.material.opacity = faded ? 0.22 : 1;
          mesh.material.depthWrite = !faded; mesh.material.needsUpdate = true;
        }
        render();
      };
      controls.addEventListener('change', render); release.push(() => controls.removeEventListener('change', render));
      reset.current = () => { controls.reset(); render(); };
      const resize = () => {
        const size = element.getBoundingClientRect();
        renderer.setSize(Math.max(1, size.width), Math.max(1, size.height), false);
        camera.aspect = Math.max(1, size.width) / Math.max(1, size.height); camera.updateProjectionMatrix(); render();
      };
      const observer = new ResizeObserver(resize); observer.observe(element); release.push(() => observer.disconnect());
      const lost = (event: Event) => { event.preventDefault(); element.dataset.materialReady = 'false'; onDisplay(false); };
      element.addEventListener('webglcontextlost', lost); release.push(() => element.removeEventListener('webglcontextlost', lost));
      resize(); element.dataset.materialReady = 'true'; onDisplay(true);
    } catch { cleanup(); onDisplay(false); }
    return cleanup;
  }, [result, revision, onDisplay]);
  useEffect(() => { select.current?.(selection); }, [result, revision, selection]);
  return <figure className="pcad-material-diff__preview">
    <canvas key={revision} ref={canvas} aria-label={t('materialDiff.preview')} data-material-selection={selection} />
    <figcaption>{t('materialDiff.previewHint')}</figcaption>
    <button type="button" title={t('materialDiff.resetView')} onClick={() => reset.current?.()}>{t('materialDiff.resetView')}</button>
    <button type="button" title={t('materialDiff.retryDisplay')} onClick={() => { onDisplay(false); setRevision(value => value + 1); }}>{t('materialDiff.retryDisplay')}</button>
  </figure>;
}
