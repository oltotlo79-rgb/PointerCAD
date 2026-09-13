import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FunctionDefinition, SolidBody } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useFunctionPreviewFocus } from './useFunctionPreviewFocus.js';

/** Preview only the actual, XYZ-clipped CAD mesh; no resampling or coordinate clamping. */
export function FunctionSurfacePreview({ definition, body, onDisplay }: {
  readonly definition: FunctionDefinition; readonly body: SolidBody; readonly onDisplay: (visible: boolean) => void;
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null), reset = useRef<(() => void) | null>(null);
  const figure = useFunctionPreviewFocus();
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const release: (() => void)[] = [];
    const cleanup = () => { reset.current = null; for (const dispose of release.reverse()) dispose(); };
    try {
      const renderer = new THREE.WebGLRenderer({ canvas: element, alpha: true, antialias: true });
      release.push(() => { renderer.dispose(); renderer.forceContextLoss(); });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
      camera.up.set(0, 0, 1); camera.position.set(1.8, -2, 1.6);
      const intervals = [definition.bounds.X, definition.bounds.Y, definition.bounds.Z];
      const spans = intervals.map(axis => axis.max.value - axis.min.value), span = Math.max(...spans);
      const center = intervals.map((axis, index) => axis.min.value + spans[index] / 2);
      const positions = Float32Array.from(body.mesh.positions, (value, index) => (value - center[index % 3]) / span);
      const geometry = new THREE.BufferGeometry(); release.push(() => geometry.dispose());
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(body.mesh.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(body.mesh.indices, 1));
      const material = new THREE.MeshStandardMaterial({ color: 0x239fba, roughness: 0.65, side: THREE.DoubleSide });
      release.push(() => material.dispose()); scene.add(new THREE.Mesh(geometry, material));
      scene.add(new THREE.HemisphereLight(0xffffff, 0x697b88, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(2, -1, 3); scene.add(light);
      const box = new THREE.BoxGeometry(spans[0] / span, spans[1] / span, spans[2] / span);
      const edges = new THREE.EdgesGeometry(box); box.dispose(); release.push(() => edges.dispose());
      const lineMaterial = new THREE.LineBasicMaterial({ color: getComputedStyle(element).color, transparent: true, opacity: 0.3 });
      release.push(() => lineMaterial.dispose()); scene.add(new THREE.LineSegments(edges, lineMaterial));
      const controls = new OrbitControls(camera, element); release.push(() => controls.dispose());
      controls.enablePan = false; controls.minDistance = 0.2; controls.maxDistance = 20; controls.update(); controls.saveState();
      const render = () => renderer.render(scene, camera);
      controls.addEventListener('change', render);
      release.push(() => controls.removeEventListener('change', render));
      reset.current = () => { controls.reset(); render(); };
      const resize = () => {
        const size = element.getBoundingClientRect();
        renderer.setSize(Math.max(1, size.width), Math.max(1, size.height), false);
        camera.aspect = Math.max(1, size.width) / Math.max(1, size.height); camera.updateProjectionMatrix(); render();
      };
      const observer = new ResizeObserver(resize); observer.observe(element); release.push(() => observer.disconnect());
      const lost = (event: Event) => { event.preventDefault(); onDisplay(false); };
      element.addEventListener('webglcontextlost', lost); release.push(() => element.removeEventListener('webglcontextlost', lost));
      resize(); onDisplay(true);
    } catch { onDisplay(false); }
    return cleanup;
  }, [definition, body, onDisplay]);
  return <figure ref={figure} className="pcad-function-preview">
    <canvas ref={canvas} aria-label={t('functionPlot.surfacePreviewLabel')} />
    <figcaption>{t('functionPlot.surfacePreviewHint')}</figcaption>
    <p>{t(body.bodyKind === 'solid' ? 'functionPlot.closedSurface' : body.bodyKind === 'mixed' ? 'functionPlot.mixedSurface' : 'functionPlot.openSurface')}
      {body.area === undefined ? null : ` / ${t('functionPlot.area')}: ${body.area.toLocaleString(undefined, { maximumSignificantDigits: 8 })} mm²`}
      {body.bodyKind === 'shell' ? null : ` / ${t('functionPlot.volume')}: ${body.volume.toLocaleString(undefined, { maximumSignificantDigits: 8 })} mm³`}</p>
    <button type="button" onClick={() => reset.current?.()}>{t('functionPlot.resetView')}</button>
  </figure>;
}
