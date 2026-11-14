/**
 * 丝带星核 —— 移植自参考项目「星核蜘蛛」（openclaw-plugin-agent-display · 主题 05 NEBULA）。
 *
 * 原作的做法：每条丝带是一条绕球的闭合曲线，沿 T/N/B 标架展开成有宽度的面；
 * 宽度沿长度起伏、两端收窄；片元里做边缘衰减（pow(e,5)）+ 细条纹 + 沿长亮度波，
 * 顶点沿法线做 sin 漂动，每条丝带再绕自己的随机轴翻滚。
 *
 * 与原作的三处刻意差别：
 *   1. 不用 UnrealBloomPass（视觉基因禁 Bloom）——发光感全部来自加色混合 + 边缘衰减，
 *      这也是原作质感的主要来源，Bloom 只是再糊一层；
 *   2. 配色换成我们的基因：钢蓝为主，约 1/4 丝带带暖金（对应环上的金弧）；
 *   3. 随机数由外部传入（core3d 的 LCG），保证每次构建同一副面孔 —— 基线截图可复现。
 */
import {
  BufferGeometry, BufferAttribute, ShaderMaterial,
  AdditiveBlending, DoubleSide, Group, Mesh, Vector3, Quaternion, Euler, Color
} from 'three';

const TAU = Math.PI * 2;

const RB_VS = `
attribute vec2 aUV; attribute vec3 aNrm;
uniform float uTime; uniform float uPh; uniform float uAmp;
varying vec2 vUV;
void main(){
  vec3 p = position + aNrm * sin(aUV.x * 18.85 + uTime * 1.5 + uPh) * uAmp;
  vUV = aUV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const RB_FS = `
uniform vec3 uC1; uniform vec3 uC2;
uniform float uTime; uniform float uPh; uniform float uA;
varying vec2 vUV;
void main(){
  // 边缘衰减：面片中心几乎透明，靠两条边发光 —— 丝带的「细」是画出来的
  float e = abs(vUV.y * 2.0 - 1.0);
  float edge = pow(e, 5.0) * 1.1 + 0.14;
  // 细条纹：给带面一点织物感
  float str = 0.5 + 0.5 * sin(vUV.y * 70.0 + vUV.x * 30.0);
  // 沿长亮度波：光在丝带上流动
  float along = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(vUV.x * 12.566 + uTime * 0.6 + uPh), 2.0);
  vec3 col = mix(uC1, uC2, 0.5 + 0.5 * sin(vUV.x * 6.2832 * 2.0 + uPh));
  gl_FragColor = vec4(col, edge * (0.55 + 0.45 * str) * along * uA);
}`;

/** 钢蓝为主、1/4 暖金 —— 顺序就是取模顺序，暖金只占一组 */
const PALETTE: readonly (readonly [string, string])[] = [
  ['#7FA8D4', '#E8F1FB'],
  ['#D2AA70', '#F3EFE6'],
  ['#A9BCDD', '#F3EFE6'],
  ['#6F82A4', '#DCE8F8']
];

export interface RibbonBall {
  group: Group;
  mats: ShaderMaterial[];
  entries: { mesh: Mesh; ax: Vector3; sp: number }[];
}

export interface RibbonOptions {
  R: number;
  n: number;
  w0: number;
  seg: number;
  amp: number;
  alpha: number;
  rnd(): number;
}

function ribbonGeo(R: number, w0: number, seg: number, rnd: () => number): BufferGeometry {
  const q = new Quaternion().setFromEuler(new Euler(rnd() * TAU, rnd() * TAU, rnd() * TAU));
  const p1 = rnd() * TAU;
  const p2 = rnd() * TAU;
  const k1 = 2 + Math.floor(rnd() * 2);
  const P: Vector3[] = [];
  for (let i = 0; i <= seg; i++) {
    const u = (i / seg) * TAU;
    const rr = R * (1 + 0.14 * Math.sin(3 * u + p1));
    P.push(new Vector3(
      Math.cos(u) * rr,
      R * 0.22 * Math.sin(k1 * u + p2),
      Math.sin(u) * rr
    ).applyQuaternion(q));
  }
  const pos = new Float32Array((seg + 1) * 6);
  const uv = new Float32Array((seg + 1) * 4);
  const nrm = new Float32Array((seg + 1) * 6);
  const idx: number[] = [];
  const T = new Vector3();
  const N = new Vector3();
  const B = new Vector3();
  for (let i = 0; i <= seg; i++) {
    const a = P[(i + seg - 1) % seg]!;
    const b = P[(i + 1) % seg]!;
    const p = P[i]!;
    T.subVectors(b, a).normalize();
    N.copy(p).normalize();
    B.crossVectors(T, N).normalize();
    const u = i / seg;
    const w = w0 * (0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(u * TAU * 2 + p1), 1.5));
    for (let s = 0; s < 2; s++) {
      const sg = s ? 0.5 : -0.5;
      const o2 = i * 2 + s;
      pos[o2 * 3] = p.x + B.x * w * sg;
      pos[o2 * 3 + 1] = p.y + B.y * w * sg;
      pos[o2 * 3 + 2] = p.z + B.z * w * sg;
      uv[o2 * 2] = u;
      uv[o2 * 2 + 1] = s;
      nrm[o2 * 3] = N.x;
      nrm[o2 * 3 + 1] = N.y;
      nrm[o2 * 3 + 2] = N.z;
    }
    if (i < seg) {
      const o = i * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aUV', new BufferAttribute(uv, 2));
  g.setAttribute('aNrm', new BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

export function makeRibbonBall(o: RibbonOptions): RibbonBall {
  const group = new Group();
  const mats: ShaderMaterial[] = [];
  const entries: RibbonBall['entries'] = [];
  for (let i = 0; i < o.n; i++) {
    const [c1, c2] = PALETTE[i % PALETTE.length]!;
    const R = o.R * (0.82 + o.rnd() * 0.30);
    const w0 = o.w0 * (0.6 + o.rnd() * 0.8);
    const mat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPh: { value: o.rnd() * TAU },
        uAmp: { value: o.amp },
        uC1: { value: new Color(c1) },
        uC2: { value: new Color(c2) },
        uA: { value: o.alpha * (0.6 + o.rnd() * 0.5) }
      },
      vertexShader: RB_VS,
      fragmentShader: RB_FS,
      transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide
    });
    const mesh = new Mesh(ribbonGeo(R, w0, o.seg, o.rnd), mat);
    mesh.frustumCulled = false;
    entries.push({
      mesh,
      ax: new Vector3(o.rnd() - 0.5, o.rnd() - 0.5, o.rnd() - 0.5).normalize(),
      sp: (o.rnd() - 0.5) * 0.5
    });
    mats.push(mat);
    group.add(mesh);
  }
  return { group, mats, entries };
}
