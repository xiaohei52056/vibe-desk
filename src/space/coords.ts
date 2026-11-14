/**
 * 坐标冻结契约。
 * 实体 spacePos 一经分配即永久化：公转、视差、缩放都只作用于装饰层。
 * 这里用 Object.freeze 把「不许改」从约定变成运行时会抛错的硬约束。
 */
import type { EntityDef, SceneName } from '../core/state';

/** 深冻结：坐标是契约，不是配置。任何写回都会在严格模式下抛错 */
const frozen = (list: EntityDef[]): readonly EntityDef[] =>
  Object.freeze(list.map(e => Object.freeze(e)));

const GALAXY = frozen([
  { id: 'study',  kind: 'galaxy',  tone: 'study', x: .22, y: .31, label: '学习星系', sub: 'Study Galaxy · Enter 进入', scene: 'study' },
  { id: 'code',   kind: 'galaxy',  tone: 'code',  x: .73, y: .70, label: '项目星系', sub: 'Project Galaxy · Enter 进入',  scene: 'code' },
  { id: 'core',   kind: 'core',    tone: 'core',  x: .50, y: .47, label: 'AI 星核',  sub: '预留位 · v2 接入' },
  { id: 'gate',   kind: 'gate',    tone: 'gate',  x: .86, y: .19, label: '纪念册',   sub: '站外入口 · URL 未配置' },
  { id: 'spider', kind: 'spider',  tone: '',      x: .36, y: .65, label: '学习资料库', sub: '点击浏览 GitHub 学习文件' }
]);

const STUDY = frozen([
  { id: 'n1', kind: 'note',    tone: 'study', x: .34, y: .44, label: '论空间记忆与目录', sub: '笔记 · 关联 6 篇', main: true },
  { id: 'n2', kind: 'note',    tone: 'study', x: .17, y: .24, label: '坐标冻结契约',     sub: '笔记 · 3 天前' },
  { id: 'n3', kind: 'note',    tone: 'study', x: .27, y: .14, label: '双链与块引用',     sub: '笔记' },
  { id: 'n4', kind: 'note',    tone: 'study', x: .55, y: .31, label: 'Hebbian 联想衰减', sub: '笔记 · 关联 4 篇' },
  { id: 'n5', kind: 'note',    tone: 'study', x: .22, y: .67, label: '光学景深笔记',     sub: '笔记' },
  { id: 'n6', kind: 'note',    tone: 'study', x: .53, y: .63, label: '反看板宣言',       sub: '笔记' },
  { id: 'n7', kind: 'phantom', tone: 'study', x: .39, y: .77, label: '虚影恒星',         sub: '待写笔记（同步进星表）' }
]);

const CODE = frozen([
  { id: 'p1', kind: 'project', tone: 'code', x: .68, y: .46, label: '项目占位 A', sub: 'GitHub 项目 · 占位数据' },
  { id: 'p2', kind: 'project', tone: 'code', x: .83, y: .67, label: '项目占位 B', sub: 'GitHub 项目 · 占位数据' },
  { id: 'p3', kind: 'project', tone: 'code', x: .56, y: .73, label: '项目占位 C', sub: 'GitHub 项目 · 占位数据' }
]);

export const SCENES: Record<SceneName, readonly EntityDef[]> =
  Object.freeze({ galaxy: GALAXY, study: STUDY, code: CODE });

export const SCENE_NAME: Record<SceneName, string> =
  Object.freeze({ galaxy: '银河层', study: '学习星系', code: '项目星系' });

/* ============================================================
   新笔记的坐标（v4 布局）
   —— 七颗种子恒星的位置是设计稿定的，写死不动。
   —— 新笔记不再挤在右下角网格里：用低差异序列（Halton）在整幅画面
      铺候选点，避开七星与彼此的最小距离，按 id 顺序依次落位。
   —— 分配结果写进 localStorage：一经分配永不变（真正的坐标冻结）。
      后续新增只往后取空位，已有星绝不会因为「谁的标题更长」而重排。
   ============================================================ */

const SLOT_KEY = 'vibedesk.entitySlots';
type SlotMap = Record<string, { x: number; y: number }>;

const readSlots = (): SlotMap => {
  try {
    const raw = JSON.parse(localStorage.getItem(SLOT_KEY) ?? '{}') as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as SlotMap;
  } catch { /* 坏数据当空 */ }
  return {};
};
const writeSlots = (m: SlotMap): void => {
  try { localStorage.setItem(SLOT_KEY, JSON.stringify(m)); } catch { /* 隐私模式忽略 */ }
};

const halton = (i: number, b: number): number => {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
};

const SEED_POINTS: readonly (readonly [number, number])[] = STUDY.map(e => [e.x, e.y]);
/** 横向按视觉比例加权：屏幕更宽，横向同样数值的间隔看起来更近 */
const spaced = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0]! - b[0]!) * 1.25, a[1]! - b[1]!);

