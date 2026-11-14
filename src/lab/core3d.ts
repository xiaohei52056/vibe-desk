/**
 * 3D 星核与星环 · 实验台
 *
 * 目的只有一个：在花一周时间把它搬进生产工程之前，先确认「抄几何」和
 * 「抄发光」是两件独立的事。
 *
 * 参考项目的星核/星环之所以看起来像 3D，其实只靠四件事：
 *   1. PerspectiveCamera + 略微俯视（不是正视）
 *   2. 环有 z 偏移，且用「上下双圆 + 母线」给出厚度
 *   3. 点的大小按 -mv.z 衰减（近大远小）
 *   4. 整组缓慢自转
 * 而「发光感」100% 来自 AdditiveBlending。
 *
 * 所以本实验做成同一套几何 + 三种混合模式：
 *   1 暖墨   常规混合 + 雾气景深   → 与 VIBE DESK 现有视觉同源
 *   2 折中   环常规、核叠加       → 只在星核上借一点光
 *   3 叠加   全面 Additive        → 参考项目做法
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Vector3, Color,
  BufferGeometry, BufferAttribute, Float32BufferAttribute, CanvasTexture,
  LineSegments, LineLoop, LineBasicMaterial, Points, Mesh, MeshBasicMaterial,
  ShaderMaterial, NormalBlending, AdditiveBlending, Fog, DoubleSide, SRGBColorSpace,
  Sprite, SpriteMaterial
} from 'three';

type Mode = 'ink' | 'hybrid' | 'glow';

const TAU = Math.PI * 2;

/* ---------- 确定性随机：截图之间可比 ---------- */
let seed = 20261111;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

/* ---------- 渲染器 / 场景 / 相机 ---------- */
const renderer = new WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x101720, 1);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.fog = new Fog(0x101720, 6.4, 13.5);

const camera = new PerspectiveCamera(36, innerWidth / innerHeight, 0.1, 80);
const CAM_DIST = 7.6;
camera.position.set(0, 2.72, CAM_DIST * 0.94);
camera.lookAt(0, 0, 0);

const world = new Group();
scene.add(world);

/* 星环整体绕轴自转；星核自转稍快，方向相反 —— 层次就是这么出来的 */
const spin = new Group();
const core = new Group();
world.add(spin, core);

/* ---------- 材质登记表：切模式时只改这些 ---------- */
interface RingReg { mat: LineBasicMaterial; base: number; kind: 'ice' | 'gold' | 'dim'; }
const rings: RingReg[] = [];
interface MeshReg { mat: MeshBasicMaterial; base: number; kind: 'tape' | 'sector'; }
const meshes: MeshReg[] = [];
interface CoreReg { mat: ShaderMaterial; gain: number; }
const coreMats: CoreReg[] = [];

const ICE = new Color('#8496B4');
const GOLD = new Color('#C9A063');
const DIM = new Color('#5E6E8A');

function ringMat(op: number, kind: RingReg['kind']): LineBasicMaterial {
  const base = kind === 'gold' ? GOLD : kind === 'dim' ? DIM : ICE;
  const m = new LineBasicMaterial({
    color: base.clone(), transparent: true, opacity: op,
    blending: NormalBlending, depthWrite: false
  });
  rings.push({ mat: m, base: op, kind });
  return m;
}

/* ---------- 几何小工具 ---------- */
function circleGeo(r: number, z: number, seg = 256): BufferGeometry {
  const a = new Float32Array(seg * 3);
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * TAU;
    a[i * 3] = Math.cos(t) * r;
    a[i * 3 + 1] = Math.sin(t) * r;
    a[i * 3 + 2] = z;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(a, 3));
  return g;
}

function ticksGeo(r: number, n: number, len: number, every: number, long: number, z: number): BufferGeometry {
  const a: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    const l = i % every === 0 ? long : len;
    a.push(Math.cos(t) * r, Math.sin(t) * r, z, Math.cos(t) * (r + l), Math.sin(t) * (r + l), z);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(a, 3));
  return g;
}

