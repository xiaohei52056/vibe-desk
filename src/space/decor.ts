/**
 * 银河层的中景实体 —— 让「5 个球漂在黑里」变成一片有物质的空间。
 *
 * 为什么需要这一层：星核与 4 个星系是「球」，环与刻度是「线」，尘埃与恒星是「点」。
 * 点不能当景 —— 没有体积、没有受光、不产生遮挡，堆再多也只是噪点。
 *
 * 现在分工：
 *   · 碎石带 —— 物质感（行星系碎屑盘），纵深的主要来源；
 *   · 彗星   —— 每 4~5 秒有一颗带彗发与双尾划过，其余时间完全隐去；
 *   · 远景   —— 粒子螺旋星系 + 一颗会喷出波前光环的脉冲星。
 *
 * 三条约束：
 *   1. 全部程序化生成，零外部贴图（纹理也是 canvas 现画）；
 *   2. 只在银河层出现（coreGain 控制），模块层退场；
 *   3. 详情页打开时随 clock 一起定格，不产生任何运动。
 */
import {
  Group, Vector3, Color, Euler, Quaternion, Matrix4,
  BufferGeometry, BufferAttribute,
  InstancedMesh, IcosahedronGeometry, MeshLambertMaterial,
  PointLight, AmbientLight, Sprite, SpriteMaterial,
  CanvasTexture, SRGBColorSpace,
  AdditiveBlending, ShaderMaterial, Points,
  type Texture
} from 'three';

const TAU = Math.PI * 2;

/** 反向 smoothstep 也能用（b < a 时自动取反向渐变） */
const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * 默认机位反投影：给定屏幕 ndc 与相机深度，算出世界坐标。
 * 相机在 (0,2,7.6)、俯角 15°、fov 36°、宽高比 ~1.6。
 * 远景必须这么摆 —— 按「相对世界原点的球面方向」撒点，一大半会落在视锥外。
 */
const CAM = new Vector3(0, 2.0, 7.6);
const FWD = new Vector3(0, -0.259, -0.966);
const RIGHT = new Vector3(1, 0, 0);
const UP = new Vector3(0, 0.966, -0.259);
const skyPoint = (sx: number, sy: number, d: number): Vector3 =>
  CAM.clone()
    .addScaledVector(FWD, d)
    .addScaledVector(RIGHT, sx * d * 0.325 * 1.6)
    .addScaledVector(UP, sy * d * 0.325);

/* ============================================================
   纹理：两张都是 canvas 现画的小图，只用来做「发光体」，不当星系贴片。
   ============================================================ */

