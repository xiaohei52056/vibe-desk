import { getState, setState, subscribe } from './core/state';
import { Entities } from './space/entities';
import { Camera } from './space/camera';
import { findEntity, hideEntity, isSeedId, setExtraNotes } from './space/coords';
import { Station } from './station/station';
import { mountHud } from './ui/hud';
import { bindKeys } from './ui/keys';
import { toast } from './ui/toast';
import type { Core3D } from './space/core3d';
import { createNote, deleteNote, initNotes, noteOf, notes as noteMap, onNotes } from './notes/store';
import { WritePanel } from './notes/writePanel';
import { syncIndex } from './search/indexer';
import { Palette } from './ui/palette';
import { dropReview, dueList, initReview, onReview } from './notes/review';
import { initDecisions, onDecisions, removeDecisionsFor } from './notes/decisions';
import { walkThread, threads, linkWeight, linkNorm, linkKey, walkedKey } from './notes/links';
import { RunnerPanel } from './sandbox/panel';
import { applyBundle, buildBundle, downloadBundle, parseBundle } from './storage/transfer';
import { autoSyncFromCloud, pullFromCloud, pushToCloud } from './storage/remote';
import { initEntityRows } from './storage/entityData';
import { loadView, rememberView } from './core/session';
import { MOD_KEY } from './ui/platform';

const stage = document.getElementById('stage');
const world = document.getElementById('world');
const entitiesEl = document.getElementById('entities');
const labelsEl = document.getElementById('labels');
const stationEl = document.getElementById('station');

if (!stage || !world || !entitiesEl || !labelsEl || !stationEl) {
  throw new Error('装配失败：缺少根节点');
}

// 只有 3D 一种渲染路径：这个 class 从第一帧起就常驻，
// 它是「3D 星表样式」的钩子（小光核、隐藏 CSS 假景深层），不再是模式开关。
document.body.classList.add('space3d');

// 只负责「开站 / 书写态」两个状态 class（详情页要暂停实体呼吸）
new Camera(stage);

let stationRef: Station | null = null;
const entities = new Entities(entitiesEl, labelsEl, {
  activate: (id) => { activateEntity(id); },
  focus: (id) => {
    const s = getState();
    if (!id) { entities.setFocus(null); setState({ focus: null }); return; }
    const found = findEntity(id);
    entities.setFocus(id, found?.e);
    setState({ focus: id });
    void s;
  }
});

stationRef = new Station(stationEl, entities);
stationRef.onDelete = (id) => { void removeNote(id); };

/**
 * 从星系模块回到银河层：先「后撤运镜」（模块退小、结构露全），落位后切层，
 * 再收进银河层的轨道机位。3D 未启用 / 运镜进行中时退化为直接切层。
 */
function exitScene(): void {
  const s = getState();
  if (s.scene === 'galaxy' || s.station) return;
  if (core3d?.flying) return;                 // 进出运镜中，别叠
  const land = (): void => {
    setState({ scene: 'galaxy', focus: null });
    toast('已回到银河层');
  };
  const started = core3d?.flyOut(() => { land(); core3d?.flyBack(); });
  if (!started) land();
}

/**
 * 统一激活入口：星系模块 → 3D 相机沿视线向它的云团推进（星系原地放大），
 * 落位后再切层（丝滑进出）；其余实体照旧走站体。core3d 未加载 / 动画中 / 锁定时直接回退。
 */
function activateEntity(id: string): void {
  const found = findEntity(id);
  if (!found) return;
  const e = found.e;
  if (core3d && e.kind === 'galaxy' && e.scene && !getState().station) {
    const target = core3d.moduleWorldPos(id);
    if (target) {
      const label = e.label;
      const started = core3d.flyTo(target, () => {
        setState({ scene: e.scene!, focus: null });
        toast(`推近到 ${label}`);
        core3d?.flyBack();
      });
      if (started) return;
    }
  }
  stationRef?.activate(id);
}

// ---- 渲染驱动：只在真正变化的维度上动手，避免每次状态变更都重建 DOM ----
let lastScene = '';
let lastStation: string | null = null;
let lastMode = '';

/** 3D 锚定的最后已知位置：实体 DOM 重建时立刻落回，避免闪回冻结坐标 */
const anchorCache = new Map<string, [number, number]>();

