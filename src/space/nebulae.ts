/**
 * 星云层 —— 「模块＝星云团」+「笔记＝迷你星系」+「多丝突触束」。
 *
 * 对齐参考项目：
 *   - buildNebulae：模块是一团粒子云（无中央亮核，只有极淡 HAZE 垫底雾），
 *     按 STYLE_OF 分 ring / swirl / stream / spark 四种形态；
 *   - BUN 突触束：每束 10~14 条独立贝塞尔细丝，起止点随机取云内位置，
 *     控制点向外推，顶点色从云 A 渐变到云 B，低透明度叠加 —— 不再是一根线；
 *   - pulses：光点沿丝奔跑（newPulse：随机丝 + u 进度 + 0.16~0.34 速度）。
 *
 * 场景切换：galaxy 显示四个模块大团 + 突触束；study/code 显示各实体的
 * 迷你星系（缩小的旋臂云），让「每篇笔记外形是一个小星系」。
 *
 * 布局用相机空间：门户与笔记都是 DOM 按视口百分比定位的，NDC 反投影
 * 保证 3D 团精确贴住那颗星，且随窗口尺寸重新对齐。
 */
import {
  Group, Points, Sprite, SpriteMaterial, Color, Vector3,
  BufferGeometry, Float32BufferAttribute, BufferAttribute, ShaderMaterial,
  LineSegments, AdditiveBlending, DynamicDrawUsage,
  PerspectiveCamera, type Texture
} from 'three';
import { SCENES, entitiesOf } from './coords';
import type { SceneName } from '../core/state';

const TAU = Math.PI * 2;
const DEPTH = 8;           // 对齐深度：云团放在默认机位前 8 个单位处（越近越大）
const FOV_RAD = 36 * Math.PI / 180;

type Style = 'ring' | 'swirl' | 'stream' | 'spark' | 'ghost';

interface CloudSpec {
  id: string;
  style: Style;
  /** 团的特征半径（相机空间单位） */
  R: number;
  cIn: string;
  cOut: string;
  glow: string;
  n?: number;
  strands?: number;
  link?: number;
  /** 整团在屏幕平面内的旋转（彗尾流用） */
  tilt?: number;
  /** 粒子尺寸放大系数（迷你星系用小半径但要亮，靠它补偿） */
  szBoost?: number;
}

/** 四个门户：颜色按参考图的方向分布（左上紫 / 左下粉 / 右下蓝 / 右上金） */
const CLOUDS: readonly CloudSpec[] = [
  { id: 'study',  style: 'ring',   R: 0.62, cIn: '#EFE8FF', cOut: '#8A6FCB', glow: '#B9A8FF', link: 0.30 },
  { id: 'spider', style: 'swirl',  R: 0.62, cIn: '#FFE4EF', cOut: '#D2598C', glow: '#FF9CC4', link: 0.26 },
  { id: 'code',   style: 'stream', R: 0.68, cIn: '#EAF5FF', cOut: '#4C86D8', glow: '#BFE0FF', link: 0.32, tilt: 0.55 },
  { id: 'gate',   style: 'spark',  R: 0.62, cIn: '#FFF3D8', cOut: '#C08A46', glow: '#FFD27A', link: 0.18 }
];

/** 迷你星系（study/code 场景的每颗星）：场景主色的缩小旋臂云 */
const MINI_TONE: Record<string, { cIn: string; cOut: string; glow: string }> = {
  study: { cIn: '#EFE8FF', cOut: '#8A6FCB', glow: '#B9A8FF' },
  code:  { cIn: '#E2F2FF', cOut: '#4C86D8', glow: '#9FC8FF' }
};

/** 每束突触的丝数与脉冲数 */
const STRANDS_PER_MODULE = 8;
const PULSES_PER_MODULE = 3;
const CORE_TINT = new Color('#6F82A4');

interface StrandDef {
  /** 起点相对模块中心的偏移 / 终点相对核的偏移（relayout 时换算绝对值） */
  off0: Vector3;
  off1: Vector3;
  c: Vector3;            // 控制点（绝对，relayout 重算）
  p0: Vector3;
  p1: Vector3;
  amp: number;
  fr: number;
  ph: number;
  push: Vector3;         // 控制点外推方向（固定，防抖）
  /** 第三维摆动：屏幕内波动之外，丝还朝镜头方向鼓 / 收，投出纵深感 */
  zAmp: number;
  fr2: number;
  ph2: number;
}

/** 一条 Hebbian 光丝的渲染信息（main.ts 从 notes/links 换算后注入） */
export interface ThreadRender {
  a: string;
  b: string;
  /** 归一化权重 0–1（决定亮度） */
  norm: number;
  /** hover 焦点 / 刚走过：高亮 */
  hot: boolean;
  /** 站体打开时压暗，别让亮线横穿正文 */
  dim: boolean;
}

/* ---- 关联丝束：一条「关系」不是一根线，而是一束会呼吸的能量纤维 ---- */
const TH_SEG = 18;        // 每条丝的段数
const TH_STRANDS = 4;     // 每条关联由几根丝组成
const TH_VERTS = TH_STRANDS * TH_SEG * 2;
const TH_DUST = 24;       // 沿丝散布的星尘点数
/** 两端色调：学习层的冷紫 → 冰蓝，中途泛白，和迷你星系同源 */
const TH_A = new Color('#A98CE8');
const TH_B = new Color('#7FB2E8');
const TH_WHITE = new Color('#F3EFE6');

interface ThreadStrand {
  bow: number;      // 横向弓起（相对弦长的比例）
  z: number;        // 深度偏移：丝束有厚度
  amp: number;      // 摆动幅度
  fr: number;
  ph: number;
  bright: number;
  ctrl: Vector3;    // 每帧算出的控制点，给光点沿丝跑用
}

interface ThreadRec {
  root: Group;
  line: LineSegments;
  geo: BufferGeometry;
  pos: BufferAttribute;
  mat: ShaderMaterial;
  strands: ThreadStrand[];
  motes: { spr: Sprite; si: number; u: number; v: number }[];
  /** 沿丝散布的星尘：让关系看起来是物质桥，不是几条线 */
  dustPos: BufferAttribute;
  dustMat: ShaderMaterial;
  dustGeo: BufferGeometry;
  dustSeed: { u: number; side: number; z: number }[];
  a: string;
  b: string;
  norm: number;
  hot: boolean;
  dim: boolean;
}