function arcsGeo(r: number, list: readonly (readonly [number, number])[], z: number): BufferGeometry {
  const a: number[] = [];
  for (const [t0, t1] of list) {
    const n = Math.max(4, Math.round((t1 - t0) / 0.02));
    for (let i = 0; i < n; i++) {
      const u0 = t0 + ((t1 - t0) * i) / n;
      const u1 = t0 + ((t1 - t0) * (i + 1)) / n;
      a.push(Math.cos(u0) * r, Math.sin(u0) * r, z, Math.cos(u1) * r, Math.sin(u1) * r, z);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(a, 3));
  return g;
}

/** 极坐标环带：把一条长条纹理贴到环形 mesh 上（文字带 / 扇区带都靠它） */
function polarRing(r0: number, r1: number, seg: number, tex: CanvasTexture, op: number): Mesh {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * TAU;
    const u = 1 - i / seg;
    pos.push(Math.cos(t) * r0, Math.sin(t) * r0, 0, Math.cos(t) * r1, Math.sin(t) * r1, 0);
    uv.push(u, 0, u, 1);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const m = new MeshBasicMaterial({
    map: tex, transparent: true, opacity: op, depthWrite: false,
    blending: NormalBlending, side: DoubleSide
  });
  meshes.push({ mat: m, base: op, kind: 'tape' });
  return new Mesh(g, m);
}

/* ============================================================
   星核：球状神经网（线）+ 节点（点）
   ============================================================ */
const NODE_N = 300;

interface Node { p: Vector3; }
const nodes: Node[] = [];

for (let i = 0; i < NODE_N; i++) {
  // Fibonacci 球：均匀分布，不会在两极堆积
  const y = 1 - (i / (NODE_N - 1)) * 2;
  const rad = Math.sqrt(Math.max(0, 1 - y * y));
  const th = i * 2.399963229728653;
  const r = 1.12 + (rnd() - 0.5) * 0.10;
  nodes.push({ p: new Vector3(Math.cos(th) * rad * r, y * r, Math.sin(th) * rad * r) });
}

// 每个节点连最近的两个邻居 —— 形成网状而不是混乱的线球
const edgeSet = new Set<string>();
const ePos: number[] = [];
const ePh: number[] = [];
for (let i = 0; i < NODE_N; i++) {
  const a = nodes[i]!;
  const dist = nodes
    .map((b, j) => ({ j, d: a.p.distanceToSquared(b.p) }))
    .filter(o => o.j !== i)
    .sort((x, y) => x.d - y.d)
    .slice(0, 3);
  for (const { j } of dist) {
    const key = i < j ? `${i}-${j}` : `${j}-${i}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    const b = nodes[j]!;
    ePos.push(a.p.x, a.p.y, a.p.z, b.p.x, b.p.y, b.p.z);
    const ph = (a.p.length() + b.p.length()) % 1;
    ePh.push(ph, ph);
  }
}

// 内核辐条：从 0.3 半径向外发散，给「核」一点 estrutura
for (let i = 0; i < 34; i++) {
  const n = nodes[(i * 7) % NODE_N]!;
  const s = n.p.clone().multiplyScalar(0.34);
  ePos.push(s.x, s.y, s.z, n.p.x, n.p.y, n.p.z);
  ePh.push(i / 34, i / 34);
}

const coreEdgeGeo = new BufferGeometry();
coreEdgeGeo.setAttribute('position', new Float32BufferAttribute(ePos, 3));
coreEdgeGeo.setAttribute('ph', new Float32BufferAttribute(ePh, 1));

const CORE_VS = `
attribute float ph;
uniform float uTime; uniform float uGain; uniform vec3 uA; uniform vec3 uB;
varying float vA; varying vec3 vC;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float w  = 0.5 + 0.5 * sin(uTime * 0.85 - ph * 9.4);
  float w2 = 0.5 + 0.5 * sin(uTime * 0.31 + ph * 3.1);
  // 球背面的线不该出现在正面：用视线与法线夹角把它压到近乎看不见。
  // 少了这一步，整颗核会像一团乱麻——这是「线球」和「球壳」的分界。
  vec3 nrm = normalize(normalMatrix * normalize(position));
  float facing = clamp(dot(nrm, normalize(-mv.xyz)), 0.0, 1.0);
  float depth = clamp((-mv.z - 6.2) / 6.5, 0.0, 1.0);
  vA = (0.20 + 0.70 * w * w) * (0.55 + 0.45 * w2) * uGain
     * (1.0 - depth * 0.5) * (0.30 + 0.70 * facing);
  vC = mix(uA, uB, w * 0.8 + facing * 0.2);
  gl_Position = projectionMatrix * mv;
}`;
const CORE_FS = `
varying float vA; varying vec3 vC;
void main(){ gl_FragColor = vec4(vC, vA); }`;

const coreEdgeMat = new ShaderMaterial({
  uniforms: {
    uTime: { value: 0 }, uGain: { value: 1 },
    uA: { value: new Color('#6F82A4') }, uB: { value: new Color('#EDE7DA') }
  },
  vertexShader: CORE_VS, fragmentShader: CORE_FS,
  transparent: true, depthWrite: false, blending: NormalBlending
});
coreMats.push({ mat: coreEdgeMat, gain: 1 });
core.add(new LineSegments(coreEdgeGeo, coreEdgeMat));

/* 节点：带透视衰减与呼吸 */
const pPos: number[] = [];
const pPh: number[] = [];
const pSz: number[] = [];
const pInner: number[] = [];
for (const n of nodes) {
  pPos.push(n.p.x, n.p.y, n.p.z);
  pPh.push(rnd());
  pSz.push(1.4 + rnd() * 1.8);
  pInner.push(0);
}
// 核内密点：视觉重量集中在中心
for (let i = 0; i < 96; i++) {
  const v = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
  if (v.length() > 1) { i--; continue; }
  v.multiplyScalar(0.40);
  pPos.push(v.x, v.y, v.z);
  pPh.push(rnd());
  pSz.push(2.2 + rnd() * 2.0);
  pInner.push(1);
}

const corePtGeo = new BufferGeometry();
corePtGeo.setAttribute('position', new Float32BufferAttribute(pPos, 3));
corePtGeo.setAttribute('ph', new Float32BufferAttribute(pPh, 1));
corePtGeo.setAttribute('sz', new Float32BufferAttribute(pSz, 1));
corePtGeo.setAttribute('inner', new Float32BufferAttribute(pInner, 1));

const PT_VS = `
attribute float ph; attribute float sz; attribute float inner;
uniform float uTime; uniform float uPx; uniform float uGain;
uniform vec3 uA; uniform vec3 uB;
varying float vA; varying vec3 vC;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float tw = 0.62 + 0.38 * sin(uTime * (0.8 + ph * 2.1) + ph * 40.0);
  float depth = clamp((-mv.z - 6.2) / 6.5, 0.0, 1.0);
  vec3 nrm = normalize(normalMatrix * normalize(position));
  float facing = clamp(dot(nrm, normalize(-mv.xyz)), 0.0, 1.0);
  float shell = 0.14 + 0.86 * facing;
  vA = (0.46 + inner * 0.30) * tw * uGain * (1.0 - depth * 0.5)
     * mix(shell, 1.0, inner);
  vC = mix(uA, uB, inner * 0.75 + tw * 0.25);
  gl_PointSize = max(1.0, sz * 0.0055 * uPx / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const PT_FS = `
varying float vA; varying vec3 vC;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.12, r) * vA;
  gl_FragColor = vec4(vC, a);
}`;

const corePtMat = new ShaderMaterial({
  uniforms: {
    uTime: { value: 0 }, uPx: { value: 1 }, uGain: { value: 1 },
    uA: { value: new Color('#A9BCDD') }, uB: { value: new Color('#F3EFE6') }
  },
  vertexShader: PT_VS, fragmentShader: PT_FS,
  transparent: true, depthWrite: false, blending: NormalBlending
});
coreMats.push({ mat: corePtMat, gain: 1 });
core.add(new Points(corePtGeo, corePtMat));

/* 核心柔光：径向渐变画在 canvas 上，不靠叠加也有一团「重量」。
   参考项目这里是 Sprite + Additive，我们改用常规混合 —— 差别就是
   「雾团」和「灯」的差别。 */
const glowSprite = (() => {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const c = cv.getContext('2d')!;
  const gd = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gd.addColorStop(0.00, 'rgba(243,239,230,0.85)');
  gd.addColorStop(0.22, 'rgba(214,208,196,0.42)');
  gd.addColorStop(0.52, 'rgba(150,162,190,0.16)');
  gd.addColorStop(1.00, 'rgba(16,23,32,0)');
  c.fillStyle = gd;
  c.fillRect(0, 0, S, S);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  const m = new SpriteMaterial({
    map: tex, transparent: true, opacity: 0.6,
    depthWrite: false, blending: NormalBlending
  });
  const sp = new Sprite(m);
  sp.scale.setScalar(3.1);
  core.add(sp);
  return m;
})();

/* ============================================================
   星环：9 层，z 逐层后退
   ============================================================ */
const addLine = (geo: BufferGeometry, mat: LineBasicMaterial): void => {
  spin.add(new LineSegments(geo, mat));
};

// 1 · 内晕
spin.add(new LineLoop(circleGeo(1.66, 0, 240), ringMat(0.34, 'gold')));
// 2 · 内刻度
addLine(ticksGeo(1.80, 180, 0.012, 12, 0.03, 0.02), ringMat(0.30, 'ice'));
// 3 · 圆柱框：上下双圆 + 72 条母线。这一条是「环有厚度」的全部来源
const R_CYL = 2.02;
spin.add(new LineLoop(circleGeo(R_CYL, 0.085, 256), ringMat(0.46, 'ice')));
spin.add(new LineLoop(circleGeo(R_CYL, -0.085, 256), ringMat(0.34, 'ice')));
{
  const a: number[] = [];
  for (let i = 0; i < 72; i++) {
    const t = (i / 72) * TAU;
    a.push(Math.cos(t) * R_CYL, Math.sin(t) * R_CYL, 0.085,
           Math.cos(t) * R_CYL, Math.sin(t) * R_CYL, -0.085);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(a, 3));
  addLine(g, ringMat(0.13, 'dim'));
}
// 4 · 文字带（canvas 纹理贴环）
{
  const W = 4096;
  const H = 64;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d')!;
  c.clearRect(0, 0, W, H);
  c.font = '500 26px "PingFang SC","Microsoft YaHei",sans-serif';
  c.fillStyle = 'rgba(201,160,99,.85)';
  c.textBaseline = 'middle';
  const words = ['学习星系', '代码星系', '坐标冻结', '光学景深', '光丝权重', '该回看', '决策日志'];
  let x = 40;
  let k = 0;
  while (x < W - 120) {
    const w = words[k++ % words.length]!;
    c.fillText(w, x, H / 2);
    x += c.measureText(w).width + 46;
    c.fillRect(x - 26, H / 2 - 1, 10, 2);
    x += 12;
  }
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  const tape = polarRing(2.06, 2.16, 384, tex, 0.72);
  tape.position.z = 0.03;
  spin.add(tape);
}
// 5 · 扇区弧（不规则长短，像刻度盘上的分区）
addLine(arcsGeo(2.34, [[0.10, 0.86], [1.26, 1.52], [2.18, 3.36], [3.86, 4.18], [4.62, 5.78]], -0.05),
  ringMat(0.40, 'gold'));
addLine(arcsGeo(2.44, [[0.52, 0.64], [1.02, 2.06], [2.72, 2.84], [3.24, 4.42], [5.12, 5.34]], -0.07),
  ringMat(0.24, 'ice'));
// 6 · 外刻度：长短交替，密度感来源
addLine(ticksGeo(2.62, 260, 0.014, 10, 0.034, -0.10), ringMat(0.36, 'ice'));
// 7 · 虚线轨
{
  const a: number[] = [];
  for (let px = 0; px < 900;) {
    const w = 0.004 + rnd() * 0.016;
    const gap = 0.004 + rnd() * 0.012;
    if (rnd() < 0.8) {
      const t0 = ((px / 900) * TAU) % TAU;
      const t1 = t0 + w;
      a.push(Math.cos(t0) * 2.80, Math.sin(t0) * 2.80, -0.13, Math.cos(t1) * 2.80, Math.sin(t1) * 2.80, -0.13);
    }
    px += Math.round((w + gap) * 900 / TAU * 60);
    if (px <= 0) break;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(a, 3));
  addLine(g, ringMat(0.22, 'dim'));
}
// 8 · 最外两道断续弧
addLine(arcsGeo(2.92, [[0.2, 1.1], [1.6, 1.8], [2.6, 3.9], [4.4, 4.7], [5.2, 6.1]], -0.17),
  ringMat(0.20, 'dim'));

/* ---------- 尘埃：远景点，给空间纵深 ---------- */
{
  const n = 620;
  const pos = new Float32Array(n * 3);
  const sz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    const r = 5 + rnd() * 13;
    pos.set([u.x * r, u.y * r * 0.55, u.z * r], i * 3);
    sz[i] = 0.6 + rnd() * 1.6;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('sz', new BufferAttribute(sz, 1));
  const m = new ShaderMaterial({
    uniforms: { uPx: { value: 1 }, uGain: { value: 1 } },
    vertexShader: `
      attribute float sz; uniform float uPx; uniform float uGain; varying float vA;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vA = 0.16 * uGain;
        gl_PointSize = max(0.8, sz * 0.0045 * uPx / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA;
      void main(){ float r = length(gl_PointCoord - vec2(0.5));
        if (r > 0.5) discard; gl_FragColor = vec4(0.78, 0.82, 0.92, smoothstep(0.5,0.1,r) * vA); }`,
    transparent: true, depthWrite: false, blending: NormalBlending
  });
  scene.add(new Points(g, m));
  coreMats.push({ mat: m, gain: 1 });
}

/* ============================================================
   混合模式
   ============================================================ */
const MODE_NAME: Record<Mode, string> = { ink: '暖墨', hybrid: '折中', glow: '叠加' };
const MODE_BTN: Record<Mode, string[]> = {
  ink: ['#8496B4', '#C9A063', '#5E6E8A'],
  hybrid: ['#8FA4C6', '#D2AA70', '#63738F'],
  glow: ['#BCD4FF', '#F2D3A0', '#7E93B8']
};

function applyMode(mode: Mode): void {
  const [ice, gold, dim] = MODE_BTN[mode].map(h => new Color(h)) as [Color, Color, Color];
  const additive = mode === 'glow';

  for (const r of rings) {
    const c = r.kind === 'gold' ? gold : r.kind === 'dim' ? dim : ice;
    r.mat.color.copy(c);
    r.mat.opacity = Math.min(1, r.base * (mode === 'ink' ? 1.5 : mode === 'hybrid' ? 1.32 : 1.0));
    r.mat.blending = additive ? AdditiveBlending : NormalBlending;
    r.mat.fog = !additive;
    r.mat.needsUpdate = true;
  }
  for (const m of meshes) {
    m.mat.blending = additive ? AdditiveBlending : NormalBlending;
    m.mat.opacity = m.base * (additive ? 0.8 : 1);
    m.mat.needsUpdate = true;
  }
  for (const c of coreMats) {
    c.mat.blending = (mode === 'ink') ? NormalBlending : AdditiveBlending;
    c.mat.needsUpdate = true;
  }
  const gain = mode === 'ink' ? 0.92 : mode === 'hybrid' ? 1.0 : 1.18;
  coreEdgeMat.uniforms['uGain']!.value = gain;
  corePtMat.uniforms['uGain']!.value = gain;
  coreEdgeMat.uniforms['uA']!.value = mode === 'glow' ? new Color('#9CC4FF') : new Color('#6F82A4');
  coreEdgeMat.uniforms['uB']!.value = mode === 'glow' ? new Color('#FFFFFF') : new Color('#EDE7DA');
  corePtMat.uniforms['uA']!.value = mode === 'glow' ? new Color('#CFE4FF') : new Color('#A9BCDD');
  corePtMat.uniforms['uB']!.value = mode === 'glow' ? new Color('#FFFFFF') : new Color('#F3EFE6');

  glowSprite.blending = additive ? AdditiveBlending : NormalBlending;
  glowSprite.opacity = mode === 'ink' ? 0.44 : mode === 'hybrid' ? 0.60 : 0.78;
  glowSprite.needsUpdate = true;

  (document.getElementById('mode-name') as HTMLElement).textContent = MODE_NAME[mode];
  document.querySelectorAll<HTMLElement>('#modes button').forEach(b => {
    b.classList.toggle('on', b.dataset['mode'] === mode);
  });
}

const urlMode = new URLSearchParams(location.search).get('mode');
let mode: Mode = urlMode === 'glow' || urlMode === 'hybrid' ? urlMode : 'ink';
document.querySelectorAll<HTMLElement>('#modes button').forEach(b => {
  b.addEventListener('click', () => {
    mode = (b.dataset['mode'] as Mode) ?? 'ink';
    applyMode(mode);
  });
});
addEventListener('keydown', (ev: KeyboardEvent) => {
  const map: Record<string, Mode> = { '1': 'ink', '2': 'hybrid', '3': 'glow' };
  const next = map[ev.key];
  if (next) { mode = next; applyMode(mode); }
});
applyMode(mode);

/* ============================================================
   交互：拖动旋转 / 滚轮推拉
   ============================================================ */
let dragX = 0;
let dragY = 0;
let velX = 0;
let velY = 0;
let down = false;
let px = 0;
let py = 0;
let camDist = CAM_DIST;

renderer.domElement.addEventListener('pointerdown', (e: PointerEvent) => {
  down = true; px = e.clientX; py = e.clientY;
  renderer.domElement.style.cursor = 'grabbing';
});
addEventListener('pointerup', () => { down = false; renderer.domElement.style.cursor = 'grab'; });
addEventListener('pointermove', (e: PointerEvent) => {
  if (!down) return;
  velY += (e.clientX - px) * 0.0022;
  velX += (e.clientY - py) * 0.0016;
  px = e.clientX; py = e.clientY;
});
addEventListener('wheel', (e: WheelEvent) => {
  camDist = Math.max(5.2, Math.min(12, camDist + e.deltaY * 0.0022));
}, { passive: true });
renderer.domElement.style.cursor = 'grab';

/* ============================================================
   循环
   ============================================================ */
const stats = document.getElementById('stats') as HTMLElement;
let t0 = performance.now();
let frames = 0;
let acc = 0;
let fps = 0;

function resize(): void {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  const pxSize = (innerHeight * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
  corePtMat.uniforms['uPx']!.value = pxSize;
}
addEventListener('resize', resize);
resize();

function loop(now: number): void {
  const dt = Math.min(0.05, (now - t0) / 1000);
  t0 = now;
  const t = now / 1000;

  velX *= 0.94;
  velY *= 0.94;
  dragX = Math.max(-0.42, Math.min(0.42, dragX + velX));
  dragY = Math.max(-0.55, Math.min(0.55, dragY + velY));
  world.rotation.x = -0.62 + dragY * 0.55;
  world.rotation.y = dragX * 0.9;

  spin.rotation.z += dt * 0.058;
  core.rotation.z -= dt * 0.085;
  core.rotation.x = Math.sin(t * 0.19) * 0.09;
  core.rotation.y = Math.cos(t * 0.14) * 0.11;

  coreEdgeMat.uniforms['uTime']!.value = t;
  corePtMat.uniforms['uTime']!.value = t;
  corePtMat.uniforms['uPx']!.value = (innerHeight * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));

  const d = camDist;
  camera.position.set(0, d * 0.356, d * 0.936);
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);

  frames++;
  acc += dt;
  if (acc >= 0.5) {
    fps = Math.round(frames / acc);
    frames = 0; acc = 0;
    const info = renderer.info.render;
    stats.textContent = `${fps} fps · ${info.calls} calls · ${(info.triangles / 1000).toFixed(1)}k tri`;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
