import * as THREE from 'three';
import type { DepthMap } from './depth';

const vertexShader = /* glsl */ `
  uniform sampler2D uDepth;
  uniform float uDepthScale;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // 深度マップは上の行から並んでいるので v を反転して読む
    float d = texture2D(uDepth, vec2(uv.x, 1.0 - uv.y)).r;
    vec3 p = position + vec3(0.0, 0.0, d * uDepthScale);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

// 深度の段差が大きい箇所（輪郭の引き伸ばしが出る場所）を透明にして目立たなくする
const fragmentShader = /* glsl */ `
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
    if (alpha < 0.05) discard;
    gl_FragColor = vec4(texture2D(uPhoto, vUv).rgb, alpha);
    #include <colorspace_fragment>
  }
`;

export interface ViewerParams {
  /** 押し出しの強さ（写真の幅を 1 としたときの奥行き） */
  depthScale: number;
  /** 視点の移動範囲（写真の幅を 1 としたときの最大ずれ） */
  maxOffset: number;
  /** 輪郭を透明にする閾値（1 で無効） */
  edge: number;
}

export class Viewer {
  readonly params: ViewerParams = { depthScale: 0.25, maxOffset: 0.12, edge: 0.12 };
  /** 直近 1 秒の平均 fps */
  fps = 0;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  private mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  private aspect = 1;

  private target = new THREE.Vector2();
  private current = new THREE.Vector2();
  private dragging = false;
  private dragStart = new THREE.Vector2();
  private gyroBase: { beta: number; gamma: number } | null = null;
  private gyroActive = false;
  private keys = new THREE.Vector2();

  private pixelRatio = Math.min(window.devicePixelRatio, 2);
  private frames = 0;
  private fpsWindowStart = performance.now();
  private last = performance.now();

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearColor(0x111111);
    container.appendChild(this.renderer.domElement);
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  show(photo: HTMLCanvasElement, depth: DepthMap) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      const u = this.mesh.material.uniforms;
      (u.uPhoto.value as THREE.Texture).dispose();
      (u.uDepth.value as THREE.Texture).dispose();
      this.mesh.material.dispose();
    }
    this.aspect = photo.width / photo.height;

    const photoTex = new THREE.CanvasTexture(photo);
    photoTex.colorSpace = THREE.SRGBColorSpace;
    const depthTex = new THREE.DataTexture(depth.data, depth.width, depth.height, THREE.RedFormat);
    depthTex.magFilter = THREE.LinearFilter;
    depthTex.minFilter = THREE.LinearFilter;
    depthTex.needsUpdate = true;

    const segX = 256;
    const segY = Math.max(1, Math.round(segX / this.aspect));
    const geometry = new THREE.PlaneGeometry(1, 1 / this.aspect, segX, segY);
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      uniforms: {
        uPhoto: { value: photoTex },
        uDepth: { value: depthTex },
        uDepthScale: { value: this.params.depthScale },
        uTexel: { value: new THREE.Vector2(1 / depth.width, 1 / depth.height) },
        uEdge: { value: this.params.edge },
      },
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.mesh);
    this.current.set(0, 0);
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
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
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
    // 写真全体が収まる距離にカメラを置く
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const fitH = 1 / this.aspect;
    const fitW = 1;
    const distH = fitH / 2 / Math.tan(vFov / 2);
    const distW = fitW / 2 / Math.tan(vFov / 2) / this.camera.aspect;
    this.camera.position.z = Math.max(distH, distW) * 1.08 + this.params.depthScale;
    this.camera.updateProjectionMatrix();
  }

  private tick() {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;

    if (this.mesh) {
      const u = this.mesh.material.uniforms;
      u.uDepthScale.value = this.params.depthScale;
      u.uEdge.value = this.params.edge;
    }

    if (this.keys.lengthSq() > 0) {
      this.target.x = THREE.MathUtils.clamp(this.target.x + this.keys.x * dt * 2, -1, 1);
      this.target.y = THREE.MathUtils.clamp(this.target.y + this.keys.y * dt * 2, -1, 1);
    }
    // 動きを滑らかに減衰させる
    const k = 1 - Math.exp(-dt * 6);
    this.current.lerp(this.target, k);

    const m = this.params.maxOffset;
    this.camera.position.x = this.current.x * m;
    this.camera.position.y = this.current.y * m;
    this.camera.lookAt(0, 0, 0);
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