export class ModuleNebulae {
  readonly group = new Group();
  private readonly holders = new Map<string, Group>();
  private readonly minis = new Map<SceneName, Map<string, Group>>();
  private readonly spins: { holder: Group; ax: Vector3; sp: number }[] = [];
  private readonly strandLines: { line: LineSegments; def: StrandDef; geo: BufferGeometry }[] = [];
  private readonly pulses: { spr: Sprite; si: number; u: number; v: number }[] = [];
  private readonly pulseGroup = new Group();
  private readonly linkGroup = new Group();
  /** 3D 关联丝束：端点钉在迷你星系上，镜头转到哪都跟着 */
  private readonly threadGroup = new Group();
  private readonly threadLines = new Map<string, ThreadRec>();
  private threadSig = '';
  /** main.ts 注入的光丝提供者（Hebbian 权重 / 高亮 / 压暗都在那边算） */
  threadProvider: (() => readonly ThreadRender[]) | null = null;
  private readonly mat: ShaderMaterial;
  private readonly miniMat: ShaderMaterial;
  private readonly glowTex: Texture;
  /** 对齐相机：只用于把屏幕百分比反投影成世界坐标，姿态 = Core3D 的标准机位 */
  private readonly alignCam: PerspectiveCamera;
  private scene: SceneName = 'galaxy';
  private gain = 1;
  private gainTarget = 1;
  private lastT = 0;
  private lastPx = 900;
  private aspect = 1;
  private lastHeight = 900;

  constructor(glowTex: Texture, rnd: () => number, camDist: number, basePitch: number) {
    this.glowTex = glowTex;
    this.rnd = rnd;
    this.g3 = (): number => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    // 对齐相机：与 Core3D 的默认机位（yaw=0 / 基础俯角 / camDist / lookAt 原点）完全一致，
    // 这样反投影出来的世界坐标在默认视角下与 DOM 实体逐像素对齐。
    // 关键差异：云团从「挂在相机上」改为「挂在场景里」——拖拽 orbit 时整个空间
    // （核、环、云、丝）一起产生视差位移，云不再是一张贴在镜头上的贴纸。
    this.alignCam = new PerspectiveCamera(FOV_RAD, 1, 0.1, 80);
    this.alignCam.position.set(0, Math.sin(basePitch) * camDist, Math.cos(basePitch) * camDist);
    this.alignCam.lookAt(0, 0, 0);
    this.mat = this.makePointsMaterial();
    this.miniMat = this.makePointsMaterial();

    for (const spec of CLOUDS) {
      const holder = this.makeCloud(spec, this.g3, rnd);
      this.holders.set(spec.id, holder);
      this.group.add(holder);
    }
    this.buildStrands(rnd, this.g3);
    this.threadGroup.visible = false;
    this.group.add(this.linkGroup, this.pulseGroup, this.threadGroup);
    this.relayout(1.6, 900);
  }

  private readonly rnd: () => number;
  private readonly g3: () => number;

