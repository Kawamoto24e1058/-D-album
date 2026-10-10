// 推論用の長辺。モデル内部では 518px 前後に縮小されるため、大きく渡しても精度はほぼ変わらない
const INFERENCE_MAX = 768;
// 表示テクスチャの長辺。スマホの GPU で扱える 4096 より余裕を持たせる
const DISPLAY_MAX = 2048;

export interface LoadedPhoto {
  name: string;
  /** 表示用（EXIF を含まない再エンコード済みの画像） */
  display: HTMLCanvasElement;
  /** 推論用の縮小画像 */
  inference: HTMLCanvasElement;
}

function drawScaled(source: ImageBitmap, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D を使えません');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * 写真を読み込む。canvas に描き直すことで EXIF（位置情報を含む）は引き継がれない。
 * 向きは imageOrientation: 'from-image' で EXIF の回転を反映してから捨てる。
 */
export async function loadPhoto(file: File): Promise<LoadedPhoto> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const isHeic = /\.hei[cf]$/i.test(file.name) || /hei[cf]/i.test(file.type);
    throw new Error(
      isHeic
        ? `${file.name}: HEIC はこのブラウザで読めません。JPEG に変換してから追加してください`
        : `${file.name}: 画像を読み込めませんでした`,
    );
  }
  try {
    return {
      name: file.name,
      display: drawScaled(bitmap, DISPLAY_MAX),
      inference: drawScaled(bitmap, INFERENCE_MAX),
    };
  } finally {
    bitmap.close();
  }
}
