import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/** Inspect rendered pixels and actual button bounds, independent of the projection formula. */
export async function checkFunctionPreviewBounds(page: Page, info: TestInfo, preview: Locator, name: string): Promise<void> {
  const canvas = preview.locator('canvas');
  const paintedImage = () => canvas.evaluate(element => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('確認図のcanvasがありません');
    return element.toDataURL('image/png');
  });
  for (const [index, movement] of [[0, 0], [70, 25], [-140, -50], [70, 25]].entries()) {
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('確認図がありません');
    if (index > 0) {
      const beforeRotation = await paintedImage();
      const start = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.7 };
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(start.x + movement[0], start.y + movement[1], { steps: 5 });
      await page.mouse.up();
      await expect.poll(paintedImage, { message: '回転操作の後に確認図の実描画が更新されること' })
        .not.toBe(beforeRotation);
    }
    await expect.poll(async () => canvas.evaluate(element => {
      if (!(element instanceof HTMLCanvasElement)) throw new Error('確認図のcanvasがありません');
      const context = element.getContext('2d');
      if (!context) return { visible: false, hasMargin: false, markersInside: false, axes: [], axesClear: false };
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      let left = element.width, top = element.height, right = -1, bottom = -1;
      for (let y = 0; y < element.height; y += 1) for (let x = 0; x < element.width; x += 1) {
        if (pixels[(y * element.width + x) * 4 + 3] < 20) continue;
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      const bounds = element.getBoundingClientRect(), scale = element.width / bounds.width;
      const inset = Math.min(left, top, element.width - right - 1, element.height - bottom - 1) / scale;
      const markers = Array.from(element.parentElement?.querySelectorAll('.pcad-function-point-marker') ?? []);
      const markersInside = markers.every(marker => {
        const point = marker.getBoundingClientRect();
        return point.left >= bounds.left && point.right <= bounds.right && point.top >= bounds.top && point.bottom <= bounds.bottom;
      });
      const labels = Array.from(element.parentElement?.querySelectorAll('.pcad-function-axis-label') ?? []);
      const axesClear = labels.every(label => {
        const name = label.getBoundingClientRect();
        return name.left >= bounds.left + 8 && name.right <= bounds.right - 8
          && name.top >= bounds.top + 8 && name.bottom <= bounds.bottom - 8
          && markers.every(marker => {
            const point = marker.getBoundingClientRect();
            return name.right <= point.left || point.right <= name.left || name.bottom <= point.top || point.bottom <= name.top;
          });
      });
      return { visible: right >= left && bottom >= top, hasMargin: inset >= 8, markersInside,
        axes: labels.map(label => label.textContent), axesClear };
    }), { message: '実際に描かれたXYZの枠と軸名、候補ボタンが回転後も確認図の内側に収まること' })
      .toEqual({ visible: true, markersInside: true, hasMargin: true, axes: ['X','Y','Z'], axesClear: true });
  }
  await page.screenshot({ path: info.outputPath(`${name}-rotated-bounds.png`), fullPage: true });
}