function paint(): void {
  const s = getState();

  if (s.scene !== lastScene) {
    lastScene = s.scene;
    entities.render(s.scene);
    // #world 必须保持 scale(1)：它包着锚定实体，任何缩放都会把标签推离各自的星云
    world!.style.transform = 'scale(1)';
    // 新建的实体先落回上一次的 3D 投影位（别的场景的 id 查不到 DOM，自动跳过）
    for (const [id, [x, y]] of anchorCache) entities.setAnchor(id, x, y);
  }
  if (s.station !== lastStation || s.mode !== lastMode) {
    lastStation = s.station;
    lastMode = s.mode;
  }
}

subscribe(paint);
mountHud();

// 会话记忆：状态一变就排一次写（内部按「层|站|工位」判重，鼠标划过不会持续写盘）
subscribe(() => rememberView());

/* ============================================================
   真 3D 空间层 —— 唯一的渲染路径。
   仍走动态 import（three 有 123 KB gzip，不能进首屏），但没有任何 2D 回退：
   起不来就明确报错，不再静默切成另一套星图。
   ============================================================ */
let core3d: Core3D | null = null;

/* ============================================================
   开场特效：深空幕布淡出 + 光环扩散 + 镜头跃迁入轨 + 星表延迟浮现
   —— 演示参数 / Reduced Motion 下不打扰，直接落终态
   ============================================================ */
function playIntro(): void {
  const q = new URLSearchParams(location.search);
  if (getState().reduce || q.has('station') || q.has('scene') || q.has('panel') || q.has('notrans')) return;
  const veil = document.createElement('div');
  veil.className = 'intro-veil';
  document.body.appendChild(veil);
  document.body.classList.add('intro');
  core3d?.playIntro();
  window.setTimeout(() => veil.classList.add('out'), 240);          // 幕布开始淡出
  window.setTimeout(() => document.body.classList.remove('intro'), 760);  // 星表 / HUD 浮现
  window.setTimeout(() => veil.remove(), 1700);                     // 收尾清节点
}

async function mount3d(): Promise<void> {
  const host = document.getElementById('space3d');
  if (!host) return;
  try {
    const { Core3D: C } = await import('./space/core3d');
    core3d = new C(host);
    core3d.setReduced(getState().reduce);
    core3d.setPreset(getState().scene, false);
    // 每帧把星云的屏幕投影喂给实体层：标签 / 圆点 / 入口焊在自己的星云上
    core3d.onAnchor = (id, x, y) => {
      if (x == null || y == null) { entities.setAnchor(id, null, null); return; }
      anchorCache.set(id, [x, y]);
      entities.setAnchor(id, x, y);
    };
    // 3D 光丝：端点钉在迷你星系之间，权重 / 高亮 / 压暗在这里换算
    core3d.setThreadProvider(() => {
      const st = getState();
      const hotId = st.station ? '' : (st.focus ?? '');
      const just = walkedKey();
      return threads().map(([a, b]) => ({
        a, b,
        norm: linkNorm(linkWeight(a, b)),
        hot: (!!hotId && (hotId === a || hotId === b)) || (just !== null && just === linkKey(a, b)),
        dim: !!st.station
      }));
    });
    playIntro();
  } catch (err) {
    // 没有 2D 星图可退：把问题说清楚，而不是悄悄换一套渲染方式
    console.error('[space3d] 3D 空间层初始化失败', err);
    toast('3D 空间层未能启动 · 请检查浏览器的 WebGL 支持');
    playIntro();
  }
}

void mount3d();

// 状态 → 3D 层：切星系换姿态，开站进入 3D 氛围背景（静止压暗）
subscribe(s => {
  if (!core3d) return;
  core3d.setPreset(s.scene, true);
  core3d.setLocked(!!s.station);
  core3d.setReduced(s.reduce);
});

/* ============================================================
   笔记内核（P5.2）
   —— 数据先就位：IndexedDB 四 store + 首次迁移 + 种子。
   —— 编辑器按需加载：CodeMirror 只在第一次进书写态时下载。
   —— 索引常驻内存：搜索面板随时能开，不依赖任何页面。
   ============================================================ */

const llabel = (id: string, fallback: string): string => noteOf(id)?.title || fallback;

/** 把非种子的笔记登记成恒星。坐标由 id 决定，重复调用幂等 */
function syncExtras(): void {
  setExtraNotes([...noteMap.values()].map(n => ({ id: n.id, title: n.title })));
}

function rerenderEntities(): void {
  entities.render(getState().scene);
  entities.refreshLabels(llabel);
  refreshDue();
}

/** 星表上那三处极细的刻度：只改 class，不重建实体 */
function refreshDue(): void {
  entities.applyDue(new Set(dueList()));
}

