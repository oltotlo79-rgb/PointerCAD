/** 部品 JSON: 下絵画像の参照。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  type ExpressionValueJson,
  fieldProblem,
  joinPath,
  readBoolean,
  readExpression,
  readString,
} from '../guards.js';
import {
  readCoordinate,
  serializeCoordinate,
} from './coordinates.js';
import {
  readList,
  serializeExpression,
} from './fields.js';
import {
  type SketchCanvas,
  type WorkPlaneId,
} from '@pointercad/model';

/**
 * 下絵 1 枚(FR-332、版7、P6 タスク38)。
 *
 * **画像のバイト列はここに 1 バイトも書かない。** `imageId` が `.pcad` の ZIP のエントリ
 * (`canvases/<imageId>.png`、`pcadFile.ts`)を指すだけで、`document.json` には id と
 * 寸法しか入れない(読み込んだ B-rep・三角形と同じ流儀。§2.8)。
 */
export function serializeSketchCanvas(canvas: SketchCanvas): SketchCanvas {
  return {
    id: canvas.id,
    name: canvas.name,
    plane: canvas.plane,
    imageId: canvas.imageId,
    width: serializeExpression(canvas.width),
    height: serializeExpression(canvas.height),
    origin: serializeCoordinate(canvas.origin),
    rotation: serializeExpression(canvas.rotation),
    opacity: serializeExpression(canvas.opacity),
    visible: canvas.visible,
  };
}

/**
 * 下絵の不透明度(FR-332)。**0〜1** の式を読む(外観の透過率が 0〜100% なのと
 * 尺度が違う。理由は model の `SketchCanvas.opacity` の注記)。式が壊れて評価値が
 * NaN のときは `readExpression` が既に許容しているので対象にせず、有限の数で
 * 範囲外なら壊れたファイルとして断る(`readAppearancePercent` と同じ形)。
 */
function readCanvasOpacity(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ExpressionValueJson> {
  const value = readExpression(source, key, parentPath);
  if (!value.ok) {
    return value;
  }
  const evaluated = value.value.value;
  if (!Number.isNaN(evaluated) && (evaluated < 0 || evaluated > 1)) {
    return fieldProblem(joinPath(parentPath, key), 'type');
  }
  return value;
}

/**
 * 下絵 1 枚(FR-332、版7、P6 タスク38)を読む。
 *
 * `imageId` は ZIP のエントリを指す名前で、**指す先が入っているかはここでは見ない**
 * (`pcadFile.ts` の `findMissingAttachment` が `missingField` で断る。`document.json`
 * だけを読むこの層は ZIP の中身を知らない)。`plane` は作業平面の id なので、
 * ミラーの `MirrorPlane` と同じくただの文字列として読む(実在するかは解決が見る)。
 */
function readSketchCanvasItem(value: unknown, path: string): Checked<SketchCanvas> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const id = readString(record.value, 'id', path);
  if (!id.ok) {
    return id;
  }
  const name = readString(record.value, 'name', path);
  if (!name.ok) {
    return name;
  }
  const plane: Checked<WorkPlaneId> = readString(record.value, 'plane', path);
  if (!plane.ok) {
    return plane;
  }
  const imageId = readString(record.value, 'imageId', path);
  if (!imageId.ok) {
    return imageId;
  }
  const width = readExpression(record.value, 'width', path);
  if (!width.ok) {
    return width;
  }
  const height = readExpression(record.value, 'height', path);
  if (!height.ok) {
    return height;
  }
  const origin = readCoordinate(record.value, 'origin', path);
  if (!origin.ok) {
    return origin;
  }
  const rotation = readExpression(record.value, 'rotation', path);
  if (!rotation.ok) {
    return rotation;
  }
  const opacity = readCanvasOpacity(record.value, 'opacity', path);
  if (!opacity.ok) {
    return opacity;
  }
  const visible = readBoolean(record.value, 'visible', path);
  if (!visible.ok) {
    return visible;
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      plane: plane.value,
      imageId: imageId.value,
      width: width.value,
      height: height.value,
      origin: origin.value,
      rotation: rotation.value,
      opacity: opacity.value,
      visible: visible.value,
    },
  };
}

/**
 * 下絵(FR-332)を読む。**版7からは必須**(`selectionSets` とまったく同じ道筋)。
 */
export function readCanvases(
  record: Record<string, unknown>,
  path: string,
): Checked<readonly SketchCanvas[]> {
  return readList(record, 'canvases', path, readSketchCanvasItem);
}