/** 彗发：青白核心 → 青绿 → 冰蓝外晕，絮状不规则边缘，绝不画成纯白圆球 */
function makeComaTex(rnd: () => number): CanvasTexture {
  const S = 192;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d')!;
  const cx = S * 0.53;
  const cy = S * 0.5;

  const g = c.createRadialGradient(cx, cy, 0, cx, cy, S * 0.47);
  g.addColorStop(0, 'rgba(232,255,250,0.95)');
  g.addColorStop(0.16, 'rgba(158,238,226,0.70)');
  g.addColorStop(0.42, 'rgba(92,186,214,0.32)');
  g.addColorStop(0.72, 'rgba(72,124,196,0.11)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);

  // 絮斑把完美圆形打碎：气体云被太阳风吹得不规则
  for (let i = 0; i < 38; i++) {
    const a = rnd() * TAU;
    const rr = Math.pow(rnd(), 0.62) * S * 0.33;
    const x = cx + Math.cos(a) * rr * 1.18;
    const y = cy + Math.sin(a) * rr * 0.90;
    const r = 9 + rnd() * 30;
    const g2 = c.createRadialGradient(x, y, 0, x, y, r);
    g2.addColorStop(0, rnd() < 0.55 ? 'rgba(150,232,222,0.24)' : 'rgba(108,162,234,0.20)');
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g2;
    c.fillRect(0, 0, S, S);
  }

  // 朝尾侧（-x）拖出的一小股喷流，让头不再是呆板的圆
  const jet = c.createLinearGradient(cx, cy, cx - S * 0.42, cy);
  jet.addColorStop(0, 'rgba(176,242,232,0.30)');
  jet.addColorStop(1, 'rgba(80,140,210,0)');
  c.fillStyle = jet;
  c.beginPath();
  c.moveTo(cx, cy - S * 0.055);
  c.lineTo(cx - S * 0.42, cy - S * 0.012);
  c.lineTo(cx - S * 0.42, cy + S * 0.012);
  c.lineTo(cx, cy + S * 0.055);
  c.closePath();
  c.fill();

  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** 恒星核：中心亮核 + 四道尖细衍射芒（很小，不是硬边多边形） */
function makeStarTex(): CanvasTexture {
  const S = 128;
  const mid = S / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d')!;

  const g = c.createRadialGradient(mid, mid, 0, mid, mid, S * 0.40);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.10, 'rgba(214,238,255,0.46)');
  g.addColorStop(0.38, 'rgba(132,182,255,0.11)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);

  c.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 4; k++) {
    c.save();
    c.translate(mid, mid);
    c.rotate(k * Math.PI / 4);
    const L = S * 0.45;
    const lg = c.createLinearGradient(-L, 0, L, 0);
    lg.addColorStop(0, 'rgba(168,208,255,0)');
    lg.addColorStop(0.5, 'rgba(238,248,255,0.82)');
    lg.addColorStop(1, 'rgba(168,208,255,0)');
    c.fillStyle = lg;
    c.beginPath();
    c.moveTo(-L, 0);
    c.lineTo(0, -1.5);
    c.lineTo(L, 0);
    c.lineTo(0, 1.5);
    c.closePath();
    c.fill();
    c.restore();
  }

  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/* ============================================================
   碎石带：三条不同倾角的轨道，各走各的速度与方向
   半径从 2.7 起（星环最外圈 R=2.02），不与环打架
   ============================================================ */
interface BeltSpec {
  r0: number; r1: number; thick: number;
  inc: number; node: number;
  sp: number; n: number;
}

const BELTS: readonly BeltSpec[] = [
  { r0: 2.72, r1: 3.04, thick: 0.070, inc: 0.055, node: 0.030, sp: 0.052, n: 110 },
  { r0: 3.26, r1: 3.72, thick: 0.120, inc: -0.105, node: 0.070, sp: -0.036, n: 90 },
  { r0: 4.02, r1: 4.56, thick: 0.170, inc: 0.165, node: -0.075, sp: 0.024, n: 70 }
];

/* ============================================================
   彗星：每 4~5 秒一次的掠过事件，休眠期整组 hidden。
   一颗 = 彗发（带色、不规则）+ 星芒核 + 离子尾（窄直冰蓝）+ 尘埃尾（宽弯暖金）。
   ============================================================ */
interface CometSpec {
  a: number; b: number; inc: number; node: number; ph: number;
  sweep: number;
  dur: number;
}

const COMETS: readonly CometSpec[] = [
  { a: 3.10, b: 2.05, inc: 0.62, node: 0.35, ph: 0.4, sweep: 2.15, dur: 2.7 },
  { a: 2.55, b: 1.85, inc: -0.95, node: 1.90, ph: 2.7, sweep: -1.95, dur: 2.9 },
  { a: 3.55, b: 2.35, inc: 1.28, node: -0.80, ph: 4.9, sweep: 2.35, dur: 2.6 }
];

/** 每条尾巴的点数；一条几何里放两条尾（前半离子 / 后半尘埃） */
const TAIL_N = 96;

interface Comet {
  holder: Group;
  coma: Sprite;
  comaMat: SpriteMaterial;
  nucleus: Sprite;
  nucleusMat: SpriteMaterial;
  tailPos: BufferAttribute;
  tailA: BufferAttribute;
  tailSz: BufferAttribute;
  spec: CometSpec;
  len: number;
  startAt: number;
  run: number;
}

/** 脉冲星：星芒核 + 双极粒子喷流 + 磁层环 + 三道脉冲波前，全部无实心几何面 */
interface Pulsar {
  axis: Group;
  core: Sprite;
  coreMat: SpriteMaterial;
}

export class Decor {
  /** 跟着星核走的一切（碎石 / 彗星 / 点光） */
  readonly near = new Group();
  /** 不随近景旋转的远景（星团 / 脉冲星）—— 放 scene 才有真正的远视差 */
  readonly far = new Group();

  private readonly belts: { mesh: InstancedMesh; sp: number }[] = [];
  private readonly beltsBase: Group[] = [];
  private readonly comets: Comet[] = [];
  /** 所有自定义 ShaderMaterial：uPx / uTime / uBeat 统一在这里喂 */
  private readonly shaderMats: ShaderMaterial[] = [];
  private readonly pulsar: Pulsar;

  private coreGain = 1;
  private px = 900;

  /** 彗星统一调度：间隔 4.2~4.9s 触发一颗，三颗轮流 */
  private readonly rnd: () => number;
  private nextCometAt = 2.6;
  private cometIdx = 0;
  private cometRuns = 0;

  constructor(glowTex: Texture, rnd: () => number) {
    this.rnd = rnd;
    this.near.name = 'decor-near';
    this.far.name = 'decor-far';

    const light = new PointLight(0xFFD9B0, 9, 24, 1.7);
    light.position.set(0, 0, 0);
    this.near.add(light);
    this.near.add(new AmbientLight(0x2A3A52, 0.35));

    this.buildBelts(rnd);
    this.buildComets(glowTex, rnd);
    this.buildGalaxies(rnd);
    this.pulsar = this.buildPulsar(glowTex, rnd);
  }

  /* ============================================================
     碎石带
     ============================================================ */
  private buildBelts(rnd: () => number): void {
    const m = new Matrix4();
    const q = new Quaternion();
    const e = new Euler();
    const pos = new Vector3();
    const scl = new Vector3();

    for (const spec of BELTS) {
      const holder = new Group();
      holder.rotation.x = spec.inc;
      holder.rotation.z = spec.node;

      const geo = new IcosahedronGeometry(1, 0);
      const mat = new MeshLambertMaterial({ color: 0xFFFFFF });
      const mesh = new InstancedMesh(geo, mat, spec.n);
      mesh.frustumCulled = false;

      const col = new Color();
      for (let i = 0; i < spec.n; i++) {
        const a = rnd() * TAU;
        const rr = spec.r0 + Math.pow(rnd(), 0.72) * (spec.r1 - spec.r0);
        const y = (rnd() + rnd() + rnd() - 1.5) * spec.thick;
        pos.set(Math.cos(a) * rr, y, Math.sin(a) * rr);

        const s = 0.009 + Math.pow(rnd(), 2.4) * 0.024;
        scl.set(s * (0.75 + rnd() * 0.6), s * (0.55 + rnd() * 0.6), s * (0.75 + rnd() * 0.55));

        e.set(rnd() * TAU, rnd() * TAU, rnd() * TAU);
        q.setFromEuler(e);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);

        const warm = rnd() < 0.16 ? 0.10 : 0;
        col.setHSL(0.585 + warm - rnd() * 0.03, 0.05 + rnd() * 0.09, 0.20 + rnd() * 0.24);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      holder.add(mesh);
      this.near.add(holder);
      this.belts.push({ mesh, sp: spec.sp });
      this.beltsBase.push(holder);
    }
  }

  /* ============================================================
     彗星：彗发 + 星芒核 + 双尾
     ============================================================ */
  private buildComets(glowTex: Texture, rnd: () => number): void {
    const comaTex = makeComaTex(rnd);
    const starTex = makeStarTex();
    void glowTex;   // 保留构造签名：星芒与彗发现用专用纹理，glowTex 不再适合当头

    for (const s of COMETS) {
      const holder = new Group();
      holder.rotation.set(s.inc, s.node, 0.12);
      holder.visible = false;
      this.near.add(holder);

      // 彗发：带青绿/冰蓝的弥散气体云，尺寸随掠过节奏轻微涨落
      const comaMat = new SpriteMaterial({
        map: comaTex, transparent: true, opacity: 0.7,
        depthWrite: false, blending: AdditiveBlending, fog: false
      });
      const coma = new Sprite(comaMat);
      coma.scale.setScalar(0.62);
      holder.add(coma);

      // 核：小星芒，不是白色圆球。亮度单独控制，出现/消失时略微滞后于彗发
      const nucleusMat = new SpriteMaterial({
        map: starTex, transparent: true, opacity: 0.95,
        depthWrite: false, blending: AdditiveBlending, fog: false
      });
      const nucleus = new Sprite(nucleusMat);
      nucleus.scale.setScalar(0.24);
      holder.add(nucleus);

      const n = TAIL_N * 2;
      const geo = new BufferGeometry();
      const tp = new Float32Array(n * 3);
      const ta = new Float32Array(n);
      const ts = new Float32Array(n);
      const tc = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const ion = i < TAIL_N;
        // 离子尾冷蓝、尘埃尾暖金：颜色恒定，构造时写一次
        tc[i * 3] = ion ? 0.44 : 1.0;
        tc[i * 3 + 1] = ion ? 0.74 : 0.68;
        tc[i * 3 + 2] = ion ? 1.0 : 0.38;
      }
      geo.setAttribute('position', new BufferAttribute(tp, 3));
      geo.setAttribute('aA', new BufferAttribute(ta, 1));
      geo.setAttribute('aS', new BufferAttribute(ts, 1));
      geo.setAttribute('color', new BufferAttribute(tc, 3));
      const mat = new ShaderMaterial({
        uniforms: { uPx: { value: this.px } },
        vertexShader: `
          attribute float aA; attribute float aS; attribute vec3 color;
          uniform float uPx;
          varying float vA; varying vec3 vC;
          void main(){
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vA = aA; vC = color;
            gl_PointSize = max(1.0, aS * uPx / max(0.001, -mv.z));
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          varying float vA; varying vec3 vC;
          void main(){
            float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
            if (d > 1.0) discard;
            gl_FragColor = vec4(vC, pow(1.0 - d, 1.35) * vA);
          }`,
        transparent: true, depthWrite: false, blending: AdditiveBlending
      });
      const tail = new Points(geo, mat);
      tail.frustumCulled = false;
      holder.add(tail);
      this.shaderMats.push(mat);

      this.comets.push({
        holder, coma, comaMat, nucleus, nucleusMat,
        tailPos: geo.getAttribute('position') as BufferAttribute,
        tailA: geo.getAttribute('aA') as BufferAttribute,
        tailSz: geo.getAttribute('aS') as BufferAttribute,
        spec: s,
        len: 2.3 + rnd() * 0.9,
        startAt: -1e9, run: 0
      });
    }
  }

  /* ============================================================
     远景星系：真 3D 粒子盘（不是椭圆贴图）。
     关键修正：以前按「相对世界原点的球面方向」撒点，而相机在 +z 高处俯视，
     大半星系其实落在视锥外 —— 这才是「没有存在感」的主因。
     现在一半用默认机位反投影，明确落在画面里；另一半球面分布供拖拽后发现。
   ============================================================ */
  private buildGalaxies(rnd: () => number): void {
    const N = 700;
    const pals: readonly (readonly [string, string])[] = [
      ['#FFF0D8', '#9B7BE8'],
      ['#FFF6E4', '#6FA8E8'],
      ['#FFF2DC', '#D9A96E']
    ];

    // 四处避开中央星核的屏幕位置，首屏一定能看见；右侧中部留给脉冲星
    const VISIBLE: readonly (readonly [number, number])[] = [
      [-0.84, 0.52], [0.82, 0.50], [-0.84, -0.34], [0.26, -0.78]
    ];

    for (let i = 0; i < 10; i++) {
      const tone = pals[i % 3]!;
      const coreCol = new Color(tone[0]);
      const armCol = new Color(tone[1]);
      const inView = i < VISIBLE.length;
      // 远景感三件套：距离拉远 + 盘径收小 + 亮度压暗（另见下方向背景色褪色）
      const R = inView ? 1.25 + rnd() * 0.65 : 1.05 + rnd() * 0.70;
      const pos = new Float32Array(N * 3);
      const col = new Float32Array(N * 3);
      const sz = new Float32Array(N);
      const ph = new Float32Array(N);
      const g3 = (): number => (rnd() + rnd() + rnd() - 1.5) / 1.5;
      const blue = new Color('#CFE4FF');
      const hii = new Color('#FF9EC4');
      const haze = new Color('#8FA8C6');

      for (let k = 0; k < N; k++) {
        const bulge = rnd() < 0.28;
        let x: number, y: number, z: number, rr: number;
        if (bulge) {
          const a = rnd() * TAU;
          const b = Math.acos(2 * rnd() - 1);
          const r = Math.pow(rnd(), 1.8) * R * 0.27;
          x = Math.sin(b) * Math.cos(a) * r;
          y = Math.sin(b) * Math.sin(a) * r;
          z = Math.cos(b) * r * 0.6;
          rr = 0;
        } else {
          const t = Math.pow(rnd(), 0.62);
          const a = (k % 2) * Math.PI + t * 3.6 + g3() * 0.34;
          const r = t * R;
          x = Math.cos(a) * r;
          y = Math.sin(a) * r;
          z = g3() * R * 0.075;
          rr = t;
        }
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;

        let c = coreCol.clone().lerp(armCol, Math.min(1, rr * 1.15 + rnd() * 0.15));
        // 旋臂上的 OB 亮星与粉红 HII 区：盘面才有结构，不是均匀点云
        const roll = rnd();
        if (roll < 0.05) c.lerp(blue, 0.75);
        else if (roll < 0.08) c.lerp(hii, 0.65);
        // 大气透视：远景整体向深空灰蓝褪色，隔着一层介质的感觉
        c.lerp(haze, 0.30);
        const b = 0.42 + rnd() * 0.30;
        col[k * 3] = c.r * b; col[k * 3 + 1] = c.g * b; col[k * 3 + 2] = c.b * b;

        let s = 0.022 + Math.pow(rnd(), 3) * 0.070;
        if (roll < 0.05) s *= 1.6;      // 少数亮星稍大，盘才有「星」的颗粒
        sz[k] = s;
        ph[k] = rnd();
      }
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(pos, 3));
      geo.setAttribute('col', new BufferAttribute(col, 3));
      geo.setAttribute('sz', new BufferAttribute(sz, 1));
      geo.setAttribute('ph', new BufferAttribute(ph, 1));
      const mat = new ShaderMaterial({
        uniforms: {
          uTime: { value: 0 }, uPx: { value: this.px },
          uGain: { value: 0.42 + rnd() * 0.16 }
        },
        vertexShader: `
          attribute float sz; attribute float ph; attribute vec3 col;
          uniform float uTime, uPx;
          varying vec3 vC; varying float vA;
          void main(){
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vC = col;
            vA = 0.58 + 0.22 * sin(uTime * (0.5 + ph * 1.4) + ph * 40.0);
            gl_PointSize = max(1.0, sz * uPx / max(0.001, -mv.z));
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform float uGain;
          varying vec3 vC; varying float vA;
          void main(){
            float r = length(gl_PointCoord - vec2(0.5));
            if (r > 0.5) discard;
            gl_FragColor = vec4(vC, smoothstep(0.5, 0.05, r) * vA * uGain);
          }`,
        transparent: true, depthWrite: false, blending: AdditiveBlending
      });
      const disk = new Points(geo, mat);
      disk.frustumCulled = false;
      this.shaderMats.push(mat);

      const holder = new Group();
      if (inView) {
        const v = VISIBLE[i]!;
        // 深度 27~36：越远屏上越小，视差也越慢，才有「远景」的退后感
        holder.position.copy(skyPoint(v[0], v[1], 27 + rnd() * 9));
      } else {
        const j = i - VISIBLE.length;
        const yy = 1 - (j / (9 - VISIBLE.length)) * 2;
        const lat = Math.asin(Math.max(-0.85, Math.min(0.85, yy * 0.7)));
        const lon = j * 2.399963229728653 + rnd() * 0.9;
        holder.position.set(
          Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)
        ).multiplyScalar(29 + rnd() * 8);
      }
      holder.rotation.set(0.55 + rnd() * 1.5, rnd() * TAU, (rnd() - 0.5) * 1.2);
      holder.add(disk);
      this.far.add(holder);
    }
  }

  /* ============================================================
     脉冲星：以前是实心双锥（投影成灰蓝菱形），后来缩成一小撮点（太假、太小）。
     现在放大成一整套可辨认的结构，但依然是纯粒子，没有任何硬边几何面：
       · 星芒核（小、会随脉冲刺亮）
       · 双极锥形喷流 640 粒，沿轴有流动的亮结
       · 两道倾斜磁层环
       · 三道沿轴双向扩张的脉冲波前光环，每 4 秒一轮
     位置改由默认机位反投影给定 —— 旧坐标在视锥外，根本看不见。
   ============================================================ */
  private buildPulsar(glowTex: Texture, rnd: () => number): Pulsar {
    void glowTex;
    const holder = new Group();
    // 屏幕右侧偏上 (0.58, 0.06)，深度 36 —— 拉远才有距离感：小、暗、慢
    holder.position.copy(skyPoint(0.58, 0.06, 36));
    holder.lookAt(CAM);

    const axis = new Group();
    axis.rotation.z = 0.32;      // 轻微倾斜：双极保持可读，又不呆板对称
    holder.add(axis);

    const softFrag = `
      float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
      if (d > 1.0) discard;
    `;

    /* --- 双极锥形喷流（远处：结构整体收小，增益同步压低） --- */
    const JN = 480;
    const pos = new Float32Array(JN * 3);
    const col = new Float32Array(JN * 3);
    const sz = new Float32Array(JN);
    const ph = new Float32Array(JN);
    const aU = new Float32Array(JN);
    const aCore = new Float32Array(JN);
    const near = new Color('#EAF4FF');
    const mid = new Color('#8FC8FF');
    const far = new Color('#B98CFF');
    for (let i = 0; i < JN; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const u = Math.pow(rnd(), 0.78);
      // 10% 聚在轴心形成一道准直亮束：没有它，锥形散点读不出「双极」；
      // 比例不能再高，否则会变成一根激光线
      const core = rnd() < 0.10 ? 1 : 0;
      const spread = core ? 0.045 : 0.03 + u * u * 0.34;
      pos[i * 3] = (rnd() - 0.5) * spread;
      pos[i * 3 + 1] = side * (0.04 + u * 1.70);
      pos[i * 3 + 2] = (rnd() - 0.5) * spread;
      const c = u < 0.5
        ? near.clone().lerp(mid, u * 2)
        : mid.clone().lerp(far, (u - 0.5) * 2);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      sz[i] = (0.026 + Math.pow(rnd(), 3) * 0.075) * (core ? 1.3 : 1);
      ph[i] = rnd();
      aU[i] = u;
      aCore[i] = core;
    }
    const jetGeo = new BufferGeometry();
    jetGeo.setAttribute('position', new BufferAttribute(pos, 3));
    jetGeo.setAttribute('col', new BufferAttribute(col, 3));
    jetGeo.setAttribute('sz', new BufferAttribute(sz, 1));
    jetGeo.setAttribute('ph', new BufferAttribute(ph, 1));
    jetGeo.setAttribute('aU', new BufferAttribute(aU, 1));
    jetGeo.setAttribute('aCore', new BufferAttribute(aCore, 1));
    const jetMat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPx: { value: this.px }, uBeat: { value: 0 } },
      vertexShader: `
        attribute float sz; attribute float ph; attribute vec3 col; attribute float aU;
        attribute float aCore;
        uniform float uTime, uPx;
        varying vec3 vC; varying float vA; varying float vU;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vC = col; vU = aU;
          float tw = 0.68 + 0.32 * sin(uTime * (0.9 + ph * 2.2) + ph * 40.0);
          float knot = 0.72 + 0.28 * pow(abs(sin(aU * 22.0 - uTime * 2.4)), 3.0);
          vA = tw * knot * (1.0 + 1.7 * aCore);
          gl_PointSize = max(1.0, sz * uPx / max(0.001, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uBeat;
        varying vec3 vC; varying float vA; varying float vU;
        void main(){
          ${softFrag}
          float fade = pow(1.0 - vU, 0.62) * smoothstep(0.0, 0.04, vU);
          gl_FragColor = vec4(vC,
            pow(1.0 - d, 1.5) * vA * fade * (0.85 + 0.35 * uBeat) * 1.4);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending
    });
    const jets = new Points(jetGeo, jetMat);
    jets.frustumCulled = false;
    axis.add(jets);
    this.shaderMats.push(jetMat);

    /* --- 两道倾斜磁层环：给喷流一个「腰部」，读起来像天体而不是两撮点 --- */
    const RN = 240;
    const rp = new Float32Array(RN * 3);
    const rc = new Float32Array(RN * 3);
    const rs = new Float32Array(RN);
    const rph = new Float32Array(RN);
    const lilac = new Color('#A78CFF');
    const ice = new Color('#8FD0FF');
    for (let i = 0; i < RN; i++) {
      const band = i % 2;
      const a = (i / RN) * TAU * 2;
      const r = (band ? 0.58 : 0.74) + (rnd() - 0.5) * 0.07;
      rp[i * 3] = Math.cos(a) * r;
      rp[i * 3 + 1] = (band ? 0.13 : -0.13) + (rnd() - 0.5) * 0.07;
      rp[i * 3 + 2] = Math.sin(a) * r * 0.82;
      const c = lilac.clone().lerp(ice, rnd() * 0.7);
      rc[i * 3] = c.r; rc[i * 3 + 1] = c.g; rc[i * 3 + 2] = c.b;
      rs[i] = 0.014 + Math.pow(rnd(), 3) * 0.040;
      rph[i] = rnd();
    }
    const ringGeo = new BufferGeometry();
    ringGeo.setAttribute('position', new BufferAttribute(rp, 3));
    ringGeo.setAttribute('col', new BufferAttribute(rc, 3));
    ringGeo.setAttribute('sz', new BufferAttribute(rs, 1));
    ringGeo.setAttribute('ph', new BufferAttribute(rph, 1));
    const ringMat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPx: { value: this.px }, uBeat: { value: 0 } },
      vertexShader: `
        attribute float sz; attribute float ph; attribute vec3 col;
        uniform float uTime, uPx;
        varying vec3 vC; varying float vA;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vC = col;
          vA = 0.55 + 0.45 * sin(uTime * (0.7 + ph * 1.8) + ph * 36.0);
          gl_PointSize = max(1.0, sz * uPx / max(0.001, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uBeat;
        varying vec3 vC; varying float vA;
        void main(){
          ${softFrag}
          gl_FragColor = vec4(vC, pow(1.0 - d, 1.5) * vA * (0.72 + 0.30 * uBeat) * 1.15);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending
    });
    const rings = new Points(ringGeo, ringMat);
    rings.frustumCulled = false;
    axis.add(rings);
    this.shaderMats.push(ringMat);

    /* --- 三道脉冲波前：在赤道面由内向外扩张并淡出，每 4 秒一轮，相位错开。
           从相机看是逐渐张开的椭圆光环 —— 沿轴外扩那种「两点移动」根本读不出环。 --- */
    const WN = 120;
    const wp = new Float32Array(WN * 3);
    const wa = new Float32Array(WN);   // 环上角度 0..1
    const ws = new Float32Array(WN);
    const wsd = new Float32Array(WN);  // ±1 哪一侧
    const wph = new Float32Array(WN);
    for (let i = 0; i < WN; i++) {
      wa[i] = (i % (WN / 2)) / (WN / 2);
      ws[i] = 0.018 + Math.pow(rnd(), 3) * 0.034;
      wsd[i] = i < WN / 2 ? 1 : -1;
      wph[i] = rnd();
    }
    const waveGeo = new BufferGeometry();
    waveGeo.setAttribute('position', new BufferAttribute(wp, 3));
    waveGeo.setAttribute('aAng', new BufferAttribute(wa, 1));
    waveGeo.setAttribute('sz', new BufferAttribute(ws, 1));
    waveGeo.setAttribute('aSide', new BufferAttribute(wsd, 1));
    waveGeo.setAttribute('ph', new BufferAttribute(wph, 1));
    for (let k = 0; k < 3; k++) {
      const waveMat = new ShaderMaterial({
        uniforms: {
          uTime: { value: 0 }, uPx: { value: this.px },
          uBeat: { value: 0 }, uPhase: { value: k / 3 }
        },
        vertexShader: `
          attribute float aAng; attribute float sz; attribute float aSide; attribute float ph;
          uniform float uTime, uPx, uPhase, uBeat;
          varying float vA;
          void main(){
            float p = fract(uTime * 0.25 + uPhase);       // 4 秒一轮
            float rad = 0.10 + p * 1.15;                  // 赤道面由内向外扩张
            float ang = aAng * 6.2831853;
            vec3 q = vec3(cos(ang) * rad, aSide * 0.02, sin(ang) * rad);
            vec4 mv = modelViewMatrix * vec4(q, 1.0);
            vA = pow(1.0 - p, 1.4) * (0.62 + 0.38 * uBeat)
               * (0.62 + 0.38 * sin(uTime * 3.0 + ph * 30.0));
            gl_PointSize = max(1.0, sz * uPx / max(0.001, -mv.z));
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          varying float vA;
          void main(){
            ${softFrag}
            gl_FragColor = vec4(0.66, 0.80, 1.0, pow(1.0 - d, 1.4) * vA * 1.4);
          }`,
        transparent: true, depthWrite: false, blending: AdditiveBlending
      });
      const wave = new Points(waveGeo, waveMat);
      wave.frustumCulled = false;
      axis.add(wave);
      this.shaderMats.push(waveMat);
    }

    const coreMat = new SpriteMaterial({
      map: makeStarTex(), color: new Color('#E6F2FF'), transparent: true, opacity: 0.6,
      depthWrite: false, blending: AdditiveBlending, fog: false
    });
    const core = new Sprite(coreMat);
    core.scale.setScalar(0.30);
    holder.add(core);

    this.far.add(holder);
    return { axis, core, coreMat };
  }

  /* ============================================================
     每帧
   ============================================================ */
  update(t: number, dt: number): void {
    if (dt <= 0) return;                     // 详情页：clock 不推进，一切定格

    for (let i = 0; i < this.belts.length; i++) {
      this.beltsBase[i]!.rotation.y += this.belts[i]!.sp * dt;
    }

    // 彗星统一调度：间隔 4.2~4.9 秒触发一颗
    if (t >= this.nextCometAt) {
      const c = this.comets[this.cometIdx % this.comets.length]!;
      c.startAt = t;
      c.run = this.cometRuns;
      this.cometIdx++;
      this.cometRuns++;
      this.nextCometAt = t + 4.2 + this.rnd() * 0.7;
    }

    for (const c of this.comets) {
      const s = c.spec;
      const local = t - c.startAt;
      if (local < 0 || local >= s.dur) {
        if (c.holder.visible) c.holder.visible = false;
        continue;
      }
      c.holder.visible = true;

      const u = local / s.dur;
      const fade = smooth(0, 0.16, u) * smooth(1, 0.74, u);
      const th = s.ph + c.run * 0.83 + u * s.sweep;
      const x = Math.cos(th) * s.a;
      const z = Math.sin(th) * s.b;
      c.coma.position.set(x, 0, z);
      c.nucleus.position.set(x, 0, z);
      // 彗发在中段最胀，核始终比彗发小而锐
      c.coma.scale.setScalar(0.62 + 0.14 * Math.sin(Math.PI * u));
      c.comaMat.opacity = 0.78 * fade;
      c.nucleusMat.opacity = 0.98 * fade;
      c.nucleus.scale.setScalar(0.22 + 0.05 * Math.sin(Math.PI * u));

      // 运动切向；两条尾都朝反方向铺，但形态不同
      const tx = -Math.sin(th) * s.a * s.sweep;
      const tz = Math.cos(th) * s.b * s.sweep;
      const tl = Math.hypot(tx, tz) || 1;
      const ux = tx / tl;
      const uz = tz / tl;
      const len = c.len * (0.55 + 0.45 * Math.sin(Math.PI * u)) * fade;

      for (let j = 0; j < 2; j++) {
        const ion = j === 0;
        for (let k = 0; k < TAIL_N; k++) {
          const i = j * TAIL_N + k;
          const v = k / (TAIL_N - 1);
          const d = v * len * (ion ? 1.08 : 0.82);
          // 离子尾窄而直；尘埃尾宽、弯、被轨道甩向一侧
          const wob = Math.sin(k * 0.55 + t * 1.2 + (ion ? 0 : 1.7));
          const off = (ion ? v * v * 0.030 : v * v * 0.24) * wob + (ion ? 0 : v * v * 0.45);
          c.tailPos.setXYZ(
            i,
            x - ux * d - uz * off,
            (ion ? 0.020 : 0.065) * Math.sin(k * 0.9 + t * 0.4) * v,
            z - uz * d + ux * off
          );
          c.tailA.setX(i, Math.pow(1 - v, ion ? 1.15 : 1.5) * (ion ? 1.0 : 0.82) * fade);
          c.tailSz.setX(i, ion ? 0.016 + v * 0.042 : 0.022 + v * 0.075);
        }
      }
      c.tailPos.needsUpdate = true;
      c.tailA.needsUpdate = true;
      c.tailSz.needsUpdate = true;
    }

    // 脉冲星：磁轴缓慢进动（绕 Y 是喷流自己的轴，只转它等于没动）+ 每约 4 秒一次短脉冲
    this.pulsar.axis.rotation.y += dt * 0.55;
    this.pulsar.axis.rotation.x = 0.16 * Math.sin(t * 0.24);
    const beat = Math.pow(Math.max(0, Math.sin(t * 1.6)), 7);
    this.pulsar.coreMat.opacity = 0.55 + 0.35 * beat;
    this.pulsar.core.scale.setScalar(0.27 + 0.12 * beat);

    for (const m of this.shaderMats) {
      const u = m.uniforms;
      if (u['uTime']) u['uTime']!.value = t;
      if (u['uBeat']) u['uBeat']!.value = beat;
    }
  }

  /** 银河层 1、模块层 0：没有星核时，环绕它的碎石与彗星一起退场 */
  setCoreGain(v: number): void {
    this.coreGain = v;
    this.near.visible = v > 0.01;
  }

  /** 点尺寸系数与 core3d 的其它点材质共用同一个 px 定义 */
  resize(px: number): void {
    this.px = px;
    for (const m of this.shaderMats) {
      const u = m.uniforms['uPx'];
      if (u) u.value = px;
    }
  }

  get gain(): number { return this.coreGain; }
}