/**
 * 跳到某篇笔记。
 * 不手动 close 站体：它自己会处理「不同 id 先收再开」，
 * 外面再插一次 close 会和它内部的 430ms 排队打架，出现「关了开不回来」。
 */
function jumpTo(id: string, opts: { write?: boolean; title?: boolean; from?: string } = {}): void {
  const s = getState();
  // 只有「顺着引用跳过去」才算走过这条关联；搜索跳转不算
  if (opts.from && opts.from !== id) walkThread(opts.from, id);
  if (s.scene !== 'study') setState({ scene: 'study' });
  const opened = s.station === id;
  if (!opened) stationRef?.open(id);
  if (!opts.write) return;
  if (opened && getState().mode === 'write') {
    if (opts.title) panel.requestTitleFocus();
    return;
  }
  window.setTimeout(() => stationRef?.toWrite(), opened ? 60 : 760);
  if (opts.title) {
    panel.requestTitleFocus();          // 编辑器还没挂上时留标记，挂上就生效
    focusTitleWhenReady(id);            // 已经挂上的情况，直接落过去
  }
}

/** 编辑器是异步挂载的：等它真在篇上再把光标放过去，不靠猜时长 */
function focusTitleWhenReady(id: string, tries = 14): void {
  if (panel.mountedFor === id) { panel.requestTitleFocus(); return; }
  if (tries <= 0) return;
  window.setTimeout(() => focusTitleWhenReady(id, tries - 1), 110);
}

async function createNewNote(): Promise<void> {
  const note = await createNote('');
  syncExtras();
  if (getState().scene !== 'study') setState({ scene: 'study' });
  rerenderEntities();
  toast('新的一颗 · 还没起名字');
  window.setTimeout(() => jumpTo(note.id, { write: true, title: true }), 260);
}

/** 删除一篇笔记：数据（正文/关联/决策/回看）与星图实体一起清，然后收站 */
async function removeNote(id: string): Promise<void> {
  const title = noteOf(id)?.title ?? '';
  if (getState().mode === 'write') await panel.teardown();
  try {
    await deleteNote(id);
    await Promise.all([removeDecisionsFor(id), dropReview(id)]);
    // 种子笔记的坐标写死在设计稿里，删掉后要从星表退场（并记住）；其余笔记由 notes 表决定
    if (isSeedId(id)) hideEntity(id);
    syncExtras();
    rerenderEntities();
    palette.refresh();
    stationRef?.close();
    toast(title ? `已删除《${title}》` : '已删除这篇');
  } catch (err) {
    console.warn('[notes] 删除失败', err);
    toast('删除失败 · 存储不可用');
  }
}

const panel = new WritePanel({
  onJump: (id, from) => jumpTo(id, { write: true, from })
});

/**
 * 编译实验室：跑在 sandbox iframe 里。
 * 错误行要跳回正文，所以两边互通：面板给「第几行」，WritePanel 换算成编辑器行。
 */
const runner = new RunnerPanel({
  onGoto: line => panel.gotoLine(line),
  codeAtCursor: () => panel.codeAtCursor(),
  onFocusBack: () => panel.focusBody(),
  onInsert: text => panel.insertOutput(text)
});
panel.attachRunner(runner);

/** 决策命中之后：等书写面板真的挂到这篇上，再把那一条就地展开 */
function revealDecisionWhenReady(noteId: string, decId: string, tries = 16): void {
  if (panel.revealDecision(noteId, decId)) return;
  if (tries <= 0) return;
  window.setTimeout(() => revealDecisionWhenReady(noteId, decId, tries - 1), 110);
}

/* ---- 数据出入口：一份 JSON，进得去也出得来 ---- */

async function exportData(): Promise<void> {
  try {
    const bundle = await buildBundle();
    downloadBundle(bundle);
    toast(`已导出 ${bundle.notes.length} 篇 · 一个 JSON 文件`);
  } catch (err) {
    console.warn('[transfer] 导出失败', err);
    toast('导出失败 · 存储不可用');
  }
}

/** 导入是替换式的：先关掉当前工位，避免面板还挂在一篇已经不存在的笔记上 */
function importData(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  // 挂在文档里而不是内存里：部分浏览器对游离节点的文件选择器不认
  input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) { input.remove(); return; }
    void file.text().then(async text => {
      const bundle = parseBundle(text);
      await applyBundle(bundle);
      await refreshAfterReplace();
      toast(`已导入 ${bundle.notes.length} 篇 · 原有数据已被替换`);
    }).catch(err => {
      console.warn('[transfer] 导入失败', err);
      toast('导入失败 · 这个文件不是 VIBE DESK 的导出');
    }).finally(() => input.remove());
  });
  input.click();
}

