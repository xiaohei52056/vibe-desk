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
  { id: 'code',   kind: 'galaxy',  tone: 'code',  x: .73, y: .70, label: '代码星系', sub: 'Code Galaxy · Enter 进入',  scene: 'code' },
  { id: 'core',   kind: 'core',    tone: 'core',  x: .50, y: .47, label: 'AI 星核',  sub: '预留位 · v2 接入' },
  { id: 'gate',   kind: 'gate',    tone: 'gate',  x: .86, y: .19, label: '纪念册',   sub: '站外入口 · URL 未配置' },
  { id: 'spider', kind: 'spider',  tone: '',      x: .36, y: .65, label: '星云蛛',   sub: '注意力化身' }
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
  Object.freeze({ galaxy: '银河层', study: '学习星系', code: '代码星系' });

/* ============================================================
   新笔记的坐标
   —— 七颗种子恒星的位置是设计稿定的，写死在上面。
   —— 之后新建的笔记不在设计稿里，但坐标契约（C1）照样要守：
      位置由 id 决定、一经分配永不变、绝不因为「谁的标题更长」而重排。
   —— 做法是右下角一块固定的网格（4×4），按 id 序号取格；
      冲突就顺延一格。序号来自 id 本身，所以重开页面也落在同一格。
   ============================================================ */

const SLOTS: readonly (readonly [number, number])[] = Object.freeze([
  [.62, .48], [.69, .48], [.76, .48], [.83, .48],
  [.62, .60], [.69, .60], [.76, .60], [.83, .60],
  [.62, .72], [.69, .72], [.76, .72], [.83, .72],
  [.62, .84], [.69, .84], [.76, .84], [.83, .84]
].map(s => Object.freeze(s) as unknown as readonly [number, number]));

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

function allocSlot(id: string, used: Set<string>): { x: number; y: number } {
  const n = numOf(id);
  const start = Number.isFinite(n) ? Math.max(0, n - 8) % SLOTS.length : 0;
  for (let i = 0; i < SLOTS.length; i++) {
    const slot = SLOTS[(start + i) % SLOTS.length]!;
    const key = `${slot[0].toFixed(3)},${slot[1].toFixed(3)}`;
    if (used.has(key)) continue;
    used.add(key);
    return { x: slot[0], y: slot[1] };
  }
  // 第十六颗之后：在起始格外圈错开。仍然只由 id 决定，不会漂移
  const base = SLOTS[start]!;
  const ring = 1 + Math.floor((Number.isFinite(n) ? n - 8 : 0) / SLOTS.length);
  return { x: Math.min(.90, base[0] + .008 * ring), y: Math.min(.92, base[1] + .010 * ring) };
}

/**
 * 把「不只是种子」的笔记登记成恒星。
 * 幂等：已经分配过的实体原样保留，只更新标签文字 —— 位置绝不重算。
 */
export function setExtraNotes(items: readonly { id: string; title: string }[]): void {
  const prev = new Map(extra.map(e => [e.id, e]));
  const used = new Set(extra.map(e => `${e.x.toFixed(3)},${e.y.toFixed(3)}`));
  const sorted = [...items]
    .filter(it => !BASE_IDS.has(it.id))
    .sort((a, b) => {
      const na = numOf(a.id); const nb = numOf(b.id);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.id.localeCompare(b.id);
    });

  const out: EntityDef[] = [];
  for (const it of sorted) {
    const cur = prev.get(it.id);
    if (cur) {
      out.push(Object.freeze({ ...cur, label: it.title || cur.label }));
      continue;
    }
    const pos = allocSlot(it.id, used);
    out.push(Object.freeze({
      id: it.id, kind: 'note' as const, tone: 'study',
      x: pos.x, y: pos.y, label: it.title || '无标题', sub: '笔记'
    }));
  }
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
