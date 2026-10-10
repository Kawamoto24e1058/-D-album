import * as THREE from 'three';
import type { DepthMap } from './depth';

/*
 * 表示の考え方
 * - カメラを撮影位置（原点）に置き、各頂点を「カメラからの視線の方向 × 深度」に置く。
 *   こうすると中央から見たときは元の写真と完全に一致し、視点を動かしたときだけ視差が出る
 * - 深度推定の出力は相対的な逆深度（値が大きいほど手前）なので、Z = D0 / (1 + s * (d - 0.5)) で距離に直す
 * - 輪郭の裏の穴を黒く見せないため、前景を背景側へ押し広げた深度で描いた「背面レイヤー」を先に描く
 */

const vertexShader = /* glsl */ `
  uniform sampler2D uDepth;
  uniform float uStrength;
  uniform float uD0;
  uniform vec2 uSize;
  uniform float uBias;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // 深度マップは上の行から並んでいるので v を反転して読む
    float d = texture2D(uDepth, vec2(uv.x, 1.0 - uv.y)).r;
    float z = uD0 / max(0.25, 1.0 + uStrength * (d - 0.5));
    vec2 xy = position.xy * uSize * (z / uD0);
    vec3 p = vec3(xy, -z) * uBias;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

// 深度の段差が大きい箇所（輪郭の引き伸ばしが出る場所）を透明にし、背面レイヤーを見せる
const frontFragment = /* glsl */ `
  uniform sampler2D uPhoto;
  uniform sampler2D uDepth;
  uniform vec2 uTexel;
  uniform float uEdge;
  varying vec2 vUv;
  void main() {
    vec2 duv = vec2(vUv.x, 1.0 - vUv.y);
    float dx = texture2D(uDepth, duv + vec2(uTexel.x, 0.0)).r - texture2D(uDepth, duv - vec2(uTexel.x, 0.0)).r;
    float dy = texture2D(uDepth, duv + vec2(0.0, uTexel.y)).r - texture2D(uDepth, duv - vec2(0.0, uTexel.y)).r;
    float grad = length(vec2(dx, dy));
    float alpha = uEdge >= 1.0 ? 1.0 : 1.0 - smoothstep(uEdge * 0.5, uEdge, grad);
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(texture2D(uPhoto, vUv).rgb, alpha);
    #include <colorspace_fragment>
  }
`;

const backFragment = /* glsl */ `
  uniform sampler2D uPhoto;
  varying vec2 vUv;
  void main() {
    // 背面は少し暗くして、前景との境目を目立たなくする
    gl_FragColor = vec4(texture2D(uPhoto, vUv).rgb * 0.92, 1.0);
    #include <colorspace_fragment>
  }
