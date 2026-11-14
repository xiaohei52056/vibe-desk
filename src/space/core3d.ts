/**
 * 真 3D 空间层（P5.6 的一部分，先做背景）
 *
 * 定位：只画「星核 + 星环」，不承载任何信息。
 * 实体、站体、HUD 全部留在上层 2D 世界里，坐标契约 C1 不受影响。
 *
 * 混合档位固定在「折中」：环用常规混合（安静），只有星核用叠加（有存在感）。
 * 这一档是实验台里三种方案的中间解，理由记在路线图 D11。
 *
 * 三条硬约束：
 *   1. 这个模块必须被动态 import —— three 有 123 KB gzip，不能进首屏；
 *   2. 站体打开（ViewportLock）时停转并压暗，背景零运动；
 *   3. 3D 是唯一的渲染路径：没有拍平态、没有 2D 星图回退，整层常驻。
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Vector3, Color,
  BufferGeometry, BufferAttribute, Float32BufferAttribute, CanvasTexture,
  LineSegments, LineLoop, LineBasicMaterial, Points, Mesh, MeshBasicMaterial,
  ShaderMaterial, NormalBlending, AdditiveBlending, Fog, DoubleSide,
  SRGBColorSpace, Sprite, SpriteMaterial
} from 'three';

import type { SceneName } from '../core/state';
import { makeRibbonBall, type RibbonBall } from './ribbon';
import { ModuleNebulae, type ThreadRender } from './nebulae';
import { Decor } from './decor';

const TAU = Math.PI * 2;

/**
 * ViewportLock 下整层的透明度。视觉基因里定死的数字：
 * 亮到 0.7 以上会跟站体抢，暗到 0.45 以下 3D 背景就「死」了。
 * 用户裁定：详情页背景要仍然是 3D 空间 —— 从 0.34（压暗冻结）提到 0.55（慢速漂移）。
 */
const LOCK_DIM = 0.55;

/** 每层星系的姿态 */
interface Preset { scale: number; dy: number; ring: number; core: number; coreScale: number; }

const PRESET: Record<SceneName, Preset> = {
  // 银河层：星核就在眼前，环完整（coreScale 放大后丝带球占画面 ~80% 高，对齐参考图）
  galaxy: { scale: 0.88, dy: 0.10, ring: 0.85, core: 1.00, coreScale: 0.78 },
  // 学习星系：只留迷你星系与光丝。轨道环 / 刻度弧 / 文字带全部退场（ring=0）——
  // 用户裁定：模块详情视角里的线条环是噪音，背景交给星云与星空
  study: { scale: 0.46, dy: 0, ring: 0.00, core: 0.00, coreScale: 0.95 },
  // 项目星系：同上，暖一点
  code: { scale: 0.50, dy: 0, ring: 0.00, core: 0.00, coreScale: 1.00 }
};

export class Core3D {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly world = new Group();
  private readonly spin = new Group();
  private readonly core = new Group();
  private readonly dust: Points;
  private readonly starMat: ShaderMaterial;
  private readonly stars: Points;

  private readonly ringMats: { mat: LineBasicMaterial; base: number; kind: 'ice' | 'gold' | 'dim' }[] = [];
  private readonly meshMats: { mat: MeshBasicMaterial; base: number }[] = [];
  private readonly glowMat: SpriteMaterial;
  private readonly edgeMat: ShaderMaterial;
  private readonly ptMat: ShaderMaterial;
  private readonly dustMat: ShaderMaterial;
  private readonly ribbons: RibbonBall;
  private readonly orbitDots: { dot: Sprite; r: number; sp: number; phase: number }[] = [];
  private readonly modules: ModuleNebulae;
  private readonly hotGlow: SpriteMaterial;
  /** 中景实体：碎石带 / 周期掠过的彗星 + 远景星团与脉冲星 */
  private readonly decor: Decor;

  private readonly camDist = 7.6;
  private raf = 0;
  private clock = 0;
  private last = 0;
  private locked = false;
  private reduced = false;
  /** 当前渲染像素比（自适应降档只会往下走） */
  private dpr: number;
  /** 连续慢帧计数：>120（约 2 秒）触发降档 */
  private slowFrames = 0;

  // ---- 相机交互：拖拽 orbit + 滚轮推拉 + 运镜飞行 + 注视点平滑 ----
  private yaw = 0;
  private pitchOff = 0;
  private yawV = 0;
  private pitchV = 0;
  private dragging = false;
  /** 用户滚轮推拉量：平滑逼近目标 */
  private zoomK = 0;
  private zoomGoal = 0;
  /** 拖拽侧倾（banking）：快速横扫时镜头轻微滚转，强化 3D 空间感 */
  private rollGoal = 0;
  private rollCur = 0;
  /**
   * 运镜飞行：位置与注视点同时插值。
   * flyTo 的视线方向恒定（from/to 的 look 沿同一方向平移）——
   * 目标星系在屏幕上的位置纹丝不动，只是被逐渐放大，然后进入详情页。
   */
  private fly: {
    t: number; dur: number;
    fromPos: Vector3; toPos: Vector3;
    fromLook: Vector3; toLook: Vector3;
    /** true = 缓出（开场俯冲 / 后撤用）：先快后慢，落位更稳 */
    eo?: boolean;
    cb?: () => void;
  } | null = null;
  private readonly lookGoal = new Vector3();
  private readonly lookCur = new Vector3();
  private static readonly ORIGIN = new Vector3();