const CANDIDATES: readonly (readonly [number, number])[] = (() => {
  const pts: [number, number][] = [];
  for (let i = 8; i < 600 && pts.length < 48; i++) {
    const x = .10 + halton(i, 2) * .80;
    const y = .11 + halton(i, 3) * .76;
    if (SEED_POINTS.some(p => spaced([x, y], p) < .145)) continue;
    if (pts.some(p => spaced([x, y], p) < .135)) continue;
    pts.push([x, y]);
  }
  return Object.freeze(pts);
})();

const BASE_IDS = new Set(STUDY.map(e => e.id));

const numOf = (id: string): number => {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.NaN;
};

let extra: readonly EntityDef[] = Object.freeze([]);
let studyList: readonly EntityDef[] = STUDY;

/* ============================================================
   实体内容覆盖（v3）
   —— 坐标、kind、tone、scene 永远留在上面那张冻结表里；
      数据库只覆盖「名字 / 副标题」这类内容字段。
      于是纪念册光门与项目卡能换成真实数据，而位置一寸都不动。
   ============================================================ */
let overrides: ReadonlyMap<string, { label: string; sub: string }> = new Map();

export function setEntityOverrides(
  rows: readonly { id: string; label?: string; sub?: string }[]
): void {
  overrides = new Map(rows.map(r => [r.id, { label: r.label ?? '', sub: r.sub ?? '' }]));
}

function withOverride(e: EntityDef): EntityDef {
  const o = overrides.get(e.id);
  if (!o) return e;
  return Object.freeze({
    ...e,
    label: o.label || e.label,
    sub: o.sub || e.sub
  });
}

/**
 * 把「不只是种子」的笔记登记成恒星。
 * 幂等：位置优先取 localStorage 里已冻结的分配，只有新 id 才取候选点。
 */
export function setExtraNotes(items: readonly { id: string; title: string }[]): void {
  const slots = readSlots();
  const taken = new Set(Object.values(slots).map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
  const sorted = [...items]
    .filter(it => !BASE_IDS.has(it.id))
    .sort((a, b) => {
      const na = numOf(a.id); const nb = numOf(b.id);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.id.localeCompare(b.id);
    });

  const out: EntityDef[] = [];
  let changed = false;
  for (const it of sorted) {
    let pos = slots[it.id];
    if (!pos) {
      const cand = CANDIDATES.find(([x, y]) => !taken.has(`${x.toFixed(3)},${y.toFixed(3)}`));
      pos = cand
        ? { x: cand[0], y: cand[1] }
        : { x: .88, y: .14 + (out.length % 10) * .07 };  // 48 个之后才可能走到
      slots[it.id] = pos;
      taken.add(`${pos.x.toFixed(3)},${pos.y.toFixed(3)}`);
      changed = true;
    }
    out.push(Object.freeze({
      id: it.id, kind: 'note' as const, tone: 'study',
      x: pos.x, y: pos.y, label: it.title || '无标题', sub: '笔记'
    }));
  }
  if (changed) writeSlots(slots);
  extra = Object.freeze(out);
  studyList = out.length ? Object.freeze([...STUDY, ...out]) : STUDY;
}

export const extraCount = (): number => extra.length;

/**
 * 被删除的星：种子笔记的坐标写死在设计稿里，删掉正文后它会从 entitiesOf 里退场。
 * 只记 id，不重排任何其它坐标 —— 契约 C1 依然成立。
 * 持久化到 localStorage：否则刷新后种子星会重新冒出来（正文已经没了）。
 * 只收种子 id —— 新笔记的 id 会被复用（n8 删了再建还是 n8），不能记仇。
 */
const HIDDEN_KEY = 'vibedesk.hiddenEntities';
const readHidden = (): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === 'string' && BASE_IDS.has(x));
  } catch { return []; }
};
const hidden = new Set<string>(readHidden());
const saveHidden = (): void => {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* 隐私模式忽略 */ }
};
export const isSeedId = (id: string): boolean => BASE_IDS.has(id);
export const hideEntity = (id: string): void => {
  if (!BASE_IDS.has(id)) return;
  hidden.add(id);
  saveHidden();
};

export const entitiesOf = (scene: SceneName): readonly EntityDef[] => {
  const base = scene === 'study'
    ? (hidden.size ? studyList.filter(e => !hidden.has(e.id)) : studyList)
    : SCENES[scene];
  return overrides.size ? Object.freeze(base.map(withOverride)) : base;
};

export function findEntity(id: string): { e: EntityDef; scene: SceneName } | null {
  for (const scene of Object.keys(SCENES) as SceneName[]) {
    const e = entitiesOf(scene).find(x => x.id === id);
    if (e) return { e, scene };
  }
  return null;
}

/** 设计稿给定的初始关联（P5.4 会由 Hebbian 权重接管粗细） */
export type Thread = readonly [string, string, number];

export const SEED_THREADS: readonly Thread[] = Object.freeze<Thread[]>([
  ['n1', 'n2', 2.2], ['n1', 'n3', 1.6], ['n1', 'n4', 1.9], ['n1', 'n5', 1.3], ['n1', 'n6', 1.1],
  ['n4', 'n3', .8], ['n4', 'n6', .8], ['n5', 'n2', .8], ['n5', 'n7', .7], ['n6', 'n7', .8]
]);