/* ---- 云端同步：Spring Boot 后端（backend/）。替换式，与文件导入导出同一份 Bundle ---- */

/** 数据替换后共用的一串刷新：工位收尾 → 重放全量状态 → 重绘实体 */
async function refreshAfterReplace(): Promise<void> {
  if (getState().station) {
    await panel.teardown();
    stationRef?.close();
  }
  await initNotes();
  await Promise.all([initReview(), initDecisions()]);
  await initEntityRows();   // 光门 / 项目卡配置跟着 Bundle 一起换
  syncIndex();
  syncExtras();
  rerenderEntities();
  palette.refresh();
}

async function pullCloud(): Promise<void> {
  if (!confirm('云端拉取会用服务器数据替换本地全部数据（含笔记、链接、决策、图片）。确定？')) return;
  try {
    const s = await pullFromCloud();
    await refreshAfterReplace();
    toast(`已从云端拉取 ${s.notes} 篇笔记 · ${s.assets} 张图片`);
  } catch (err) {
    console.warn('[sync] 云端拉取失败', err);
    toast('没连上后端 · 本地数据没动，启动后端后会自动同步');
  }
}

async function pushCloud(): Promise<void> {
  if (!confirm('云端推送会用本地数据覆盖服务器全部数据。覆盖前建议先「导出全部数据」留档。确定？')) return;
  try {
    const s = await pushToCloud();
    toast(`已推送到云端：${s.notes} 篇笔记 · ${s.assets} 张图片`);
  } catch (err) {
    console.warn('[sync] 云端推送失败', err);
    toast('没连上后端 · 本地数据没动，启动后端后会自动同步');
  }
}

const paletteEl = document.getElementById('palette');
const palette = new Palette(paletteEl ?? document.body, {
  openNote: id => jumpTo(id),
  openDecision: (noteId, decId) => {
    jumpTo(noteId, { write: true });
    revealDecisionWhenReady(noteId, decId);
  },
  createNote: () => { void createNewNote(); },
  goScene: scene => {
    if (getState().station) stationRef?.close();
    setState({ scene, focus: null });
  },
  closeStation: () => {
    const s = getState();
    if (!s.station) { toast('没有打开的站'); return; }
    if (s.mode === 'write') void panel.teardown();
    stationRef?.close();
  },
  exportData: () => { void exportData(); },
  importData,
  pullCloud: () => { void pullCloud(); },
  pushCloud: () => { void pushCloud(); }
});

/** A5：关掉再开，回到上次位置 + 上次工位。截图/演示参数优先，别被记忆覆盖 */
async function restoreView(): Promise<void> {
  const q = new URLSearchParams(location.search);
  if (q.has('scene') || q.has('station') || q.has('panel')) return;
  const v = await loadView();
  if (!v) return;
  if (v.scene !== getState().scene) setState({ scene: v.scene });
  if (!v.station || !findEntity(v.station)) return;
  stationRef?.open(v.station);
  if (v.mode === 'write') window.setTimeout(() => stationRef?.toWrite(), 760);
}

void initNotes().then(async report => {
  // 回看与决策都要在笔记就位之后再读：前者按「最后落笔时间」算到期，后者要挂到笔记上
  await Promise.all([initReview(), initDecisions()]);

  // 启动即自动同步云端：合并式（只补不删、新者胜）、失败静默。
  // 后端没开、静态部署、网络不通都只当离线处理，不弹错误打断阅读。
  const cloud = await autoSyncFromCloud();
  if (cloud.ok) {
    await initNotes();
    await Promise.all([initReview(), initDecisions()]);
  }
  await initEntityRows();          // 光门 / 项目卡配置（本地或刚同步来的）
  syncIndex();
  syncExtras();
  rerenderEntities();
  stationRef?.refresh();
  if (report.source === 'legacy') toast(`已从原型迁移 ${report.notes} 篇笔记`);
  else if (report.source === 'seed') toast('首次启动 · 已放入七篇示例笔记');
  console.info('[notes]', report, '[cloud]', cloud);
  if (!cloud.ok) {
    // 后端可能比页面晚一步起来：静默重试，连上后自动补一次数据（最多 5 分钟）
    let tries = 0;
    const timer = window.setInterval(() => {
      tries++;
      void autoSyncFromCloud().then(async r => {
        if (!r.ok) { if (tries >= 20) window.clearInterval(timer); return; }
        window.clearInterval(timer);
        await initNotes();
        await Promise.all([initReview(), initDecisions()]);
        await initEntityRows();
        syncIndex();
        syncExtras();
        rerenderEntities();
        stationRef?.refresh();
        palette.refresh();
      });
    }, 15000);
  }
  void restoreView();
}).catch(err => {
  console.warn('[notes] 存储不可用，退回只读', err);
});

