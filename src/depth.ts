import { pipeline, RawImage, type DepthEstimationPipeline } from '@huggingface/transformers';

// ライセンス: Depth Anything V2 は Small のみ Apache-2.0。Base 以上（CC-BY-NC-4.0）は使わない
const MODEL_ID = 'onnx-community/depth-anything-v2-small';

export type Backend = 'webgpu' | 'wasm';

export interface DepthMap {
  /** 0-255 の相対深度（値が大きいほど手前） */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface DepthEstimator {
  backend: Backend;
  dtype: string;
  loadMs: number;
  estimate(image: HTMLCanvasElement): Promise<{ depth: DepthMap; inferMs: number }>;
}

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export async function loadDepthEstimator(
  onProgress: (message: string) => void,
): Promise<DepthEstimator> {
  const backend: Backend = (await hasWebGPU()) ? 'webgpu' : 'wasm';
  // PC は fp16（約50MB）、スマホは q4f16（約19MB）。WASM は fp16 非対応の環境があるため q8
  const dtype = backend === 'wasm' ? 'q8' : isMobile() ? 'q4f16' : 'fp16';

  const files = new Map<string, { loaded: number; total: number }>();
  const started = performance.now();
  const estimator = (await pipeline('depth-estimation', MODEL_ID, {
    device: backend,
    dtype,
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== 'progress' || !p.file) return;
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      onProgress(`モデルを取得中 ${mb(loaded)} / ${mb(total)} MB`);
    },
  })) as DepthEstimationPipeline;
  const loadMs = performance.now() - started;

  return {
    backend,
    dtype,
    loadMs,
    async estimate(image) {
      const t0 = performance.now();
      const output = await estimator(RawImage.fromCanvas(image));
      const inferMs = performance.now() - t0;
      const { depth } = Array.isArray(output) ? output[0] : output;
      return {
        depth: { data: depth.data as Uint8Array, width: depth.width, height: depth.height },
        inferMs,
      };
    },
  };
}
