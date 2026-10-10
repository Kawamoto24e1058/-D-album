import * as THREE from 'three';

export type EffectKind = 'none' | 'snow' | 'sakura' | 'light';

const COUNT = 1400;

function spriteTexture(kind: Exclude<EffectKind, 'none'>): THREE.Texture {
  const s = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const c = canvas.getContext('2d')!;
  if (kind === 'sakura') {
    // 花びら: 先端が少しへこんだ楕円
    c.translate(s / 2, s / 2);
    c.rotate(0.6);
    const g = c.createRadialGradient(0, 0, 2, 0, 0, s * 0.4);
    g.addColorStop(0, '#fff3f6');
    g.addColorStop(1, '#f6a9bf');
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(0, 0, s * 0.22, s * 0.36, 0, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = 'destination-out';
    c.beginPath();
    c.arc(0, -s * 0.38, s * 0.08, 0, Math.PI * 2);
    c.fill();
  } else {
    const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    if (kind === 'light') {
      g.addColorStop(0, 'rgba(255,240,190,1)');
      g.addColorStop(0.25, 'rgba(255,210,120,0.7)');
      g.addColorStop(1, 'rgba(255,180,80,0)');
    } else {
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.8)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
    }
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 写真の 3D 空間の中を舞う粒子。
 * 写真のメッシュが深度を書き込むので、粒子は被写体の前後で自然に隠れる。
 */
export class Particles {
  readonly object: THREE.Points;
  private positions: Float32Array;
  private velocities: Float32Array;
  private phases: Float32Array;
  private material: THREE.PointsMaterial;
  private kind: EffectKind = 'none';
  private textures = new Map<EffectKind, THREE.Texture>();

  /** 写真が占める空間の範囲（カメラから見た視錐台） */
  constructor(private bounds: { tanX: () => number; tanY: () => number; near: number; far: number }) {
    this.positions = new Float32Array(COUNT * 3);
    this.velocities = new Float32Array(COUNT * 3);
    this.phases = new Float32Array(COUNT);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.material = new THREE.PointsMaterial({
      size: 0.02,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
    });
    this.object = new THREE.Points(geometry, this.material);
    this.object.renderOrder = 2;
    this.object.visible = false;
    this.object.frustumCulled = false;
  }

  setKind(kind: EffectKind) {
    this.kind = kind;
    this.object.visible = kind !== 'none';
    if (kind === 'none') return;
    let tex = this.textures.get(kind);
    if (!tex) {
      tex = spriteTexture(kind);
      this.textures.set(kind, tex);
    }
    this.material.map = tex;
    this.material.blending = kind === 'light' ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.material.size = kind === 'sakura' ? 0.035 : kind === 'light' ? 0.03 : 0.018;
    this.material.needsUpdate = true;
    for (let i = 0; i < COUNT; i++) this.respawn(i, true);
  }

  private respawn(i: number, anywhere: boolean) {
    const { near, far } = this.bounds;
    // 奥ほど広がるので、z は逆数で一様にして手前にも十分な数を置く
    const z = 1 / THREE.MathUtils.lerp(1 / near, 1 / far, Math.random());
    const hx = this.bounds.tanX() * z;
    const hy = this.bounds.tanY() * z;
    const p = this.positions;
    p[i * 3] = (Math.random() * 2 - 1) * hx;
    p[i * 3 + 1] = anywhere || this.kind === 'light' ? (Math.random() * 2 - 1) * hy : hy * 1.05;
    p[i * 3 + 2] = -z;
    const v = this.velocities;
    if (this.kind === 'light') {
      v[i * 3] = (Math.random() - 0.5) * 0.02;
      v[i * 3 + 1] = Math.random() * 0.03 + 0.005;
    } else {
      const speed = this.kind === 'sakura' ? 0.05 : 0.08;
      v[i * 3] = (Math.random() - 0.3) * 0.03;
      v[i * 3 + 1] = -(Math.random() * 0.5 + 0.75) * speed * z;
    }
    v[i * 3 + 2] = 0;
    this.phases[i] = Math.random() * Math.PI * 2;
  }

  update(dt: number, time: number) {
    if (this.kind === 'none') return;
    const p = this.positions;
    const v = this.velocities;
    const sway = this.kind === 'sakura' ? 0.06 : this.kind === 'snow' ? 0.02 : 0.015;
    for (let i = 0; i < COUNT; i++) {
      const z = -p[i * 3 + 2];
      const ph = this.phases[i];
      p[i * 3] += (v[i * 3] + Math.sin(time * 1.3 + ph) * sway * z) * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      const hy = this.bounds.tanY() * z;
      const hx = this.bounds.tanX() * z;
      if (p[i * 3 + 1] < -hy * 1.05 || p[i * 3 + 1] > hy * 1.05 || Math.abs(p[i * 3]) > hx * 1.2) {
        this.respawn(i, this.kind === 'light');
      }
    }
    if (this.kind === 'light') {
      // ホタルのように明滅させる
      this.material.opacity = 0.75 + Math.sin(time * 2) * 0.15;
    } else {
      this.material.opacity = 0.95;
    }
    (this.object.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