// 回看答完：只退掉星表上那道刻度，不做任何「已记录」提示（C6）
onReview(() => { refreshDue(); });

// 决策变了：观看态那一行与搜索都要跟着改
onDecisions(() => {
  stationRef?.refresh();
  palette.refresh();
});

// 内容变了：索引增量同步、星表标签热更新、面板原地刷新。
// 这里不重建实体 DOM —— 重建会打断呼吸动画和 hover。
onNotes(() => {
  syncIndex();
  syncExtras();
  entities.refreshLabels(llabel);
  palette.refresh();
  stationRef?.refresh();
  // 正文变了，能不能出题也跟着变：空笔记补上正文就该有机会浮上来
  refreshDue();
});

// 站体进出时驱动书写面板。
// 必须比「上一次的 station:mode」——否则任意状态变更（focus、提示等）
// 就会重复触发 open/teardown，把刚挂上的编辑器拆掉。
let lastKey = '';
subscribe(s => {
  const key = s.station ? `${s.station}:${s.mode}` : '';
  if (key === lastKey) return;
  lastKey = key;
  if (!s.station) { if (panel.mountedFor) void panel.teardown(); return; }
  if (s.mode === 'write') void panel.open(s.station);
  else { if (panel.mountedFor) void panel.teardown(); stationRef?.refresh(); }
});

// ---- 键盘语义：Esc 逐层返回，Enter 进入焦点对象 ----
const esc = (): void => {
  if (palette.isOpen) { palette.close(); return; }
  // 沙盒先收：它压在书写态最上层，Esc 的语义必须逐层退
  if (runner.isOpen) { runner.hide(); return; }
  const s = getState();
  if (s.station && s.mode === 'write') { void panel.teardown(); stationRef?.toView(); return; }
  if (s.station) { stationRef?.close(); return; }
  if (s.scene !== 'galaxy') { exitScene(); return; }
  toast('已在银河层');
};

// 详情页打开时：点空白处即关闭。
// 站体内部 / 命令面板 / 沙盒 / 提示 / HUD / 实体本身都不算空白 ——
// 点实体是「切到那篇」，由实体自己的 click 处理，别在这里抢。
window.addEventListener('pointerdown', (ev: PointerEvent) => {
  const s = getState();
  if (!s.station) return;
  const t = ev.target;
  if (t instanceof Element &&
      t.closest('#station,#palette,#runner,#toast,#decisions,#hud-top,#hud-bottom,.entity')) return;
  // 与 Esc 同一套语义：书写态先退回观看态，观看态再收站
  if (s.mode === 'write') { void panel.teardown(); stationRef?.toView(); return; }
  stationRef?.close();
});

// 星系模块内：点空白处回到银河层。
// 与详情页的区别：这里点空白不能「按下即走」——按下往往是拖镜的开始，
// 必须按下与抬起几乎在同一位置（<6px 位移）才算一次点击。
let blankDown: { x: number; y: number } | null = null;
const BLANK_HIT = '#station,#palette,#runner,#toast,#decisions,#hud-top,#hud-bottom,.entity';

window.addEventListener('pointerdown', (ev: PointerEvent) => {
  blankDown = null;
  if (ev.button !== 0) return;
  const s = getState();
  if (s.station || s.scene === 'galaxy') return;
  const t = ev.target;
  if (t instanceof Element && t.closest(BLANK_HIT)) return;
  blankDown = { x: ev.clientX, y: ev.clientY };
});

window.addEventListener('pointerup', (ev: PointerEvent) => {
  const d = blankDown;
  blankDown = null;
  if (!d || ev.button !== 0) return;
  const s = getState();
  if (s.station || s.scene === 'galaxy') return;
  if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6) return;   // 拖拽，不算点击
  exitScene();
});