  constructor(private readonly host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    // 上限 1.5：丝带是多层加色叠加，retina 全速渲染容易把低端核显推过降级线；
    // 背景层糊一点没人凑近看，换来的是余量（参考项目同样封 1.75）
    this.dpr = Math.min(devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(36, 1, 0.1, 80);
    this.scene.fog = new Fog(0x101720, 7.0, 15.0);
    this.placeCamera();

    this.world.add(this.spin, this.core);
    this.scene.add(this.world);
    this.world.rotation.x = -0.05;

    // ---- 星核：球状神经网 ----
    const NODE_N = 300;
    const nodes: Vector3[] = [];
    let seed = 20261111;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < NODE_N; i++) {
      const y = 1 - (i / (NODE_N - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * 2.399963229728653;
      const r = 1.12 + (rnd() - 0.5) * 0.10;
      nodes.push(new Vector3(Math.cos(th) * rad * r, y * r, Math.sin(th) * rad * r));
    }

    const seen = new Set<string>();
    const ePos: number[] = [];
    const ePh: number[] = [];
    for (let i = 0; i < NODE_N; i++) {
      const a = nodes[i]!;
      const near = nodes
        .map((b, j) => ({ j, d: a.distanceToSquared(b) }))
        .filter(o => o.j !== i)
        .sort((x, y) => x.d - y.d)
        .slice(0, 3);
      for (const { j } of near) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const b = nodes[j]!;
        ePos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        // 相位必须是真随机。曾经写成 (a.length()+b.length()) % 1 —— 节点半径
        // 都在 1.12 附近，所有边拿到几乎同一个相位，整层线网就「同呼吸」：
        // 7.4s 一个周期从暗转到亮，亮相位时整颗核喧宾夺主（P5.6 收口修掉）。
        const ph = rnd();
        ePh.push(ph, ph);
      }
    }
    // 不放「从中心发散的辐条」：投影后它们像几道划痕，读起来是瑕疵不是结构。
    // 核的重量交给内层密点与柔光，线条只负责球壳。

    const edgeGeo = new BufferGeometry();
    edgeGeo.setAttribute('position', new Float32BufferAttribute(ePos, 3));
    edgeGeo.setAttribute('ph', new Float32BufferAttribute(ePh, 1));

    this.edgeMat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uGain: { value: 1 },
        uA: { value: new Color('#6F82A4') }, uB: { value: new Color('#EDE7DA') }
      },
      vertexShader: `
        attribute float ph;
        uniform float uTime; uniform float uGain; uniform vec3 uA; uniform vec3 uB;
        varying float vA; varying vec3 vC;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float w  = 0.5 + 0.5 * sin(uTime * 0.85 - ph * 9.4);
          float w2 = 0.5 + 0.5 * sin(uTime * 0.31 + ph * 3.1);
          // 背面衰减：少了这一步，球背面的连线会穿过正面变一团乱麻
          vec3 nrm = normalize(normalMatrix * normalize(position));
          float facing = clamp(dot(nrm, normalize(-mv.xyz)), 0.0, 1.0);
          float depth = clamp((-mv.z - 6.2) / 6.5, 0.0, 1.0);
          vA = (0.10 + 0.15 * w * w) * (0.60 + 0.40 * w2) * uGain
             * (1.0 - depth * 0.5) * (0.30 + 0.70 * facing);
          // 颜色同样压向钢蓝：uB 只留给少数正在闪的线。
          // 全员偏白是「同呼吸」的另一个后遗症，一起修在这里。
          vC = mix(uA, uB, w * 0.35 + facing * 0.25);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA; varying vec3 vC;
        void main(){ gl_FragColor = vec4(vC, vA); }`,
      transparent: true, depthWrite: false, blending: NormalBlending
    });
    this.core.add(new LineSegments(edgeGeo, this.edgeMat));

    // ---- 节点 ----
    const pPos: number[] = [];
    const pPh: number[] = [];
    const pSz: number[] = [];
    const pInner: number[] = [];
    for (const n of nodes) {
      pPos.push(n.x, n.y, n.z);
      pPh.push(rnd());
      pSz.push(1.4 + rnd() * 1.8);
      pInner.push(0);
    }
    for (let i = 0; i < 96; i++) {
      const v = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
      if (v.length() > 1) { i--; continue; }
      v.multiplyScalar(0.40);
      pPos.push(v.x, v.y, v.z);
      pPh.push(rnd());
      pSz.push(2.2 + rnd() * 2.0);
      pInner.push(1);
    }
    const ptGeo = new BufferGeometry();
    ptGeo.setAttribute('position', new Float32BufferAttribute(pPos, 3));
    ptGeo.setAttribute('ph', new Float32BufferAttribute(pPh, 1));
    ptGeo.setAttribute('sz', new Float32BufferAttribute(pSz, 1));
    ptGeo.setAttribute('inner', new Float32BufferAttribute(pInner, 1));

    this.ptMat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uPx: { value: 800 }, uGain: { value: 1 },
        uA: { value: new Color('#A9BCDD') }, uB: { value: new Color('#F3EFE6') }
      },
      vertexShader: `
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
          // 尺寸必须按世界单位算，否则一乘 uPx 就糊成一团白
          gl_PointSize = max(1.0, sz * 0.0048 * uPx / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA; varying vec3 vC;
        void main(){
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d);
          if (r > 0.5) discard;
          gl_FragColor = vec4(vC, smoothstep(0.5, 0.12, r) * vA);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending
    });
    this.core.add(new Points(ptGeo, this.ptMat));

    // ---- 核的柔光：常规混合下是「雾团」，不是「灯」 ----
    this.glowMat = (() => {
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
        map: tex, transparent: true, opacity: 0.60,
        depthWrite: false, blending: AdditiveBlending
      });
      const sp = new Sprite(m);
      sp.scale.setScalar(2.35);
      this.core.add(sp);
      return m;
    })();

    // ---- 丝带星核：参考「星核蜘蛛」移植，16 条，占银河层的视觉主体 ----
    this.ribbons = makeRibbonBall({ R: 1.30, n: 16, w0: 0.44, seg: 180, amp: 0.05, alpha: 0.85, rnd });
    this.core.add(this.ribbons.group);

    // ---- 热核：参考图球心那团暖白光，让核「烧」起来而不是「悬」着 ----
    this.hotGlow = (() => {
      const S = 256;
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const c = cv.getContext('2d')!;
      const gd = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      gd.addColorStop(0.00, 'rgba(255,244,224,0.95)');
      gd.addColorStop(0.30, 'rgba(255,214,166,0.42)');
      gd.addColorStop(0.65, 'rgba(214,190,170,0.12)');
      gd.addColorStop(1.00, 'rgba(16,23,32,0)');
      c.fillStyle = gd;
      c.fillRect(0, 0, S, S);
      const tex = new CanvasTexture(cv);
      tex.colorSpace = SRGBColorSpace;
      const m = new SpriteMaterial({
        map: tex, transparent: true, opacity: 0.75,
        depthWrite: false, blending: AdditiveBlending
      });
      const sp = new Sprite(m);
      sp.scale.setScalar(1.75);
      this.core.add(sp);
      return m;
    })();

    // ---- 星环 ----
    const ring = (op: number, kind: 'ice' | 'gold' | 'dim'): LineBasicMaterial => {
      const base = kind === 'gold' ? new Color('#D2AA70')
        : kind === 'dim' ? new Color('#63738F') : new Color('#8FA4C6');
      const m = new LineBasicMaterial({
        color: base, transparent: true, opacity: op,
        blending: NormalBlending, depthWrite: false
      });
      this.ringMats.push({ mat: m, base: op, kind });
      return m;
    };
    // 环全部躺在 XZ 地面平面（参考 buildNebulae 的轨道 / buildCore 的 ringsG）：
    // 参数名 z 语义改为「离盘面的高度」
    const loop = (r: number, z: number, seg: number, mat: LineBasicMaterial): void => {
      const a = new Float32Array(seg * 3);
      for (let i = 0; i < seg; i++) {
        const t = (i / seg) * TAU;
        a[i * 3] = Math.cos(t) * r;
        a[i * 3 + 1] = z;
        a[i * 3 + 2] = Math.sin(t) * r;
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(a, 3));
      this.spin.add(new LineLoop(g, mat));
    };
    const seg = (a: number[], mat: LineBasicMaterial): void => {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(a, 3));
      this.spin.add(new LineSegments(g, mat));
    };
    const ticks = (r: number, n: number, len: number, every: number, long: number, z: number, mat: LineBasicMaterial): void => {
      const a: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = (i / n) * TAU;
        const l = i % every === 0 ? long : len;
        a.push(Math.cos(t) * r, z, Math.sin(t) * r, Math.cos(t) * (r + l), z, Math.sin(t) * (r + l));
      }
      seg(a, mat);
    };
    const arcs = (r: number, list: readonly (readonly [number, number])[], z: number, mat: LineBasicMaterial): void => {
      const a: number[] = [];
      for (const [t0, t1] of list) {
        const n = Math.max(4, Math.round((t1 - t0) / 0.02));
        for (let i = 0; i < n; i++) {
          const u0 = t0 + ((t1 - t0) * i) / n;
          const u1 = t0 + ((t1 - t0) * (i + 1)) / n;
          a.push(Math.cos(u0) * r, z, Math.sin(u0) * r, Math.cos(u1) * r, z, Math.sin(u1) * r);
        }
      }
      seg(a, mat);
    };

    loop(1.66, 0, 240, ring(0.34, 'gold'));
    ticks(1.80, 180, 0.012, 12, 0.03, 0.02, ring(0.30, 'ice'));

    // 圆柱框：上下双圆 + 72 条母线。这是「环有厚度」的全部来源
    const R = 2.02;
    loop(R, 0.085, 256, ring(0.46, 'ice'));
    loop(R, -0.085, 256, ring(0.34, 'ice'));
    {
      const a: number[] = [];
      for (let i = 0; i < 72; i++) {
        const t = (i / 72) * TAU;
        a.push(Math.cos(t) * R, 0.085, Math.sin(t) * R, Math.cos(t) * R, -0.085, Math.sin(t) * R);
      }
      seg(a, ring(0.13, 'dim'));
    }

    // 文字带：canvas 纹理贴到极坐标环上
    {
      const W = 4096;
      const H = 64;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c = cv.getContext('2d')!;
      c.font = '500 26px "PingFang SC","Microsoft YaHei",sans-serif';
      c.fillStyle = 'rgba(201,160,99,.85)';
      c.textBaseline = 'middle';
      const words = ['学习星系', '项目星系', '坐标冻结', '光学景深', '光丝权重', '该回看', '决策日志'];
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
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      const SEG = 384;
      for (let i = 0; i <= SEG; i++) {
        const t = (i / SEG) * TAU;
        const u = 1 - i / SEG;
        pos.push(Math.cos(t) * 2.06, 0, Math.sin(t) * 2.06, Math.cos(t) * 2.16, 0, Math.sin(t) * 2.16);
        uv.push(u, 0, u, 1);
      }
      for (let i = 0; i < SEG; i++) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      const m = new MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.55, depthWrite: false,
        blending: NormalBlending, side: DoubleSide
      });
      this.meshMats.push({ mat: m, base: 0.72 });
      const mesh = new Mesh(g, m);
      mesh.position.y = 0.03;
      // 文字带立起来斜对相机（参考 buildCore 交叉环的姿态）：既是 3D 环，字又读得清；
      // 挂 world 不挂 spin —— 不随盘公转，避免周期性侧棱对屏变一条线
      // 文字带立起来斜对相机：倾角压到 0.9 —— 太立（1.15）会在近侧棱处把字
      // 挤压成一块涂抹斑（截图中核球上的橙斑就是它）；0.9 时顶部仍斜、字不糊
      mesh.rotation.x = 0.9;
      // 文字带压在丝带前面：参考图里表盘环永远读得清，不能被丝带缠进去
      mesh.renderOrder = 10;
      this.world.add(mesh);
    }

    arcs(2.34, [[0.10, 0.86], [1.26, 1.52], [2.18, 3.36], [3.86, 4.18], [4.62, 5.78]], -0.05, ring(0.40, 'gold'));
    arcs(2.44, [[0.52, 0.64], [1.02, 2.06], [2.72, 2.84], [3.24, 4.42], [5.12, 5.34]], -0.07, ring(0.24, 'ice'));
    ticks(2.62, 260, 0.014, 10, 0.034, -0.10, ring(0.36, 'ice'));
    arcs(2.92, [[0.2, 1.1], [1.6, 1.8], [2.6, 3.9], [4.4, 4.7], [5.2, 6.1]], -0.17, ring(0.20, 'dim'));

    // ---- 通用光点贴图（轨道跑点 / 星云核心共用）----
    const glowTex = (() => {
      const S = 64;
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const c = cv.getContext('2d')!;
      const gd = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      gd.addColorStop(0.00, 'rgba(255,255,255,1)');
      gd.addColorStop(0.25, 'rgba(255,255,255,0.70)');
      gd.addColorStop(1.00, 'rgba(255,255,255,0)');
      c.fillStyle = gd;
      c.fillRect(0, 0, S, S);
      const t = new CanvasTexture(cv);
      t.colorSpace = SRGBColorSpace;
      return t;
    })();

    // ---- 轨道椭圆 + 跑点：环外三圈，各带一颗沿线跑的光点（参考 buildCore 的 ringsG）----
    {
      // [半径, 绕 X 倾角, 绕 Y 倾角, 跑点角速度] —— 倾角照抄参考
      // 半径按参考比例（核 R1.30 → 环 8.0/9.4/10.6 ÷ 6.1 ≈ 1.7/2.0/2.3），倾角照抄 buildCore
      const defs: readonly (readonly [number, number, number, number])[] = [
        [1.78, 0.35, 0.10, 0.30],
        [2.06, -0.28, -0.18, -0.21],
        [2.32, 0.16, 0.26, 0.15]
      ];
      defs.forEach(([r, rx, rz, spd], i) => {
        const holder = new Group();
        holder.rotation.set(rx, 0, rz);
        this.spin.add(holder);
        const a = new Float32Array(160 * 3);
        for (let k = 0; k < 160; k++) {
          const t = (k / 160) * TAU;
          a[k * 3] = Math.cos(t) * r;
          a[k * 3 + 1] = 0;
          a[k * 3 + 2] = Math.sin(t) * r;
        }
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(a, 3));
        holder.add(new LineLoop(g, ring(0.18, i === 1 ? 'gold' : 'ice')));
        const dot = new Sprite(new SpriteMaterial({
          map: glowTex, color: i === 1 ? 0xF2D9A8 : 0xCFE4FF,
          transparent: true, opacity: 0.85, depthWrite: false, blending: AdditiveBlending
        }));
        dot.scale.setScalar(0.17);
        holder.add(dot);
        this.orbitDots.push({ dot, r, sp: spd, phase: i * 2.1 });
      });
      // 公转大椭圆：参考 ORBITS 的 ax/az 比例（~1.75:1），躺在地面附近横贯全屏
      const sweeps: readonly (readonly [number, number, number, number, number, 'ice' | 'dim' | 'gold'])[] = [
        [3.60, 2.05, 0.05, -0.04, 0.15, 'gold'],
        [4.50, 2.55, -0.04, 0.07, 0.11, 'ice'],
        [5.40, 3.05, 0.02, -0.09, 0.08, 'dim']
      ];
      sweeps.forEach(([ax, az, rx, rz, op, kind]) => {
        const holder = new Group();
        holder.rotation.set(rx, 0, rz);
        this.spin.add(holder);
        const a = new Float32Array(220 * 3);
        for (let k = 0; k < 220; k++) {
          const t = (k / 220) * TAU;
          a[k * 3] = Math.cos(t) * ax;
          a[k * 3 + 1] = 0;
          a[k * 3 + 2] = Math.sin(t) * az;
        }
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(a, 3));
        holder.add(new LineLoop(g, ring(op, kind)));
      });
    }

    // ---- 模块星云团：四个门户实体各自就是一团彩色星云（参考项目 CL[] 的语义）----
    // 挂在场景（世界空间）而不是相机：默认机位下按冻结坐标精确投影到那颗恒星上，
    // 拖拽 orbit 时整个空间一起产生视差位移；推近某个星系时它会原地放大。
    this.modules = new ModuleNebulae(glowTex, rnd, this.camDist, 0.2625);
    this.scene.add(this.modules.group);

    // ---- 中景实体：碎石带 / 彗星 / 远景星团 / 脉冲星 ----
    // near 挂 world（跟着星核一起缩放、倾斜）；far 挂 scene（远景不随近景转，视差才真）
    this.decor = new Decor(glowTex, rnd);
    this.world.add(this.decor.near);
    this.scene.add(this.decor.far);

    // ---- 尘埃 + 彩色远星（参考图里散布的金 / 红 / 青 / 蓝 / 白星点）----
    {
      const grey = 620;
      const colorful = 320;
      const n = grey + colorful;
      const pos = new Float32Array(n * 3);
      const sz = new Float32Array(n);
      const col = new Float32Array(n * 3);
      const kind = new Float32Array(n);
      for (let i = 0; i < grey; i++) {
        const u = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
        const r = 5 + rnd() * 13;
        pos.set([u.x * r, u.y * r * 0.55, u.z * r], i * 3);
        sz[i] = 0.6 + rnd() * 1.6;
        col.set([0.78, 0.82, 0.92], i * 3);
      }
      const palette = ['#FFD27A', '#FF8A7A', '#7FE8FF', '#7FA8FF', '#F3EFE6'];
      for (let i = grey; i < n; i++) {
        const u = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
        const r = 6 + rnd() * 14;
        pos.set([u.x * r, u.y * r * 0.6, u.z * r], i * 3);
        // 大光斑是散景点缀：份额和尺寸都压低，多了会把整屏垫成雾
        sz[i] = rnd() < 0.05 ? 2.6 + rnd() * 1.8 : 1.3 + rnd() * 1.5;
        const c = new Color(palette[Math.floor(rnd() * palette.length)]!);
        col.set([c.r, c.g, c.b], i * 3);
        kind[i] = 1;
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('sz', new BufferAttribute(sz, 1));
      g.setAttribute('col', new BufferAttribute(col, 3));
      g.setAttribute('kind', new BufferAttribute(kind, 1));
      this.dustMat = new ShaderMaterial({
        uniforms: { uPx: { value: 800 }, uGain: { value: 1 }, uColor: { value: 1 } },
        vertexShader: `
          attribute float sz; attribute vec3 col; attribute float kind;
          uniform float uPx; uniform float uGain; uniform float uColor;
          varying float vA; varying vec3 vC;
          void main(){
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vA = 0.12 * uGain * mix(1.0, uColor * 2.6, kind); vC = col;
            gl_PointSize = max(0.8, sz * 0.0045 * uPx / -mv.z);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          varying float vA; varying vec3 vC;
          void main(){
            float r = length(gl_PointCoord - vec2(0.5));
            if (r > 0.5) discard;
            gl_FragColor = vec4(vC, smoothstep(0.5, 0.1, r) * vA);
          }`,
        transparent: true, depthWrite: false, blending: NormalBlending
      });
      this.dust = new Points(g, this.dustMat);
      this.scene.add(this.dust);
    }

    // ---- 星云 / 星空背景：纯 TS 程序化生成（无贴图资源）。
    //      克制原则：云絮是点缀不是主菜 —— 少、小、散，大片留黑天；
    //      星空是主角 —— 锐利的小光点，绝不让云把画面糊满 ----
    {
      // 絮状云纹理：斑块向中心收拢，做出一朵有边界的云，而不是铺满画布的雾
      const puffTex = (colA: string, colB: string): CanvasTexture => {
        const S = 320;
        const cv = document.createElement('canvas');
        cv.width = S; cv.height = S;
        const c = cv.getContext('2d')!;
        for (let i = 0; i < 26; i++) {
          const a = rnd() * TAU;
          const rr = Math.pow(rnd(), 0.8) * S * 0.30;
          const x = S / 2 + Math.cos(a) * rr;
          const y = S / 2 + Math.sin(a) * rr * 0.66;
          const r = 22 + rnd() * 44;
          const g2 = c.createRadialGradient(x, y, 0, x, y, r);
          g2.addColorStop(0, rnd() < 0.5 ? colA : colB);
          g2.addColorStop(1, 'rgba(0,0,0,0)');
          c.fillStyle = g2;
          c.fillRect(0, 0, S, S);
        }
        const t = new CanvasTexture(cv);
        t.colorSpace = SRGBColorSpace;
        return t;
      };
      const nebTex = [
        puffTex('rgba(164,134,232,0.17)', 'rgba(98,76,182,0.12)'),   // 星系紫
        puffTex('rgba(108,152,230,0.16)', 'rgba(58,102,194,0.11)'),  // 深空蓝
        puffTex('rgba(220,170,108,0.14)', 'rgba(172,120,68,0.10)'),  // 暖金
        puffTex('rgba(100,198,208,0.14)', 'rgba(62,144,154,0.10)')   // 青
      ];
      // 云絮分三层深度：近(11-14) / 中(17-21) / 远(24-28)。
      // 拖拽 orbit 与推镜时近云快速掠过、远云几乎不动 —— 背景的纵深来自
      // 视差层次，不是靠一团超远景的雾
      const bands = [
        { rMin: 11, rMax: 14, sMin: 4.5, sMax: 6.5, op: 0.30 },
        { rMin: 17, rMax: 21, sMin: 7.0, sMax: 10, op: 0.38 },
        { rMin: 24, rMax: 28, sMin: 10, sMax: 15, op: 0.44 }
      ] as const;
      for (let i = 0; i < 12; i++) {
        const band = bands[i % 3]!;
        const lat = Math.asin((rnd() * 2 - 1) * 0.72);
        const lon = i * 2.399963229728653 + rnd() * 0.9;
        const dir = new Vector3(
          Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)
        );
        const spr = new Sprite(new SpriteMaterial({
          map: nebTex[i % 4]!,
          transparent: true,
          opacity: band.op * (0.75 + rnd() * 0.5),
          depthWrite: false,
          blending: AdditiveBlending,
          fog: false               // 雾会把 15 以外的东西全吃掉，云絮必须绕开雾
        }));
        spr.position.copy(dir).multiplyScalar(band.rMin + rnd() * (band.rMax - band.rMin));
        spr.scale.setScalar(band.sMin + rnd() * (band.sMax - band.sMin));
        this.scene.add(spr);
      }

      // 远景恒星：由远及近的星空。半径幂分布（越近采到越多），
      // 尺寸按距离补偿 —— 屏幕上星点大小前后一致（≈2-3px），
      // 近星更亮更实（与星系同一档清晰度），拖拽时近星快速掠过出彩
      const n = 900;
      const pos = new Float32Array(n * 3);
      const sz = new Float32Array(n);
      const col = new Float32Array(n * 3);
      const tw = new Float32Array(n);
      const starPal = ['#F3EFE6', '#CFE4FF', '#FFD9A0', '#FFB4A2', '#B9A8FF'];
      for (let i = 0; i < n; i++) {
        const dir = new Vector3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.6, rnd() * 2 - 1).normalize();
        const r = 6 + Math.pow(rnd(), 1.6) * 24;          // 6..30，近段更密
        pos.set([dir.x * r, dir.y * r, dir.z * r], i * 3);
        const big = rnd() < 0.08;
        sz[i] = r * (0.5 + rnd() * 0.3) * (big ? 2.1 : 1.0);
        const c = new Color(starPal[Math.floor(rnd() * starPal.length)]!);
        const b = Math.max(0.42, 1.02 - (r - 6) * 0.018) * (0.85 + rnd() * 0.15);
        col.set([c.r * b, c.g * b, c.b * b], i * 3);
        tw[i] = rnd();
      }
      const sg = new BufferGeometry();
      sg.setAttribute('position', new BufferAttribute(pos, 3));
      sg.setAttribute('sz', new BufferAttribute(sz, 1));
      sg.setAttribute('col', new BufferAttribute(col, 3));
      sg.setAttribute('tw', new BufferAttribute(tw, 1));
      this.starMat = new ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uPx: { value: 900 } },
        vertexShader: `
          attribute float sz; attribute vec3 col; attribute float tw;
          uniform float uTime; uniform float uPx;
          varying vec3 vC; varying float vA;
          void main(){
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            float blink = 0.62 + 0.38 * sin(uTime * (0.6 + tw * 1.8) + tw * 50.0);
            vC = col; vA = blink;
            gl_PointSize = max(1.1, sz * 0.0045 * uPx / -mv.z);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          varying vec3 vC; varying float vA;
          void main(){
            float r = length(gl_PointCoord - vec2(0.5));
            if (r > 0.5) discard;
            // 收紧的光核：亮点小而实，外围只留一圈极短的过渡，不发糊
            float core = smoothstep(0.50, 0.20, r);
            float halo = smoothstep(0.50, 0.34, r) * 0.35;
            gl_FragColor = vec4(vC, (core + halo * (1.0 - core)) * vA);
          }`,
        transparent: true, depthWrite: false, blending: AdditiveBlending
      });
      this.stars = new Points(sg, this.starMat);
      this.scene.add(this.stars);
    }

    // （竖向光丝装饰已按用户要求移除：画面里那些隐约的竖型条纹就是它）

    // 调试：?only=core / rings / dust，用来隔离是哪个组在出线条
    const only = new URLSearchParams(location.search).get('only');
    if (only === 'core') this.spin.visible = false;
    if (only === 'rings') { this.core.visible = false; this.dust.visible = false; }
    if (only === 'dust') { this.spin.visible = false; this.core.visible = false; }
    // 调试：?dbg3d=1 把实例挂到 window，CDP 可以直接查内部状态
    if (new URLSearchParams(location.search).has('dbg3d')) {
      (window as unknown as Record<string, unknown>)['__c3d'] = this;
    }

    this.resize();
    this.setPreset('galaxy', false);
    this.bindDrag();
    this.start();
  }

  private static clamp(v: number, a: number, b: number): number { return Math.max(a, Math.min(b, v)); }

  /**
   * 事件目标是 UI 时不能拖镜：实体、站体、HUD、命令面板、输入框都让给它们自己的语义。
   * 拖拽监听挂在 window 上 —— #space3d 在 z-index 0，上面的实体层 / HUD
   * 会截走空白处的 pointerdown，绑在 host 上永远收不到事件。
   */
  private static readonly UI_HIT =
    '.entity,#station,#palette,#hud-top,#hud-bottom,#toast,#runner,#decisions,button,input,textarea';

  /** 拖拽 orbit：按住空白处拖动 = 绕星核 360° 环绕（水平不限圈数，俯仰近全向） */
  private bindDrag(): void {
    let px = 0;
    let py = 0;
    window.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (this.locked || this.fly || ev.button !== 0) return;
      const t = ev.target;
      if (t instanceof Element && t.closest(Core3D.UI_HIT)) return;
      // 起手拖镜时清掉任何残留选区（含从标签上划过留下的蓝色高亮）
      window.getSelection()?.removeAllRanges();
      this.dragging = true;
      px = ev.clientX;
      py = ev.clientY;
      this.yawV = 0;
      this.pitchV = 0;
      this.host.style.cursor = 'grabbing';
      try { (ev.target as Element).setPointerCapture?.(ev.pointerId); } catch { /* 合成事件没有活动指针，忽略 */ }
    });
    window.addEventListener('pointermove', (ev: PointerEvent) => {
      if (!this.dragging) return;
      const dx = ev.clientX - px;
      const dy = ev.clientY - py;
      px = ev.clientX;
      py = ev.clientY;
      this.yaw += dx * 0.0028;                    // 水平 360° 自由环绕，不设限
      this.pitchOff = Core3D.clamp(this.pitchOff + dy * 0.0020, -1.25, 1.25);
      this.yawV = dx * 0.0028;
      this.pitchV = dy * 0.0020;
      // 侧倾与横扫速度挂钩：像飞行器转向时压坡度，停下就回正
      this.rollGoal = Core3D.clamp(-this.yawV * 1.1, -0.055, 0.055);
    });
    const up = (): void => {
      if (!this.dragging) return;
      this.dragging = false;
      this.host.style.cursor = 'grab';
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    // 滚轮推拉：向前推近星核、向后拉远。锁定 / 飞行中不接管
    window.addEventListener('wheel', (ev: WheelEvent) => {
      if (this.locked || this.fly || this.reduced) return;
      const t = ev.target;
      if (t instanceof Element && t.closest(Core3D.UI_HIT)) return;
      ev.preventDefault();
      this.zoomGoal = Core3D.clamp(this.zoomGoal - ev.deltaY * 0.0006, 0, 0.55);
    }, { passive: false });
  }

  /** 标准轨道机位（无飞行时）：基础俯角 + 拖拽偏移 + 滚轮推拉 */
  private orbitPos(): Vector3 {
    const pitch = Core3D.clamp(0.2625 + this.pitchOff, -1.40, 1.50);
    const yaw = this.yaw;
    const d = this.camDist * (1 - Core3D.clamp(this.zoomK, 0, 0.72));
    return new Vector3(
      Math.sin(yaw) * Math.cos(pitch) * d,
      Math.sin(pitch) * d,
      Math.cos(yaw) * Math.cos(pitch) * d
    );
  }

  private placeCamera(): void {
    if (this.fly) return;      // 运镜期间位姿由 updateFly 全权接管
    this.camera.position.copy(this.orbitPos());
    this.camera.lookAt(this.lookCur);
    // 侧倾最后叠上：lookAt 会重置四元数，滚转必须在其之后写入
    if (Math.abs(this.rollCur) > 0.0004) this.camera.rotateZ(this.rollCur);
  }

  /**
   * 点击星系模块：镜头沿「相机 → 该星系」的射线推进，停在其前方 2.6 单位处。
   * 视线方向全程不变 —— 星系在屏幕上原地不动、逐渐放大，落位后回调里切详情页。
   */
  flyTo(target: Vector3, cb: () => void): boolean {
    if (this.fly || this.locked || this.reduced) return false;
    const fromPos = this.camera.position.clone();
    const dir = target.clone().sub(fromPos);
    if (dir.lengthSq() < 0.25) return false;
    dir.normalize();
    const toPos = target.clone().addScaledVector(dir, -2.6);
    this.fly = {
      t: 0, dur: 0.95, fromPos, toPos,
      fromLook: fromPos.clone().add(dir),
      toLook: toPos.clone().add(dir),       // 同方向 → 姿态恒定，目标不跑偏
      cb
    };
    return true;
  }

  /** 详情页就位后回到标准轨道机位（与新层淡入重叠，不突兀） */
  flyBack(): void {
    const fromPos = this.camera.position.clone();
    // 当前视线方向从相机四元数取：flyTo 结束时姿态定格，从这里平滑撤回
    const fwd = new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.fly = {
      t: 0, dur: 0.9, fromPos, toPos: this.orbitPos(),
      fromLook: fromPos.clone().addScaledVector(fwd, 10),
      toLook: new Vector3()
    };
  }

  /**
   * 关闭星系模块：镜头沿当前视线『后撤』（拉远）—— 模块在画面里退小、
   * 星系结构逐渐露全，落位后回调切层，再 flyBack 收进银河层轨道机位。
   */
  flyOut(cb: () => void): boolean {
    if (this.fly || this.locked || this.reduced) return false;
    const fromPos = this.camera.position.clone();
    const look = this.lookCur.clone();
    const dir = look.clone().sub(fromPos).normalize();
    this.fly = {
      t: 0, dur: 0.62,
      fromPos, toPos: fromPos.clone().addScaledVector(dir, -4.4),
      fromLook: look, toLook: look,      // 注视点不动：纯粹的拉远
      cb
    };
    return true;
  }

  /** 运镜进行中（外部据此忽略重复触发） */
  get flying(): boolean { return this.fly !== null; }

  /**
   * 开场运镜：从远处高空俯冲入轨（2.4s 缓出）。
   * 远处雾把环与核吞掉、只有星空可见，接近过程中星系结构一层层浮现，
   * 与深空幕布的淡出叠在一起，读起来是「跃迁抵达」而不是「页面画好了」。
   */
  playIntro(): void {
    if (this.reduced || this.locked) return;
    const end = this.orbitPos();
    const start = end.clone().multiplyScalar(2.7);
    start.y += 5.4;
    this.camera.position.copy(start);
    this.lookCur.set(0, 1.4, 0);
    this.fly = {
      t: 0, dur: 2.4, eo: true,
      fromPos: start, toPos: end,
      fromLook: new Vector3(0, 2.4, 0), toLook: new Vector3()
    };
  }

  private tmpLook = new Vector3();
  private updateFly(dt: number): void {
    const f = this.fly;
    if (!f) return;
    f.t += dt;
    const u = Math.min(1, f.t / f.dur);
    const e = f.eo
      ? 1 - Math.pow(1 - u, 3)                                   // 缓出：先快后慢
      : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; // 标准缓入缓出
    this.camera.position.lerpVectors(f.fromPos, f.toPos, e);
    this.tmpLook.lerpVectors(f.fromLook, f.toLook, e);
    this.camera.lookAt(this.tmpLook);
    if (u >= 1) {
      this.fly = null;
      // 交还轨道控制前把注视点落定：placeCamera 的 lookCur 从原点起算，衔接无跳变
      this.lookGoal.set(0, 0, 0);
      this.lookCur.set(0, 0, 0);
      f.cb?.();
    }
  }

  /** 注视点平滑：空闲时缓慢回落原点（锁定时相机已静止，不需要任何追随） */
  private updateLook(dt: number): void {
    this.lookGoal.lerp(Core3D.ORIGIN, Math.min(1, dt * 1.6));
    this.lookCur.lerp(this.lookGoal, Math.min(1, dt * 3.2));
  }

  /** 门户星系的世界坐标：点击运镜的目标点（没有对应云团的 id 返回 null） */
  moduleWorldPos(id: string): Vector3 | null {
    return this.modules.worldPos(id);
  }

  /** 注入 Hebbian 光丝提供者：权重 / 高亮 / 压暗的换算留在 main.ts */
  setThreadProvider(p: (() => readonly ThreadRender[]) | null): void {
    this.modules.threadProvider = p;
  }

  /**
   * 每帧锚定回调：把可见云团（含中央星核）投影成屏幕百分比交给 DOM 实体。
   * 标签与入口从此焊在各自的星云上，镜头转到任何角度都不会脱钩。
   */
  onAnchor: ((id: string, x: number | null, y: number | null) => void) | null = null;

  private tmpProj = new Vector3();
  private tmpView = new Vector3();
  private emitAnchors(): void {
    if (!this.onAnchor) return;
    // render 之前 matrixWorld 还是上一帧的：手动刷新一次，锚定才与当帧位姿一致
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    const emit = (id: string, wp: Vector3): void => {
      // 先判前后：project() 对镜头后方的点会镜像翻转，必须用视空间 z 排除
      const vz = this.tmpView.copy(wp).applyMatrix4(this.camera.matrixWorldInverse).z;
      if (vz > -0.5) { this.onAnchor!(id, null, null); return; }
      this.tmpProj.copy(wp).project(this.camera);
      this.onAnchor!(id, this.tmpProj.x * 0.5 + 0.5, 0.5 - this.tmpProj.y * 0.5);
    };
    this.modules.forEachVisible(emit);
    emit('core', Core3D.ORIGIN);     // AI 星核实体锚到丝带核中心（世界原点）
  }

  resize(): void {
    const w = Math.max(1, innerWidth);
    const h = Math.max(1, innerHeight);
    // DPR 会变（窗口拖到另一块屏 / 系统缩放 / 浏览器缩放）：跟随系统上限，
    // 但不覆盖自适应降档的结果 —— this.dpr 只会往下走
    const pr = Math.min(this.dpr, Math.min(devicePixelRatio || 1, 1.5));
    if (Math.abs(this.renderer.getPixelRatio() - pr) > 0.01) {
      this.dpr = pr;
      this.renderer.setPixelRatio(pr);
    }
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const px = (h * this.renderer.getPixelRatio()) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.ptMat.uniforms['uPx']!.value = px;
    this.dustMat.uniforms['uPx']!.value = px;
    this.starMat.uniforms['uPx']!.value = px;
    this.decor.resize(px);
    this.modules.relayout(w / h, h);
  }

  /** 切层：银河层就是主体，恒星/代码层退到深处当背景结构 */
  setPreset(scene: SceneName, animate = true): void {
    const p = PRESET[scene];
    // 只做缩放不做前后位移：往后挪会让整组在画面上「往上飘」，
    // 因为相机是俯视的，等距平移会带出视差偏移。
    this.world.position.set(0, p.dy, 0);
    this.world.scale.setScalar(p.scale);
    // 银河层几乎不额外倾（相机 15° 俯角已够扁），恒星/代码层多倾一点保留俯视构图
    this.world.rotation.x = scene === 'galaxy' ? -0.05 : -0.30;
    // 模块云 / 迷你星系随场景切换（galaxy=大团+突触束；study/code=迷你星系）
    this.modules.setScene(scene);
    // 场景氛围：雾色随层微调 —— study 冷紫、code 暖夜，详情页背景与主题相符
    this.scene.fog?.color.setHex(scene === 'study' ? 0x131024 : scene === 'code' ? 0x181221 : 0x101720);
    this.core.scale.setScalar(p.coreScale);
    for (const r of this.ringMats) r.mat.opacity = Math.min(1, r.base * 1.32 * p.ring);
    for (const m of this.meshMats) m.mat.opacity = m.base * p.ring;
    this.glowMat.opacity = 0.60 * p.core;
    this.hotGlow.opacity = 0.75 * p.core;
    this.edgeMat.uniforms['uGain']!.value = p.core;
    this.ptMat.uniforms['uGain']!.value = p.core;
    // 丝带组同理 —— 它们的透明度是逐条固定的，不吃 uGain，必须整组开关
    // （否则学习层会看到一颗幽灵星核）
    this.ribbons.group.visible = p.core > 0.01;
    // 模块星云团只在银河层：它们贴的是这一层的门户实体，学习/代码层没有这些模块
    // 模块云/迷你星系的分组可见性由 modules.setScene(scene) 全权管理：
    // galaxy=大团+突触束；study/code=迷你星系。这里不再整组开关，
    // 否则 study/code 的 core=0 会把迷你星系一起关掉（真 bug，已修）
    this.dustMat.uniforms['uColor']!.value = p.core > 0.01 ? 1 : 0;
    // 中景实体跟着星核走：模块层没有核，环绕它的碎石 / 彗星一起退场
    this.decor.setCoreGain(p.core);
    for (const o of this.orbitDots) o.dot.material.opacity = 0.85 * p.ring;
    // 层间切换用 CSS 淡入淡出，避免素材突变
    this.host.style.transition = animate ? 'opacity 420ms ease' : 'none';
  }

  /**
   * 详情页打开时：相机停稳在标准机位、整层压暗、背景时间冻结 —— 零旋转零漂移。
   * 曾经的 lockBias（注视点偏向被打开的实体）是在相机空间里每帧重算的：
   * 相机一转目标就跟着转，正反馈成了「背景疯狂旋转」——已彻底移除。
   */
  setLocked(v: boolean): void {
    this.locked = v;
    this.host.style.opacity = v ? String(LOCK_DIM) : '1';
    if (v) {
      this.dragging = false;
      this.rollGoal = 0;
      this.rollCur = 0;
      // 惯性也一并归零：松手后立刻点开笔记，背景不能还在滑
      this.yawV = 0;
      this.pitchV = 0;
    }
  }

  /** Reduced Motion：保留画面，停掉一切自转 */
  setReduced(v: boolean): void {
    this.reduced = v;
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number): void => {
      const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000));
      this.last = now;
      {
        if (!this.reduced) {
          // 详情页打开 = 背景彻底静止（用户裁定：不要旋转）。
          // 时间也不再推进：自转、丝带翻滚、星点闪烁全部定格
          const spd = this.locked ? 0 : 1;
          if (!this.locked) this.clock += dt;
          // 松手后的惯性衰减（锁定时不更新：详情页背景必须定格在原地）
          if (!this.dragging && !this.locked) {
            this.yaw += this.yawV;
            this.pitchOff = Core3D.clamp(this.pitchOff + this.pitchV, -1.25, 1.25);
            this.yawV *= 0.92;
            this.pitchV *= 0.9;
          }
          // 累计角规约到 (-π, π]：360° 自由转若干圈后，锁定回正走最短路径不倒圈
          this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
          // 滚轮推拉与侧倾都走平滑逼近：滚轮一格是阶跃，直接赋值会变成跳帧
          this.zoomK += (this.zoomGoal - this.zoomK) * Math.min(1, dt * 5);
          if (!this.dragging || this.locked) this.rollGoal *= Math.max(0, 1 - dt * 4);
          this.rollCur += (this.rollGoal - this.rollCur) * Math.min(1, dt * 7);
          // 盘面已放平到 XZ，绕竖轴慢转才是「表盘在转」
          this.spin.rotation.y += dt * 0.058 * spd;
          this.core.rotation.z -= dt * 0.085 * spd;
          this.core.rotation.x = Math.sin(this.clock * 0.19) * 0.09;
          this.core.rotation.y = Math.cos(this.clock * 0.14) * 0.11;
          // 丝带：整球慢转 + 每条绕自己的随机轴翻滚（参考原作的做法）
          this.ribbons.group.rotation.y += dt * 0.08 * spd;
          for (const e of this.ribbons.entries) e.mesh.rotateOnAxis(e.ax, e.sp * dt * spd);
          for (const m of this.ribbons.mats) m.uniforms['uTime']!.value = this.clock;
          // 轨道跑点
          for (const o of this.orbitDots) {
            const a = this.clock * o.sp * spd + o.phase;
            o.dot.position.set(Math.cos(a) * o.r, 0.02, Math.sin(a) * o.r);
          }
          this.modules.setTime(this.clock);
          // 中景实体：碎石公转 / 彗星每 4~5 秒掠过一次。
          // spd=0（详情页）时 dt 归零，update 直接返回 —— 与整层定格同步
          this.decor.update(this.clock, dt * spd);
          this.edgeMat.uniforms['uTime']!.value = this.clock;
          this.ptMat.uniforms['uTime']!.value = this.clock;
          this.starMat.uniforms['uTime']!.value = this.clock;
          this.updateFly(dt);
          if (!this.fly) this.updateLook(dt);

          // 自适应分辨率：连续 2 秒掉帧就降渲染像素比一档，降了不升（防振荡）。
          // 只在正常运动状态采样 —— 详情页定格 / Reduced Motion 不代表性能不够
          if (!this.locked) {
            if (dt > 0.026) this.slowFrames++;
            else if (this.slowFrames > 0) this.slowFrames--;
            if (this.slowFrames > 120 && this.dpr > 0.8) {
              this.dpr = Math.max(0.8, Math.round((this.dpr - 0.25) * 100) / 100);
              this.renderer.setPixelRatio(this.dpr);
              this.resize();
              this.slowFrames = 0;
              console.info(`[space3d] 检测到掉帧，渲染分辨率已降档至 ${this.dpr}x`);
            }
          }
        }
        this.placeCamera();
        this.emitAnchors();
        this.renderer.render(this.scene, this.camera);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.stop();
    this.scene.traverse(obj => {
      const o = obj as unknown as { geometry?: BufferGeometry; material?: unknown };
      o.geometry?.dispose();
      const mat = o.material;
      if (Array.isArray(mat)) mat.forEach(m => { m.map?.dispose(); m.dispose(); });
      else {
        const m = mat as { map?: CanvasTexture; dispose(): void } | undefined;
        m?.map?.dispose();
        m?.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
