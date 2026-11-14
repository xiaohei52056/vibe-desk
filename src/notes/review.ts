/**
 * 该回看（契约 C5 / C6）。
 *
 * 它不是打卡系统，所以这一层刻意只做三件事：
 *   1. 算出「哪几颗星该冒出来了」，最多三颗（C5）；
 *   2. 从笔记自己身上挖一道题 —— 一句你自己的话，挖掉一个小句；
 *   3. 答完推后间隔，然后什么都不留。
 *
 * 三处不妥协：
 *   · 题目挖不干净（掺着代码、双链、记号）就不催 —— 宁可少提一条，也不出烂题；
 *   · 空笔记、虚影恒星不催 —— 没有正文就没有可回看的东西；
 *   · 任何地方都不出现数字（C6）：没有今日待办、没有连续天数、没有完成率。
 */
import { noteOf, notes } from './store';
import { getAll, putOne, delOne, type ReviewRow } from '../storage/db';

const DAY = 86400000;

export const RCL = {
  /** 星图上最多同时亮几处刻度（多了就变成待办清单） */
  MAX: 3,
  /** 初次静置天数 */
  FIRST: 4,
  /** 「还记得」首次推后：约一周 */
  AGAIN: 7,
  /** 「有点模糊」：三天后再见 */
  FUZZY: 3,
  /** 「忘了」：明天重来 */
  LOST: 1,
  /** 「还记得」之后的放大倍数 */
  GROW: 2,
  /** 间隔上限：再熟的东西也该偶尔露一面 */
  CAP: 45
} as const;

export type RecallAnswer = 'ok' | 'fuzzy' | 'lost';

const rows = new Map<string, ReviewRow>();

type Listener = () => void;
const listeners = new Set<Listener>();

export const onReview = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const notify = (): void => { for (const fn of listeners) fn(); };

export async function initReview(): Promise<void> {
  rows.clear();
  for (const r of await getAll<ReviewRow>('review')) rows.set(r.noteId, r);
}

/** 笔记被删：它的回看记录一并清掉 */
export async function dropReview(noteId: string): Promise<void> {
  if (!rows.delete(noteId)) return;
  await delOne('review', noteId);
}

/** 从未回看过的笔记：从最后一次落笔算起，静置几天才浮上来 */
export function reviewOf(id: string): ReviewRow {
  const cur = rows.get(id);
  if (cur && typeof cur.dueAt === 'number') return cur;
  const n = noteOf(id);
  const base = n?.updatedAt || n?.createdAt || Date.now();
  return { noteId: id, dueAt: base + RCL.FIRST * DAY, lastAt: 0, iv: RCL.FIRST };
}

/* ---------------- 挖空：从笔记自己的句子里长出题目 ---------------- */

/** 引文截断：优先按小句边界切，宁可短一点也不腰斩在词中间 */
function clipLead(t: string, max: number): string {
  const s = (t || '').replace(/\s+$/, '');
  if (s.length <= max) return s;
  const segs = s.split(/([，、；：])/);
  let out = '';
  for (let i = segs.length - 1; i >= 0; i--) {
    if ((out + segs[i]).length > max && out) break;
    out = segs[i] + out;
  }
  return out.replace(/^[，、；：]/, '');
}

function clipTail(t: string, max: number): string {
  const s = (t || '').trim();
  if (s.length <= max) return s;
  const segs = s.split(/([，、；：])/);
  let out = '';
  for (let i = 0; i < segs.length; i++) {
    if ((out + segs[i]).length > max && out) break;
    out += segs[i];
  }
  return out.replace(/[，、；：]$/, '');
}

export interface RecallQuestion {
  /** 挖空前的半句（可空） */
  lead: string;
  /** 被挖掉的那一小句 —— 不显示，只用来判定题目是否干净 */
  blank: string;
  /** 挖空后的半句（可空） */
  post?: string;
}