`;

/** 前景を背景側（値の小さい側）へ押し広げる。可分な最小値フィルタ */
function dilateFar(src: DepthMap, radius: number): Uint8Array {
  const { width: w, height: h, data } = src;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 255;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      for (let i = x0; i <= x1; i++) if (data[row + i] < m) m = data[row + i];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 255;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(h - 1, y + radius);
      for (let i = y0; i <= y1; i++) if (tmp[i * w + x] < m) m = tmp[i * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

function depthTexture(data: Uint8Array, w: number, h: number) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export interface ViewerParams {
  /** 奥行きの強さ（逆深度に掛ける係数） */
  depthScale: number;
  /** 視点の移動範囲（写真までの距離を 1 としたときの最大ずれ） */
  maxOffset: number;
  /** 輪郭を透明にする閾値（1 で無効） */
  edge: number;
}

const D0 = 1;
const FOV = 40;

export class Viewer {
  readonly params: ViewerParams = { depthScale: 1.0, maxOffset: 0.1, edge: 0.15 };
  /** 操作がないときに、ゆっくり視点を回して立体感を見せる */
  autoMotion = true;
  /** 直近 1 秒の平均 fps */
  fps = 0;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
  private group = new THREE.Group();
  private geometry: THREE.PlaneGeometry | null = null;
  private materials: THREE.ShaderMaterial[] = [];
  private textures: THREE.Texture[] = [];
  private size = new THREE.Vector2(1, 1);
  private aspect = 1;

  private target = new THREE.Vector2();
  private current = new THREE.Vector2();
  private dragging = false;
  private dragStart = new THREE.Vector2();
  private gyroBase: { beta: number; gamma: number } | null = null;
  private gyroActive = false;
  private keys = new THREE.Vector2();
  private lastInput = -Infinity;
  private autoPhase = 0;

  private pixelRatio = Math.min(window.devicePixelRatio, 2);
  private frames = 0;
  private fpsWindowStart = performance.now();
  private last = performance.now();

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearColor(0x111111);
    container.appendChild(this.renderer.domElement);
    this.scene.add(this.group);
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  show(photo: HTMLCanvasElement, depth: DepthMap) {
    this.group.clear();
    this.geometry?.dispose();
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
    this.aspect = photo.width / photo.height;

    const photoTex = new THREE.CanvasTexture(photo);
    photoTex.colorSpace = THREE.SRGBColorSpace;
    const frontDepth = depthTexture(depth.data, depth.width, depth.height);
    const radius = Math.max(2, Math.round(Math.max(depth.width, depth.height) / 60));
    const backDepth = depthTexture(dilateFar(depth, radius), depth.width, depth.height);
    this.textures = [photoTex, frontDepth, backDepth];

    const segX = 256;
    const segY = Math.max(1, Math.round(segX / this.aspect));
    this.geometry = new THREE.PlaneGeometry(1, 1, segX, segY);

    const shared = {
      uPhoto: { value: photoTex },
      uStrength: { value: this.params.depthScale },
      uD0: { value: D0 },
      uSize: { value: this.size },
    };
    // 背面レイヤーはわずかに奥へ置き、前景と重なったときに手前へ出ないようにする
    const back = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: backFragment,
      uniforms: { ...shared, uDepth: { value: backDepth }, uBias: { value: 1.01 } },
    });
    const front = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: frontFragment,
      transparent: true,
      uniforms: {
        ...shared,
        uDepth: { value: frontDepth },
        uBias: { value: 1 },
        uTexel: { value: new THREE.Vector2(1 / depth.width, 1 / depth.height) },
        uEdge: { value: this.params.edge },
      },
    });
    this.materials = [back, front];
    const backMesh = new THREE.Mesh(this.geometry, back);
    backMesh.renderOrder = 0;
    const frontMesh = new THREE.Mesh(this.geometry, front);
    frontMesh.renderOrder = 1;
    this.group.add(backMesh, frontMesh);

    this.current.set(0, 0);
    this.autoPhase = 0;
    this.resize();
  }

  /** iOS はユーザー操作の中で許可を求める必要がある */
  async enableGyro(): Promise<boolean> {
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    try {
      if (typeof DOE.requestPermission === 'function' && (await DOE.requestPermission()) !== 'granted') {
        return false;
      }
    } catch {
      return false;
    }
    this.gyroBase = null;
    this.gyroActive = true;
    window.addEventListener('deviceorientation', this.onOrientation);
    return true;
  }

  recenter() {
    this.gyroBase = null;
    this.target.set(0, 0);
  }

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (!this.gyroActive || e.beta === null || e.gamma === null) return;
    if (!this.gyroBase) this.gyroBase = { beta: e.beta, gamma: e.gamma };
    const range = 15; // ±15° で移動範囲の端に届く
    this.lastInput = performance.now();
    this.target.set(
      THREE.MathUtils.clamp((e.gamma - this.gyroBase.gamma) / range, -1, 1),
      THREE.MathUtils.clamp(-(e.beta - this.gyroBase.beta) / range, -1, 1),
    );
  };

  private bindInput() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.dragStart.set(e.clientX, e.clientY);
      this.lastInput = performance.now();
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.lastInput = performance.now();
      const size = Math.min(el.clientWidth, el.clientHeight) * 0.5;
      this.target.set(
        THREE.MathUtils.clamp(-(e.clientX - this.dragStart.x) / size, -1, 1),
        THREE.MathUtils.clamp((e.clientY - this.dragStart.y) / size, -1, 1),
      );
    });
    const release = () => {
      this.dragging = false;
      if (!this.gyroActive) this.target.set(0, 0); // 離したら中央に戻す（酔い対策）
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);

    // アクセシビリティ: 矢印キーでも視点を動かせる
    const keyMap: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
    };
    window.addEventListener('keydown', (e) => {
      const k = keyMap[e.key];
      if (!k || (e.target as HTMLElement).closest('input, textarea, select')) return;
      e.preventDefault();
      this.keys.set(k[0], k[1]);
    });
    window.addEventListener('keyup', (e) => {
      if (keyMap[e.key]) this.keys.set(0, 0);
    });
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // 距離 D0 の面で、写真が画面に収まる大きさにする（視点を動かしても端が見えにくいよう少し余白を取る）
    const visibleH = 2 * D0 * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const visibleW = visibleH * this.camera.aspect;
    const fill = 0.94;
    if (this.aspect > this.camera.aspect) this.size.set(visibleW * fill, (visibleW * fill) / this.aspect);
    else this.size.set(visibleH * fill * this.aspect, visibleH * fill);
  }

  private tick() {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;

    for (const m of this.materials) m.uniforms.uStrength.value = this.params.depthScale;
    if (this.materials[1]) this.materials[1].uniforms.uEdge.value = this.params.edge;

    if (this.keys.lengthSq() > 0) {
      this.lastInput = now;
      this.target.x = THREE.MathUtils.clamp(this.target.x + this.keys.x * dt * 2, -1, 1);
      this.target.y = THREE.MathUtils.clamp(this.target.y + this.keys.y * dt * 2, -1, 1);
    }
    // 2 秒操作がなければ、ゆっくり円を描くように視点を動かす
    const idle = now - this.lastInput > 2000 && !this.dragging && !this.gyroActive;
    if (this.autoMotion && idle) {
      this.autoPhase += dt * 0.6;
      this.target.set(Math.sin(this.autoPhase) * 0.8, Math.sin(this.autoPhase * 2) * 0.25);
    } else if (!this.autoMotion && idle && this.keys.lengthSq() === 0) {
      this.target.set(0, 0);
    }
    // 動きを滑らかに減衰させる
    const k = 1 - Math.exp(-dt * 6);
    this.current.lerp(this.target, k);

    // 距離 D0 の点を中心に回り込む（中間の深度は止まり、手前と奥が逆向きに動く）
    const m = this.params.maxOffset * D0;
    this.camera.position.set(this.current.x * m, this.current.y * m, 0);
    this.camera.lookAt(0, 0, -D0);
    this.renderer.render(this.scene, this.camera);

    this.frames++;
    if (now - this.fpsWindowStart >= 1000) {
      this.fps = (this.frames * 1000) / (now - this.fpsWindowStart);
      this.frames = 0;
      this.fpsWindowStart = now;
      // 30fps を下回ったら描画解像度を下げる
      if (this.fps < 30 && this.pixelRatio > 0.75) {
        this.pixelRatio = Math.max(0.75, this.pixelRatio - 0.25);
        this.renderer.setPixelRatio(this.pixelRatio);
        this.resize();
      }
    }
  }

  get currentPixelRatio() {
    return this.pixelRatio;
  }
}
