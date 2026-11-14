/**
 * 决策日志（契约 C7）。
 *
 * 一条记录 = 问题 / 选项 / 选了哪个 / 理由 / 日期，挂在笔记底部。
 * 刻意不做的事：不做独立页面、不做列表页、不做筛选、不做统计、不做饼图。
 * 它只是一条脚注 —— 让你半年后还能回答「当初为什么这么写」。
 *
 * 全文可搜是它的必要条件：搜「当初为什么」比搜标题更接近真实需求，
 * 所以索引层会把决策本身也吃进去（见 search/indexer.ts）。
 */
import { getAll, putOne, delOne, type DecisionRow } from '../storage/db';

export const decisions = new Map<string, DecisionRow>();

type Listener = () => void;
const listeners = new Set<Listener>();

export const onDecisions = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const notify = (): void => { for (const fn of listeners) fn(); };

export async function initDecisions(): Promise<void> {
  decisions.clear();
  for (const d of await getAll<DecisionRow>('decisions')) decisions.set(d.id, d);
  notify();
}

/** 某一篇的决策，最近的在前 */
export const decisionsFor = (noteId: string): DecisionRow[] =>
  [...decisions.values()]
    .filter(d => d.noteId === noteId)
    .sort((a, b) => b.at - a.at);

export const latestOf = (noteId: string): DecisionRow | undefined => decisionsFor(noteId)[0];

export interface DecisionInput {
  noteId: string;
  q: string;
  opts: string[];
  pick: string;
  why: string;
}

export async function addDecision(input: DecisionInput): Promise<DecisionRow> {
  const opts = input.opts.map(s => s.trim()).filter(Boolean);
  const row: DecisionRow = {
    id: `d${Date.now().toString(36)}`,
    noteId: input.noteId,
    q: input.q.trim(),
    opts,
    pick: input.pick.trim() || opts[0] || '',
    why: input.why.trim(),
    at: Date.now()
  };
  decisions.set(row.id, row);
  notify();
  await putOne('decisions', row);
  return row;
}

/** 笔记被删：挂在它下面的决策记录一起走（不留孤儿数据） */
export async function removeDecisionsFor(noteId: string): Promise<void> {
  let hit = false;
  for (const d of [...decisions.values()]) {
    if (d.noteId !== noteId) continue;
    decisions.delete(d.id);
    hit = true;
    await delOne('decisions', d.id);
  }
  if (hit) notify();
}

export async function removeDecision(id: string): Promise<void> {
  decisions.delete(id);
  notify();
  await delOne('decisions', id);
}

/** 正文里的选项串：中文逗号、顿号、英文逗号都算分隔 */
export const splitOpts = (raw: string): string[] =>
  raw.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