  private makePointsMaterial(): ShaderMaterial {
    return new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPx: { value: 1384 }, uGain: { value: 1 } },
      vertexShader: `
        attribute vec3 col; attribute float sz; attribute float ph;
        uniform float uTime; uniform float uPx; uniform float uGain;
        varying vec3 vC; varying float vA;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float tw = 0.55 + 0.45 * sin(uTime * (0.7 + ph * 1.9) + ph * 40.0);
          vC = col;
          vA = (0.50 + 0.70 * ph) * tw * uGain;
          gl_PointSize = max(1.0, sz * 0.0068 * uPx / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vC; varying float vA;
        void main(){
          float r = length(gl_PointCoord - vec2(0.5));
          if (r > 0.5) discard;
          gl_FragColor = vec4(vC, smoothstep(0.5, 0.10, r) * vA);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending
    });
  }

  private makeCloud(spec: CloudSpec, g3: () => number, rnd: () => number, mat?: ShaderMaterial): Group {
    const holder = new Group();
    if (spec.tilt) holder.rotation.z = spec.tilt;
    // 真三维姿态：给盘面一个随机倾角，配合绕盘面法线的自转，
    // 星云看起来是一颗「斜着转的星系」，而不是正对镜头的一张贴图
    if (spec.style === 'ring') holder.rotation.x = 0.55 + rnd() * 0.50;
    else if (spec.style === 'swirl') holder.rotation.x = 0.42 + rnd() * 0.45;
    else if (spec.style === 'spark') holder.rotation.x = 0.32 + rnd() * 0.40;
    else if (spec.style === 'ghost') holder.rotation.x = 0.35;
    const cIn = new Color(spec.cIn);
    const cOut = new Color(spec.cOut);
    const WHITE = new Color('#FFFFFF');
    const R = spec.R;
    const pos: number[] = [];
    const col: number[] = [];
    const sz: number[] = [];
    const ph: number[] = [];
    const push = (x: number, y: number, z: number, br: number, size: number): void => {
      pos.push(x, y, z);
      // 内圈更白亮，外圈落回团色；再让少数粒子雪白（参考 mix3(col, WHITE, w*.8)）
      const t = Math.min(1, Math.hypot(x, y) / (R * 1.15));
      const c = cOut.clone().lerp(cIn, Math.max(0, 0.85 - t))
        .lerp(WHITE, Math.pow(rnd(), 3.5) * 0.75);
      const b = (0.55 + rnd() * 0.60) * br;
      col.push(c.r * b, c.g * b, c.b * b);
      sz.push(size);
      ph.push(rnd());
    };

    const arms = 2 + (rnd() < 0.5 ? 1 : 0);
    const spinDir = rnd() < 0.5 ? 1 : -1;
    const a0 = rnd() * TAU;
    // spark（金团）的四瓣：参考 puff/twin 的 lobes
    const lobes = Array.from({ length: 4 }, () => {
      const a = rnd() * TAU;
      const rr = R * rnd() * 0.42;
      return { x: Math.cos(a) * rr * 1.1, y: Math.sin(a) * rr * 0.8, r: R * (0.36 + rnd() * 0.24) };
    });

    const N = spec.n ?? (spec.style === 'ring' ? 1500 : 1350);
    for (let i = 0; i < N; i++) {
      let x = 0;
      let y = 0;
      let br = 1;
      if (spec.style === 'ring') {
        if (rnd() < 0.10) { x = g3() * R * 0.30; y = g3() * R * 0.22; br = 0.6; }
        else {
          const a = rnd() * TAU;
          const rr = R * (0.66 + g3() * 0.09);
          x = Math.cos(a) * rr * 1.12;
          y = Math.sin(a) * rr * 0.82;
          // 参考的亮弧：环有一段明显更亮
          br = 0.85 + 0.35 * Math.max(0, Math.cos(a - a0));
        }
      } else if (spec.style === 'swirl') {
        if (rnd() < 0.22) { x = g3() * R * 0.17; y = g3() * R * 0.14; br = 1.25; }
        else {
          const t = Math.pow(rnd(), 0.8);
          const a = a0 + ((i % arms) / arms) * TAU + spinDir * t * 3.4;
          const rr = R * (0.12 + 0.86 * t);
          const wd = R * (0.13 - 0.07 * t);
          x = Math.cos(a) * rr * 1.1 + g3() * wd;
          y = Math.sin(a) * rr * 0.82 + g3() * wd;
          br = 1.1 - t * 0.4;
        }
      } else if (spec.style === 'stream') {
        const t = Math.pow(rnd(), 1.3);
        const wd = R * (0.34 * (1 - t) + 0.06);
        x = R * (0.75 - 1.85 * t) + g3() * R * 0.06;
        y = g3() * wd + Math.sin(t * 5 + a0) * R * 0.12 * t;
        br = 1.15 - t * 0.55;
      } else if (spec.style === 'ghost') {
        // 虚影恒星：极稀疏的淡环，一看就「还没写」
        const a = rnd() * TAU;
        const rr = R * (0.7 + g3() * 0.12);
        x = Math.cos(a) * rr;
        y = Math.sin(a) * rr * 0.8;
        br = 0.35;
      } else {
        const L = lobes[(rnd() * lobes.length) | 0]!;
        x = L.x + g3() * L.r * 0.58;
        y = L.y + g3() * L.r * 0.5;
        br = 1.05 + rnd() * 0.35;
      }
      // 深度抖动给一点视差层次；环薄、旋臂厚，让每团星云都有可感知的体积
      const boost = spec.szBoost ?? 1;
      const zSpread = spec.style === 'ring' ? 0.20 : spec.style === 'stream' ? 0.24 : 0.36;
      push(x, y * 0.92, g3() * zSpread, br, (0.9 + Math.pow(rnd(), 7) * 5.4) * boost);
    }

    // 纤维丝：参考 NF 条 × FP 点的波浪线，贴着云面走
    const FP = 30;
    const strandN = spec.strands ?? (spec.style === 'ring' ? 8 : spec.style === 'spark' ? 6 : 10);
    for (let f = 0; f < strandN; f++) {
      let x0 = 0;
      let y0 = 0;
      let dir = 0;
      if (spec.style === 'ring' || spec.style === 'ghost') {
        const a = rnd() * TAU;
        x0 = Math.cos(a) * R * 0.73;
        y0 = Math.sin(a) * R * 0.54;
        dir = a + Math.PI / 2 + (rnd() - 0.5) * 0.5;
      } else if (spec.style === 'stream') {
        x0 = R * (0.6 - 1.5 * rnd());
        y0 = (rnd() - 0.5) * R * 0.4;
        dir = (rnd() - 0.5) * 0.35;
      } else if (spec.style === 'swirl') {
        const t = rnd();
        const a = a0 + ((f % arms) / arms) * TAU + spinDir * t * 3.4;
        const rr = R * (0.15 + 0.8 * t);
        x0 = Math.cos(a) * rr * 1.1;
        y0 = Math.sin(a) * rr * 0.82;
        dir = a + Math.PI / 2;
      } else {
        x0 = (rnd() - 0.5) * R * 1.4;
        y0 = (rnd() - 0.5) * R * 0.9;
        dir = (rnd() - 0.5) * 1.8;
      }
      const len = R * (0.4 + rnd() * 0.7);
      const amp = R * (0.05 + rnd() * 0.12);
      const fr = 2 + rnd() * 4;
      const phase = rnd() * TAU;
      const cc = cIn.clone().lerp(WHITE, 0.25 + rnd() * 0.4);
      for (let q = 0; q < FP; q++) {
        const u = q / (FP - 1) - 0.5;
        const bend = Math.sin(u * fr * 1.05 + phase) * amp;
        const x = x0 + Math.cos(dir) * u * len - Math.sin(dir) * bend;
        const y = y0 + Math.sin(dir) * u * len * 0.6 + Math.cos(dir) * bend * 0.6;
        const fade = 1 - Math.abs(u) * 1.6;
        const b = (0.4 + 0.55 * Math.max(0, fade)) * (0.5 + rnd() * 0.5);
        pos.push(x, y, g3() * 0.2);
        col.push(cc.r * b, cc.g * b, cc.b * b);
        sz.push(0.7 + rnd() * 0.6);
        ph.push(rnd());
      }
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('col', new Float32BufferAttribute(col, 3));
    g.setAttribute('sz', new Float32BufferAttribute(sz, 1));
    g.setAttribute('ph', new Float32BufferAttribute(ph, 1));
    holder.add(new Points(g, mat ?? this.mat));

    // 光雾：参考 HAZE —— 多个极淡的垫底雾，绝不放中央亮核
    const hazeN = spec.style === 'ghost' ? 2 : 5;
    for (let q = 0; q < hazeN; q++) {
      const a = (q / hazeN) * TAU + a0;
      const rr = (spec.style === 'ring' || spec.style === 'ghost') ? R * 0.72 : R * 0.45 * (0.3 + rnd() * 0.7);
      const h = new Sprite(new SpriteMaterial({
        map: this.glowTex, color: new Color(spec.glow),
        transparent: true, opacity: (spec.style === 'ghost' ? 0.03 : 0.05) + rnd() * 0.04,
        depthWrite: false, blending: AdditiveBlending
      }));
      h.position.set(Math.cos(a) * rr * 1.1, Math.sin(a) * rr * 0.8, -0.15);
      h.scale.setScalar(R * (1.1 + rnd() * 0.7));
      holder.add(h);
    }
    // 绕盘面法线（局部 Z）的增量自转：rotateOnAxis 不覆盖基础倾角，
    // 倾斜的盘面转起来才是立体星系（旧的 rotation.z 赋值会把倾角洗掉）
    if (spec.style === 'swirl' || spec.style === 'ring') {
      this.spins.push({ holder, ax: new Vector3(0, 0, 1), sp: (spec.style === 'swirl' ? 0.045 : 0.018) * spinDir });
    }
    return holder;
  }

  /* ============================================================
     突触束：参考 BUN —— 每束多条独立贝塞尔细丝 + 沿线光脉冲。
     材质是自绘 shader 而不是 LineBasicMaterial：1px 实色线是「一根线」，
     沿线跑的能量亮带 + 呼吸明暗才是「一条活的输能管」。
     ============================================================ */
  private buildStrands(rnd: () => number, g3: () => number): void {
    for (const spec of CLOUDS) {
      for (let s = 0; s < STRANDS_PER_MODULE; s++) {
        const def: StrandDef = {
          // 起点在云内随机（参考 i0 = members[a] 随机成员），终点贴核周随机小偏移
          off0: new Vector3(g3() * 0.30, g3() * 0.24, g3() * 0.22),
          off1: new Vector3(g3() * 0.16, g3() * 0.13, g3() * 0.14),
          p0: new Vector3(), p1: new Vector3(), c: new Vector3(),
          amp: 0.05 + rnd() * 0.10,
          fr: 0.6 + rnd() * 1.2,
          ph: rnd() * TAU,
          push: new Vector3(0, 0, 0),
          zAmp: 0.10 + rnd() * 0.16,
          fr2: 0.4 + rnd() * 0.9,
          ph2: rnd() * TAU
        };
        const geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(new Float32Array(12 * 6), 3).setUsage(DynamicDrawUsage));
        const colors = new Float32Array(12 * 6);
        // aU：沿丝的参数坐标（0=模块端 → 1=星核端），fragment 用它铺能量亮带
        const au = new Float32Array(12 * 6);
        const ca = new Color(spec.cOut);
        for (let k = 0; k < 12; k++) {
          const u = k / 12;
          const c = ca.clone().lerp(CORE_TINT, u * 0.9);
          for (const v of [0, 1]) {
            const o = (k * 2 + v) * 3;
            colors[o] = c.r; colors[o + 1] = c.g; colors[o + 2] = c.b;
            au[k * 2 + v] = (k + v) / 12;
          }
        }
        geo.setAttribute('aCol', new BufferAttribute(colors, 3));
        geo.setAttribute('aU', new BufferAttribute(au, 1));
        const line = new LineSegments(geo, new ShaderMaterial({
          uniforms: {
            uTime: { value: 0 }, uGain: { value: 1 },
            // 基础透明度略高于旧实现：亮带本身只占少数时刻，均值必须够看
            uBase: { value: 0.16 + rnd() * 0.14 },
            uPh: { value: rnd() * TAU },
            // 流速带方向：一半丝顺流、一半逆流，避免全线同向「检票闸机」感
            uSp: { value: (0.7 + rnd() * 0.9) * (rnd() < 0.5 ? 1 : -1) }
          },
          vertexShader: `
            attribute vec3 aCol; attribute float aU;
            uniform float uGain;
            varying vec3 vC; varying float vU; varying float vG;
            void main(){
              vC = aCol; vU = aU; vG = uGain;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: `
            uniform float uTime; uniform float uBase; uniform float uPh; uniform float uSp;
            varying vec3 vC; varying float vU; varying float vG;
            void main(){
              // 主亮带：窄而亮，沿线奔跑（能量从云流向核 / 或反向）
              float f1 = pow(max(0.0, 0.5 + 0.5 * sin(vU * 21.0 - uTime * uSp * 6.0 + uPh)), 5.0);
              // 副呼吸：宽而缓的明暗，让线在静止时也不是死的
              float f2 = 0.5 + 0.5 * sin(vU * 9.0 + uTime * abs(uSp) * 1.4 + uPh * 2.7);
              // 两端微收：丝是从云里长出来的，不在断口处生硬截断
              float edge = smoothstep(0.0, 0.10, vU) * (1.0 - smoothstep(0.90, 1.0, vU));
              float a = uBase * vG * (0.30 + 0.70 * f1) * (0.55 + 0.45 * f2) * (0.65 + 0.35 * edge);
              vec3 col = mix(vC, vec3(1.0, 0.97, 0.90), f1 * 0.5);
              gl_FragColor = vec4(col, a);
            }`,
          transparent: true, blending: AdditiveBlending, depthWrite: false
        }));
        this.linkGroup.add(line);
        line.frustumCulled = false;   // 几何每帧重铺，包围球重算纯属浪费；丝总在画面中心区
        this.strandLines.push({ line, def, geo });
      }
      // 光脉冲：参考 newPulse，随机丝 + 进度 + 速度
      for (let p = 0; p < PULSES_PER_MODULE; p++) {
        const spr = new Sprite(new SpriteMaterial({
          map: this.glowTex, color: new Color(spec.cIn),
          transparent: true, opacity: 0.9, depthWrite: false, blending: AdditiveBlending
        }));
        spr.scale.setScalar(0.09);
        this.pulseGroup.add(spr);
        this.pulses.push({
          spr, si: Math.floor(rnd() * STRANDS_PER_MODULE),
          u: rnd(), v: 0.16 + rnd() * 0.22
        });
      }
    }
  }

  /** 二次贝塞尔求值 */
  private static qbez(p0: Vector3, c: Vector3, p1: Vector3, u: number, out: Vector3): Vector3 {
    const v = 1 - u;
    return out.set(
      v * v * p0.x + 2 * v * u * c.x + u * u * p1.x,
      v * v * p0.y + 2 * v * u * c.y + u * u * p1.y,
      v * v * p0.z + 2 * v * u * c.z + u * u * p1.z
    );
  }

  /* ============================================================
     场景切换：galaxy 大团 + 突触束；study/code 迷你星系
     ============================================================ */
  setScene(scene: SceneName): void {
    const changed = this.scene !== scene;
    this.scene = scene;
    const isGalaxy = scene === 'galaxy';
    for (const h of this.holders.values()) h.visible = isGalaxy;
    this.linkGroup.visible = isGalaxy;
    this.pulseGroup.visible = isGalaxy;
    this.threadGroup.visible = scene === 'study';
    for (const [sc, map] of this.minis) {
      const on = sc === scene;
      for (const h of map.values()) h.visible = on;
    }
    if (scene === 'study' || scene === 'code') {
      // 增量补建：新写的笔记也有一颗自己的迷你星系（不只是七颗种子）
      this.ensureMinis(scene);
    }
    // 立刻铺一次几何：Reduced Motion 下渲染循环不跑 setTime，
    // 光丝也得有形状（只是不摆动、不流光）
    if (scene === 'study') this.syncThreads(this.lastT, 0);
    if (changed) {
      // 懒构建出来的团还没摆位 —— 立刻按冻结坐标重排，否则全堆在相机原点
      if (!isGalaxy) this.relayout(this.aspect, this.lastHeight);
      this.gainTarget = 1;
      this.gain = isGalaxy ? 1 : 0;   // 新出现的组从 0 淡入
    }
  }

  /** 增量构建某场景的迷你星系（笔记坐标契约：位置由 id 决定） */
  private ensureMinis(scene: 'study' | 'code'): void {
    let map = this.minis.get(scene);
    if (!map) { map = new Map(); this.minis.set(scene, map); }
    const tone = MINI_TONE[scene]!;
    let grew = false;
    for (const e of entitiesOf(scene)) {
      if (map.has(e.id)) continue;
      const ghost = e.kind === 'phantom';
      const spec: CloudSpec = {
        id: e.id,
        style: ghost ? 'ghost' : 'swirl',
        R: ghost ? 0.15 : 0.18 + this.rnd() * 0.07,
        cIn: tone.cIn, cOut: tone.cOut, glow: tone.glow,
        n: ghost ? 170 : 380 + Math.floor(this.rnd() * 120),
        strands: ghost ? 2 : 3,
        szBoost: 1.8
      };
      const holder = this.makeCloud(spec, this.g3, this.rnd, this.miniMat);
      holder.rotation.z = (this.rnd() - 0.5) * 0.9;   // 每个小星系姿态各异
      holder.visible = this.scene === scene;
      // 新建的团立刻落到冻结坐标：同场景内补建时不会有 relayout 兜底
      holder.position.copy(this.worldAt(e.x, e.y, this.aspect, this.tmpW));
      map.set(e.id, holder);
      this.group.add(holder);
      grew = true;
    }
    // 已删除的笔记：它的迷你星系一并退场，别留一团没有名字的云
    const alive = new Set(entitiesOf(scene).map(e => e.id));
    for (const [id, h] of [...map]) {
      if (alive.has(id)) continue;
      map.delete(id);
      this.group.remove(h);
      h.traverse(obj => {
        const o = obj as unknown as { geometry?: BufferGeometry; material?: { map?: Texture; dispose?: () => void } };
        o.geometry?.dispose();
        o.material?.map?.dispose();
        o.material?.dispose?.();
      });
      grew = true;
    }
    // 长出新星系 / 退掉旧星系时光丝的端点也要跟上一批
    if (grew) this.updateThreadPositions();
  }

  /* ============================================================
     摆位：屏幕百分比 → 世界坐标（默认机位反投影），窗口变化重算。
     云团从此属于场景：拖拽 orbit 时它们和核、环一起产生视差位移。
     ============================================================ */
  /** 屏幕百分比 → 默认机位下同屏位置的世界坐标（复用 out，避免每帧分配） */
  private tmpW = new Vector3();
  private worldAt(x: number, y: number, aspect: number, out: Vector3): Vector3 {
    const halfH = Math.tan(FOV_RAD / 2) * DEPTH;
    const halfW = halfH * aspect;
    out.set((x - 0.5) * 2 * halfW, (0.5 - y) * 2 * halfH, -DEPTH);
    return this.alignCam.localToWorld(out);
  }

  relayout(aspect: number, height: number): void {
    this.aspect = aspect;
    this.lastHeight = height;
    const uPx = height / (2 * Math.tan(FOV_RAD / 2));
    this.mat.uniforms['uPx']!.value = uPx;
    this.miniMat.uniforms['uPx']!.value = uPx;
    this.lastPx = uPx;
    for (const rec of this.threadLines.values()) rec.dustMat.uniforms['uPx']!.value = uPx;
    // 对齐相机随窗口比例更新姿态（aspect 变了反投影结果才会对）
    this.alignCam.aspect = aspect;
    this.alignCam.updateProjectionMatrix();
    this.alignCam.updateMatrixWorld(true);
    // 中央核在屏幕 (0.50, 0.47)，与 coords.ts 的 AI 星核实体一致
    const core = this.worldAt(0.50, 0.47, aspect, this.tmpW).clone();

    for (const e of SCENES.galaxy) {
      const holder = this.holders.get(e.id);
      if (!holder) continue;                 // core 是丝带核，不做星云团
      holder.position.copy(this.worldAt(e.x, e.y, aspect, this.tmpW));
    }
    for (const [sc, map] of this.minis) {
      for (const e of SCENES[sc]) {
        const holder = map.get(e.id);
        if (holder) holder.position.copy(this.worldAt(e.x, e.y, aspect, this.tmpW));
      }
    }
    // 突触束起止点：起点贴云内，终点贴核周；控制点 = 中点 + 外推 + 上下推
    let si = 0;
    for (const spec of CLOUDS) {
      const e = SCENES.galaxy.find(x => x.id === spec.id)!;
      const m = this.worldAt(e.x, e.y, aspect, this.tmpW).clone();
      for (let s = 0; s < STRANDS_PER_MODULE; s++, si++) {
        const rec = this.strandLines[si];
        if (!rec) continue;
        const d = rec.def;
        d.p0.copy(m).add(d.off0);
        d.p1.copy(core).add(d.off1);
        const mid = d.p0.clone().add(d.p1).multiplyScalar(0.5);
        const out = mid.clone().sub(core);
        out.z = 0;
        if (out.lengthSq() < 0.01) out.set(0, 1, 0);
        out.normalize();
        // 外推：让丝在半途鼓出弧度（参考 BUN 的 push），四束方向各异
        const side = (si % 2 === 0 ? 1 : -1) * (0.35 + (si % 3) * 0.18);
        d.c.copy(mid)
          .addScaledVector(out, 0.22 + (si % 4) * 0.10)
          .add(new Vector3(0, side * 0.45, (si % 5 - 2) * 0.12));
        // 顶点色终点用核色，重新铺一遍渐变起点（颜色静态，位置每帧算）
      }
    }
    for (const rec of this.strandLines) this.updateStrand(rec, 0);
    this.updateThreadPositions();
  }

  /* ============================================================
     关联丝束：一条「关系」不是一根 1px 直线，而是 4 根带弧度的能量纤维。
     与银河层「星系 → 星核突触束」用同一套视觉语言：沿线奔跑的亮带、
     宽幅呼吸、两端渐收、颜色从 A 端星系渐变到 B 端。
     端点从星系边缘出发（不穿中心变成蜘蛛网），整束随镜头和星系一起动。
     ============================================================ */
  private buildThread(a: string, b: string): ThreadRec {
    const geo = new BufferGeometry();
    geo.setAttribute('position',
      new BufferAttribute(new Float32Array(TH_VERTS * 3), 3).setUsage(DynamicDrawUsage));
    const au = new Float32Array(TH_VERTS);
    const ac = new Float32Array(TH_VERTS * 3);
    const ab = new Float32Array(TH_VERTS);
    const strands: ThreadStrand[] = [];
    // 每束整体弯向不同，免得所有关联都长成同一个弧
    const baseBow = (this.rnd() - 0.5) * 0.15;
    const mid = (TH_STRANDS - 1) / 2;
    for (let s = 0; s < TH_STRANDS; s++) {
      const spread = (s - mid) / Math.max(1, mid);
      const bright = (0.62 + this.rnd() * 0.38) * (1 - Math.abs(spread) * 0.22);
      strands.push({
        bow: baseBow + spread * 0.052,
        z: spread * 0.07 + (this.rnd() - 0.5) * 0.10,
        amp: 0.012 + this.rnd() * 0.022,
        fr: 0.5 + this.rnd() * 0.9,
        ph: this.rnd() * TAU,
        bright,
        ctrl: new Vector3()
      });
      for (let k = 0; k < TH_SEG; k++) {
        for (let v = 0; v < 2; v++) {
          const u = (k + v) / TH_SEG;
          const i = (s * TH_SEG + k) * 2 + v;
          au[i] = u;
          // 冷紫 → 冰蓝，中段泛白：和迷你星系同源，不再是均匀的灰线
          const col = TH_A.clone().lerp(TH_B, u).lerp(TH_WHITE, Math.sin(u * Math.PI) * 0.22);
          ac[i * 3] = col.r; ac[i * 3 + 1] = col.g; ac[i * 3 + 2] = col.b;
          ab[i] = bright;
        }
      }
    }
    geo.setAttribute('aU', new BufferAttribute(au, 1));
    geo.setAttribute('aCol', new BufferAttribute(ac, 3));
    geo.setAttribute('aB', new BufferAttribute(ab, 1));

    const mat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uGain: { value: 1 },
        uNorm: { value: 0.5 }, uHot: { value: 0 }, uDim: { value: 1 },
        uBase: { value: 0.55 + this.rnd() * 0.20 },
        uPh: { value: this.rnd() * TAU },
        // 顺流 / 逆流各半，避免整片光丝像检票闸机一样齐步走
        uSp: { value: (0.55 + this.rnd() * 0.7) * (this.rnd() < 0.5 ? 1 : -1) }
      },
      vertexShader: `
        attribute float aU; attribute vec3 aCol; attribute float aB;
        varying float vU; varying vec3 vC; varying float vB;
        void main(){
          vU = aU; vC = aCol; vB = aB;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime, uGain, uNorm, uHot, uDim, uBase, uPh, uSp;
        varying float vU; varying vec3 vC; varying float vB;
        void main(){
          // 主能量亮带：窄而亮，沿线奔跑
          float f1 = pow(max(0.0, 0.5 + 0.5 * sin(vU * 19.0 - uTime * uSp * 5.0 + uPh)), 6.0);
          // 宽幅呼吸：静止时也不是死的
          float f2 = 0.5 + 0.5 * sin(vU * 8.0 + uTime * 1.1 + uPh * 2.3);
          // 两端从星系里长出来，只收一点点：收太多会看起来没接上
          float edge = smoothstep(0.0, 0.08, vU) * (1.0 - smoothstep(0.92, 1.0, vU));
          float a = uBase * vB * (0.52 + 0.48 * f1) * (0.55 + 0.45 * f2) * edge;
          // Hebbian 权重、hover 高亮、站体压暗、切层淡入都在这里换算
          a *= (0.55 + 0.45 * uNorm) * (1.0 + uHot * 1.5) * uDim * uGain;
          vec3 col = mix(vC, vec3(1.0, 0.98, 0.93), f1 * 0.45 + uHot * 0.28);
          gl_FragColor = vec4(col, a);
        }`,
      transparent: true, blending: AdditiveBlending, depthWrite: false
    });
    const line = new LineSegments(geo, mat);
    line.frustumCulled = false;      // 几何每帧变，包围球不可靠

    const root = new Group();
    root.add(line);

    // 沿丝散布的星尘：小而锐利的点，带横向散开与逐点闪烁。
    // 有了它，关联读起来是「两团星系之间的物质桥」，而不是几何连线。
    const dp = new Float32Array(TH_DUST * 3);
    const dc = new Float32Array(TH_DUST * 3);
    const ds = new Float32Array(TH_DUST);
    const dph = new Float32Array(TH_DUST);
    const dustSeed: ThreadRec['dustSeed'] = [];
    for (let i = 0; i < TH_DUST; i++) {
      const u = (i + 0.5) / TH_DUST + (this.rnd() - 0.5) * 0.025;
      const col = TH_A.clone().lerp(TH_B, u).lerp(TH_WHITE, 0.20 + this.rnd() * 0.30);
      dc[i * 3] = col.r; dc[i * 3 + 1] = col.g; dc[i * 3 + 2] = col.b;
      ds[i] = 0.008 + Math.pow(this.rnd(), 2) * 0.020;
      dph[i] = this.rnd();
      dustSeed.push({ u, side: (this.rnd() - 0.5) * 2, z: (this.rnd() - 0.5) * 0.07 });
    }
    const dustGeo = new BufferGeometry();
    dustGeo.setAttribute('position', new BufferAttribute(dp, 3).setUsage(DynamicDrawUsage));
    dustGeo.setAttribute('col', new BufferAttribute(dc, 3));
    dustGeo.setAttribute('sz', new BufferAttribute(ds, 1));
    dustGeo.setAttribute('ph', new BufferAttribute(dph, 1));
    const dustMat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uPx: { value: this.lastPx }, uGain: { value: 1 },
        uDim: { value: 1 }, uNorm: { value: 0.5 }, uHot: { value: 0 }
      },
      vertexShader: `
        attribute float sz; attribute float ph; attribute vec3 col;
        uniform float uTime, uPx;
        varying vec3 vC; varying float vA;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vC = col;
          vA = 0.55 + 0.45 * sin(uTime * (0.7 + ph * 1.6) + ph * 30.0);
          gl_PointSize = max(1.0, sz * uPx / max(0.001, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uGain, uDim, uNorm, uHot;
        varying vec3 vC; varying float vA;
        void main(){
          float r = length(gl_PointCoord - vec2(0.5));
          if (r > 0.5) discard;
          gl_FragColor = vec4(mix(vC, vec3(1.0), uHot * 0.3),
            smoothstep(0.5, 0.05, r) * vA * (0.35 + uNorm * 0.55) * uDim * uGain);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending
    });
    const dust = new Points(dustGeo, dustMat);
    dust.frustumCulled = false;
    root.add(dust);

    // 每束两颗光点沿丝奔跑：像想法在两篇笔记之间流动
    const motes: ThreadRec['motes'] = [];
    for (let i = 0; i < 2; i++) {
      const spr = new Sprite(new SpriteMaterial({
        map: this.glowTex, color: new Color(i === 0 ? '#EDE7FF' : '#CFE6FF'),
        transparent: true, opacity: 0.8, depthWrite: false, blending: AdditiveBlending
      }));
      spr.scale.setScalar(0.075);
      root.add(spr);
      motes.push({ spr, si: i * 2, u: this.rnd(), v: 0.10 + this.rnd() * 0.12 });
    }
    this.threadGroup.add(root);
    return {
      root, line, geo, pos: geo.getAttribute('position') as BufferAttribute,
      mat, strands, motes,
      dustPos: dustGeo.getAttribute('position') as BufferAttribute,
      dustMat, dustGeo, dustSeed,
      a, b, norm: 0.5, hot: false, dim: false
    };
  }

  /** 增删关联、把 Hebbian 权重 / 高亮 / 压暗喂进 shader，再刷新整束几何 */
  private syncThreads(t: number, dt: number): void {
    const list = this.threadProvider?.() ?? [];
    const sig = list.map(x => `${x.a}~${x.b}`).join('|');
    if (sig !== this.threadSig) {
      this.threadSig = sig;
      const want = new Set(list.map(x => `${x.a}~${x.b}`));
      for (const [k, rec] of this.threadLines) {
        if (want.has(k)) continue;
        this.threadGroup.remove(rec.root);
        rec.geo.dispose();
        rec.mat.dispose();
        rec.dustGeo.dispose();
        rec.dustMat.dispose();
        for (const m of rec.motes) (m.spr.material as SpriteMaterial).dispose();
        this.threadLines.delete(k);
      }
      for (const x of list) {
        const k = `${x.a}~${x.b}`;
        if (!this.threadLines.has(k)) this.threadLines.set(k, this.buildThread(x.a, x.b));
      }
    }
    for (const x of list) {
      const rec = this.threadLines.get(`${x.a}~${x.b}`);
      if (!rec) continue;
      rec.norm = x.norm;
      rec.hot = x.hot;
      rec.dim = x.dim;
      const u = rec.mat.uniforms;
      u['uTime']!.value = t;
      u['uGain']!.value = this.gain;
      u['uNorm']!.value = x.norm;
      u['uHot']!.value = x.hot ? 1 : 0;
      u['uDim']!.value = x.dim ? 0.22 : 1;
      const du = rec.dustMat.uniforms;
      du['uTime']!.value = t;
      du['uGain']!.value = this.gain;
      du['uNorm']!.value = x.norm;
      du['uHot']!.value = x.hot ? 1 : 0;
      du['uDim']!.value = x.dim ? 0.22 : 1;
    }
    this.updateThreadGeometry(t, dt);
  }

  private thP0 = new Vector3();
  private thP1 = new Vector3();
  private thDir = new Vector3();
  private thPerp = new Vector3();
  private thC = new Vector3();
  private thCur = new Vector3();
  private thPrev = new Vector3();
  private thMote = new Vector3();

  /** 每帧重铺：控制点带波动，丝是活的；光点沿丝奔跑 */
  private updateThreadGeometry(t: number, dt: number): void {
    const map = this.minis.get('study');
    if (!map || this.threadLines.size === 0) return;
    for (const rec of this.threadLines.values()) {
      const A = map.get(rec.a);
      const B = map.get(rec.b);
      if (!A || !B) continue;
      const dir = this.thDir.copy(B.position).sub(A.position);
      const len = dir.length() || 1;
      const nx = dir.x / len, ny = dir.y / len, nz = dir.z / len;
      // 端点收进星系边缘：不让所有关系都从中心射出来变成蜘蛛网
      const inset = Math.min(0.12, len * 0.10);
      this.thP0.set(A.position.x + nx * inset, A.position.y + ny * inset, A.position.z + nz * inset);
      this.thP1.set(B.position.x - nx * inset, B.position.y - ny * inset, B.position.z - nz * inset);
      const perp = this.thPerp.set(-ny, nx, 0);
      if (perp.lengthSq() < 1e-6) perp.set(0, 1, 0);
      perp.normalize();
      const chord = this.thP1.distanceTo(this.thP0);

      for (let s = 0; s < rec.strands.length; s++) {
        const d = rec.strands[s]!;
        const wob = Math.sin(t * d.fr + d.ph) * d.amp;
        const c = this.thC.copy(this.thP0).add(this.thP1).multiplyScalar(0.5)
          .addScaledVector(perp, (d.bow + wob) * chord);
        c.z += d.z * chord * 0.5 + Math.sin(t * d.fr * 0.7 + d.ph) * 0.025;
        d.ctrl.copy(c);
        this.thPrev.copy(this.thP0);
        for (let k = 1; k <= TH_SEG; k++) {
          ModuleNebulae.qbez(this.thP0, c, this.thP1, k / TH_SEG, this.thCur);
          const o = (s * TH_SEG + k - 1) * 2;
          rec.pos.setXYZ(o, this.thPrev.x, this.thPrev.y, this.thPrev.z);
          rec.pos.setXYZ(o + 1, this.thCur.x, this.thCur.y, this.thCur.z);
          this.thPrev.copy(this.thCur);
        }
      }
      rec.pos.needsUpdate = true;

      // 星尘沿各条丝铺开：横向散一点、深度错一点，形成有厚度的桥
      for (let i = 0; i < rec.dustSeed.length; i++) {
        const sd = rec.dustSeed[i]!;
        const d = rec.strands[i % rec.strands.length]!;
        ModuleNebulae.qbez(this.thP0, d.ctrl, this.thP1, sd.u, this.thMote);
        this.thMote.addScaledVector(perp, sd.side * 0.045 * chord);
        this.thMote.z += sd.z * chord * 0.5;
        rec.dustPos.setXYZ(i, this.thMote.x, this.thMote.y, this.thMote.z);
      }
      rec.dustPos.needsUpdate = true;

      for (const m of rec.motes) {
        m.u += m.v * (0.65 + rec.norm * 0.9) * (rec.hot ? 1.7 : 1) * dt;
        if (m.u >= 1) {
          m.u -= 1;
          m.si = (m.si + 1) % rec.strands.length;
        }
        const d = rec.strands[m.si]!;
        ModuleNebulae.qbez(this.thP0, d.ctrl, this.thP1, m.u, this.thMote);
        m.spr.position.copy(this.thMote);
        (m.spr.material as SpriteMaterial).opacity =
          (0.35 + rec.norm * 0.60) * Math.sin(m.u * Math.PI)
          * (rec.dim ? 0.25 : 1) * this.gain;
      }
    }
  }

  /** 端点重铺：几何每帧都会算，这里只是让 resize / 新建星系后立刻对齐一次 */
  private updateThreadPositions(): void {
    this.updateThreadGeometry(this.lastT, 0);
  }

  /** 单丝几何更新：控制点带屏幕内 + 深度双向波动（线是活的），12 段折线 */
  private tmpA = new Vector3();
  private tmpB = new Vector3();
  private tmpC = new Vector3();
  /** t 时刻的控制点：屏幕内垂直弦的摆动 + 朝镜头方向的鼓 / 收 */
  private strandCtrl(d: StrandDef, t: number, out: Vector3): Vector3 {
    const dir = this.tmpA.copy(d.p1).sub(d.p0);
    const perp = this.tmpB.set(-dir.y, dir.x, 0);
    if (perp.lengthSq() < 1e-6) perp.set(0, 1, 0);
    perp.normalize().multiplyScalar(Math.sin(t * d.fr + d.ph) * d.amp);
    out.copy(d.c).add(perp);
    out.z += Math.sin(t * d.fr2 + d.ph2) * d.zAmp;
    return out;
  }
  private updateStrand(rec: { line: LineSegments; def: StrandDef; geo: BufferGeometry }, t: number): void {
    const d = rec.def;
    const attr = rec.geo.getAttribute('position') as BufferAttribute;
    // 全程用临时向量：这里每帧跑 32 条丝，任何 clone 都是稳定的 GC 压力
    const cur = this.tmpCur;
    const prev = this.tmpPrev;
    const c = this.strandCtrl(d, t, this.tmpC);
    prev.copy(d.p0);
    for (let k = 1; k <= 12; k++) {
      const u = k / 12;
      ModuleNebulae.qbez(d.p0, c, d.p1, u, cur);
      const o = (k - 1) * 2;
      attr.setXYZ(o, prev.x, prev.y, prev.z);
      attr.setXYZ(o + 1, cur.x, cur.y, cur.z);
      prev.copy(cur);
    }
    attr.needsUpdate = true;
  }
  private tmpCur = new Vector3();
  private tmpPrev = new Vector3();

  setTime(t: number): void {
    const dt = Math.max(0, Math.min(0.1, t - this.lastT));
    this.lastT = t;
    this.mat.uniforms['uTime']!.value = t;
    this.miniMat.uniforms['uTime']!.value = t;
    // 组透明度向目标缓动（切层淡入）
    this.gain += (this.gainTarget - this.gain) * Math.min(1, dt * 4);
    this.mat.uniforms['uGain']!.value = this.gain;
    this.miniMat.uniforms['uGain']!.value = this.gain;
    for (const s of this.spins) s.holder.rotateOnAxis(s.ax, s.sp * dt);
    // 丝的波动（只更新可见层）
    if (this.scene === 'galaxy') {
      for (const rec of this.strandLines) this.updateStrand(rec, t);
      // 光脉冲沿丝奔跑（索引循环：indexOf 每帧 O(n) 纯浪费）
      for (let pi = 0; pi < this.pulses.length; pi++) {
        const p = this.pulses[pi]!;
        p.u += p.v * dt;
        if (p.u >= 1) {
          p.u = 0;
          p.si = (p.si + 1 + Math.floor(Math.random() * 3)) % STRANDS_PER_MODULE;
        }
        const idx = pi % CLOUDS.length;
        const rec = this.strandLines[idx * STRANDS_PER_MODULE + p.si];
        if (!rec) continue;
        const c = this.strandCtrl(rec.def, t, this.tmpC);
        ModuleNebulae.qbez(rec.def.p0, c, rec.def.p1, p.u, p.spr.position);
      }
    } else if (this.scene === 'study') {
      this.syncThreads(t, dt);
    }
  }

  setGain(v: number): void {
    this.gainTarget = v;
  }

  /** 门户云团的世界坐标：运镜推近要用（没有对应团的 id 返回 null） */
  worldPos(id: string): Vector3 | null {
    const h = this.holders.get(id);
    return h ? h.position.clone() : null;
  }

  /** 当前场景下所有可见云团的世界坐标：供每帧投影回屏幕、钉住 DOM 实体 */
  forEachVisible(fn: (id: string, pos: Vector3) => void): void {
    if (this.scene === 'galaxy') {
      for (const [id, h] of this.holders) fn(id, h.position);
    } else {
      const map = this.minis.get(this.scene);
      if (map) for (const [id, h] of map) fn(id, h.position);
    }
  }

  get currentAspect(): number { return this.aspect; }
}