bindKeys({
  esc,
  enter: () => {
    const id = getState().focus;
    if (id) activateEntity(id);
    else toast('先把鼠标移到一颗恒星或行星上');
  },
  toggleWrite: () => {
    const s = getState();
    if (!s.station) { toast('先进入一个实体'); return; }
    if (s.mode === 'write') { void panel.teardown(); stationRef?.toView(); return; }
    const found = findEntity(s.station);
    if (found && found.e.kind !== 'note' && found.e.kind !== 'phantom') {
      toast('这一层没有正文 · 笔记才有');
      return;
    }
    stationRef?.toWrite();
  },
  search: () => palette.open('search'),
  command: () => palette.open('command'),
  decision: () => {
    const s = getState();
    if (!s.station || s.mode !== 'write') { toast('先进书写态 · Tab'); return; }
    panel.openDecisionForm();
  },
  run: () => {
    const s = getState();
    if (!s.station || s.mode !== 'write') { toast('先进书写态 · Tab'); return; }
    runner.toggle();
  },
  blocked: () => palette.isOpen
});

// ---- 尺寸：分辨率 / DPR / 方向 / 容器变化都要重新对齐（rAF 合并，不排队） ----
let resizeQueued = false;
const resize = (): void => {
  resizeQueued = false;
  // 窗口最小化 / 隐藏时视口是 0：跳过，等恢复后再对齐
  if (innerWidth < 1 || innerHeight < 1) return;
  core3d?.resize();
  const s = getState();
  if (s.station) {
    // 只重算盒子，不重播动效 —— 改窗口大小不该再「长」一次
    stationRef?.relayout();
    panel.measure();
  }
};
const queueResize = (): void => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(resize);
};

window.addEventListener('resize', queueResize);
window.addEventListener('orientationchange', queueResize);
// 移动端地址栏收放只改 visualViewport，不触发 window.resize
window.visualViewport?.addEventListener('resize', queueResize);
// 预览面板 / iframe 里拖动容器时，window 尺寸事件可能不出现，靠容器观察兜底
new ResizeObserver(queueResize).observe(document.documentElement);

/** DPR 变化（跨屏拖动 / 系统缩放 / 浏览器缩放）：媒体查询一次性的，变了要重绑 */
function bindDpr(): void {
  const mq = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
  mq.addEventListener('change', () => { queueResize(); bindDpr(); }, { once: true });
}
bindDpr();

// ---- 启动 ----
paint();

// 截图 / 演示用：允许用查询参数直接落到某个状态，省去逐帧点击
{
  const q = new URLSearchParams(location.search);
  // 无头截图里虚拟时间不推进 CSS 过渡，这个参数直接看终态（同时走 reduced-motion 分支）
  // 无头/演示：强制 Reduced Motion，直接看终帧
  if (q.get('reduce') === '1') setState({ reduce: true });
  if (q.get('notrans') === '1') {
    const st = document.createElement('style');
    st.textContent = '*{transition:none!important;animation:none!important}';
    document.head.appendChild(st);
    setState({ reduce: true });
  }
  const sc = q.get('scene');
  if (sc === 'study' || sc === 'code') setState({ scene: sc });
  const st2 = q.get('station');
  if (st2) stationRef?.open(st2);
  // 截图 / 演示：直接把面板摆出来，省去一次按键
  const pn = q.get('panel');
  if (pn === 'search' || pn === 'command') {
    window.setTimeout(() => palette.open(pn, q.get('q') ?? undefined), 260);
  }
}

// 组合键文案按平台显示：mac 上是 ⌘，Windows 上是 Ctrl（键位绑定两者都吃）
{
  const wcKeys = document.getElementById('wc-keys');
  if (wcKeys) wcKeys.textContent = `Tab 视图\u3000${MOD_KEY('Enter')} 运行\u3000Esc 收站`;
  const rnCode = document.getElementById('rn-code');
  if (rnCode instanceof HTMLTextAreaElement) {
    rnCode.placeholder = `// 光标停在一个 \`\`\`python 或 \`\`\`java 代码块里，按 ${MOD_KEY('Enter')} 会直接带过来并运行`;
  }
}

// 首屏不弹任何浮框：引导只写进极淡的一行 HUD，3 秒后自动恢复
const hint = document.getElementById('hud-hint');
if (hint) {
  window.setTimeout(() => {
    hint.textContent = '拖拽 360° 环绕 · 滚轮推拉 · Enter 进入';
    window.setTimeout(() => {
      hint.textContent = getState().station
        ? 'ViewportLock · 相机与氛围层双锁'
        : '实体钉在星云上 · 点击推近';
    }, 3200);
  }, 500);
}