export function recallQuestion(id: string): RecallQuestion | null {
  const body = noteOf(id)?.body ?? '';
  if (!body.trim()) return null;

  // 优先挖你自己画了加粗的那句
  const bold = /\*\*([^*\n]{2,20})\*\*/.exec(body);
  if (bold) {
    const at = bold.index;
    const ls = body.lastIndexOf('\n', at) + 1;
    let le = body.indexOf('\n', at);
    if (le < 0) le = body.length;
    const line = body.slice(ls, le);
    const pre = (line.slice(0, at - ls) || '').replace(/^[>\-\s]+/, '').trim();
    const post = (line.slice(at - ls + bold[0].length) || '').replace(/[。！？，\s]+$/, '').trim();
    if (pre.length >= 10) return { lead: clipLead(pre, 24), blank: bold[1] };
    if (pre && post.length >= 6) return { lead: pre, blank: bold[1], post: clipTail(post, 18) };
    if (!pre && post.length >= 6) return { lead: '', blank: bold[1], post: clipTail(post, 18) };

    // 整行都很短：往上退一句做语境
    const before = body.slice(0, at);
    let lead = (before.split('\n').pop() || '').replace(/^[>\-\s]+/, '');
    if (lead.trim().length < 10) {
      const rest = before.replace(/\s+$/, '');
      const lastLine = rest.split('\n').pop() || '';
      const up = rest.slice(0, rest.length - lastLine.length)
        .split(/[。！？\n]/).filter(x => x.trim()).pop() || '';
      if (up.trim().length >= 10) lead = up.trim();
    }
    return { lead: clipLead(lead, 24), blank: bold[1] };
  }

  // 否则取第一段里能干净切开的一句，挖掉最后一个小句
  const para = body.split('\n').map(l => l.trim())
    .find(l => l && !/^[#>`\-]/.test(l) && !l.includes('```') && !l.includes('`')
      && !l.includes('[[') && l.length > 18);
  if (!para) return null;
  const s = para.split(/[。！？]/).filter(x => x.trim().length > 14)[0];
  if (!s) return null;
  const parts = s.split(/[，、；：]/);
  const tail = parts[parts.length - 1] ?? '';
  if (parts.length > 1 && tail.length >= 4 && tail.length <= 16) {
    return { lead: clipLead(s.slice(0, s.length - tail.length - 1), 26), blank: tail };
  }
  return null;
}

/* ---------------- 谁该冒出来 ---------------- */

/**
 * 最多三颗，最久没回看的先浮上来。
 * 注意：这里返回的是「星图上可以点亮的那些」，不是一个待办队列 ——
 * 它不会累加，也不会因为你不理它而变得更红。
 */
export function dueList(): string[] {
  const now = Date.now();
  const arr: { id: string; due: number }[] = [];
  const seen = new Set<string>();
  // 遍历的是「已经存在的笔记」：有正文、且能挖出干净句子
  for (const id of notes.keys()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const n = noteOf(id);
    if (!n || !n.body.trim()) continue;
    if (!recallQuestion(id)) continue;
    const r = reviewOf(id);
    if (r.dueAt <= now) arr.push({ id, due: r.dueAt });
  }
  arr.sort((a, b) => a.due - b.due);
  return arr.slice(0, RCL.MAX).map(x => x.id);
}

/** 延后多久只看你刚才那句话怎么答的，不看别的 */
export function nextInterval(prev: number, kind: RecallAnswer): number {
  if (kind === 'fuzzy') return RCL.FUZZY;
  if (kind === 'lost') return RCL.LOST;
  return prev <= RCL.FIRST ? RCL.AGAIN : Math.min(RCL.CAP, prev * RCL.GROW);
}

/** 答完就散：落一个 dueAt，然后什么都不留（没有 +1，没有「已记录」） */
export async function answerRecall(id: string, kind: RecallAnswer): Promise<void> {
  const prev = rows.get(id)?.iv ?? RCL.FIRST;
  const iv = nextInterval(prev, kind);
  const now = Date.now();
  const row: ReviewRow = { noteId: id, dueAt: now + iv * DAY, lastAt: now, iv };
  rows.set(id, row);
  notify();
  await putOne('review', row);
}
