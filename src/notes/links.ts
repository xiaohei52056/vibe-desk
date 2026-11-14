/**
 * Hebbian 光丝（契约 C3 / C4）。
 *
 * 两条硬规则，写在这里而不是写在渲染里：
 *   C3 权重有下限 —— 久不走会变淡，但不会消失，也不会细到看不见；
 *   C4 权重只映射线宽与亮度 —— 不改坐标、不改星的大小、不改文字。
 *
 * 界面上永远不出现权重数字。它只表现成线的粗细与明暗，所以这里
 * 也不导出任何「排名」「总数」之类可以被拿去做仪表盘的东西。
 */
import { getState, setState } from '../core/state';
import { links, notes, onNotes } from './store';
import { putOne, type LinkRow } from '../storage/db';

const DAY = 86400000;

export const LINK = {
  /** 权重下限：久不走再淡也仍然可见 */
  FLOOR: 0.55,
  /** 每走过一次增加的权重 */
  GAIN: 0.55,
  /** 上限：防止某一对关联无限变粗 */
  CAP: 6,
  /** 半衰期：9 天不走衰减一半 */
  HALF_DAYS: 9,
  /** 未被记录过的关联的初始权重 */
  W0: 1,
  /** 走过之后短暂亮一下的时长 */
  PULSE: 1500
} as const;

/** 无向键：小的 id 在前。和存储层的 keyPath 必须一致 */
export const linkKey = (a: string, b: string): string => (a < b ? `${a}~${b}` : `${b}~${a}`);

/**
 * 当前强度 = 记录权重 × 时间衰减，且夹在 [FLOOR, CAP] 之间。
 * 衰减只在读取时算：存储里留的是「走过的原始重量」，
 * 这样久不打开也不会把历史抹掉。
 */
export function linkWeight(a: string, b: string): number {
  const rec = links.get(linkKey(a, b));
  if (!rec) return LINK.W0;
  const days = Math.max(0, (Date.now() - (rec.lastWalkedAt || 0)) / DAY);
  const decayed = (rec.w || LINK.W0) * Math.pow(0.5, days / LINK.HALF_DAYS);
  return Math.max(LINK.FLOOR, Math.min(LINK.CAP, decayed));
}

/**
 * 归一化到 0–1，走对数：线性会把 4.6 和 6.0 都压到最粗，高段失去区分度。
 * 这是原型里那条决策（d1）的结论，别改回线性。
 * 注意映射保留了下限的偏移：FLOOR 落在 0.28 而不是 0 —— 最淡的那条也该有
 * 1.1px 的可见宽度，否则「不消失」只是句口号。
 */
export function linkNorm(w: number): number {
  const span = Math.log(1 + LINK.CAP / LINK.FLOOR);
  return Math.max(0, Math.min(1, Math.log(1 + w / LINK.FLOOR) / span));
}

/* ============================================================
   关联集合 = links 表里的显式关系（只取两端都是笔记的那些）。
   正文 [[双链]] 只是文字，不再自动长线；项目之间的线由 projectLinks 读同一张表。
   要连线，在星图上长按一颗星拖到另一颗 —— 见 notes/ties.ts。
   ============================================================ */

let cache: readonly (readonly [string, string])[] | null = null;

function build(): readonly (readonly [string, string])[] {
  const seen = new Set<string>();
  const out: (readonly [string, string])[] = [];
  const push = (a: string, b: string): void => {
    if (!a || !b || a === b) return;
    if (!notes.has(a) || !notes.has(b)) return;
    const k = linkKey(a, b);
    if (seen.has(k)) return;
    seen.add(k);
    out.push([a, b] as const);
  };
  for (const l of links.values()) push(l.a, l.b);
  return Object.freeze(out);
}

export function threads(): readonly (readonly [string, string])[] {
  if (!cache) cache = build();
  return cache;
}

export const invalidateThreads = (): void => { cache = null; };

// 笔记增删会让「两端都在」这个条件变化；手动连线则显式调 invalidateThreads()
onNotes(() => { cache = null; });

/**
 * 走过一条关联：加权重、记时间、让它在星图上短暂亮一下。
 *
 * 只从「顺着引用跳过去」这一种动作触发 —— 点反链、点正文里的双链。
 * 用搜索跳过去不算：搜索是去找东西，不是在联想。
 * 注意：只给已经存在的显式关系加权，绝不因为点了正文里的 [[名字]] 就新建一条线。
 */
export function walkThread(from: string, to: string): void {
  if (!from || !to || from === to) return;
  if (!notes.has(from) || !notes.has(to)) return;

  const key = linkKey(from, to);
  const cur = links.get(key);
  if (!cur) return;
  const [a, b] = from < to ? [from, to] : [to, from];
  const next: LinkRow = {
    ...cur,
    a,
    b,
    w: Math.min(LINK.CAP, (cur.w || LINK.W0) + LINK.GAIN),
    lastWalkedAt: Date.now()
  };
  links.set(key, next);
  setState({ walked: { key, until: Date.now() + LINK.PULSE } });
  void putOne('links', next).catch(err => console.warn('[links] 权重落盘失败', err));
}

/** 星图用：正在亮的那条线（过了 1.5s 自动失效，不需要定时器） */
export function walkedKey(): string | null {
  const w = getState().walked;
  if (!w) return null;
  return Date.now() < w.until ? w.key : null;
}
