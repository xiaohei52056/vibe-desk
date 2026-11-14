/**
 * 笔记内存缓存。
 *
 * 为什么要有这一层：星表、站体、搜索、反链都要读笔记，如果各自去开
 * IndexedDB 事务，会散出一堆重复查询，而且写入后各处还得手动刷新。
 * 这里做唯一入口：内存 Map 是真相，DB 是它的持久化副本。
 *
 * 量级判断：一千篇笔记的正文全放内存约 3–8 MB，可以接受。
 * 真正需要分页的时候再换，现在过早优化只会增加状态同步的难度。
 */
import {
  ensureSeeded, getAll, loadNotes, putOne, delOne, type Note, type LinkRow, type SeedReport
} from '../storage/db';
import { parseLinks } from './parse';

export const notes = new Map<string, Note>();
export const links = new Map<string, LinkRow>();

let titleIndex = new Map<string, string>();   // 标题 → 笔记 id，反链靠它
let report: SeedReport | null = null;
let ready = false;

type Listener = () => void;
const listeners = new Set<Listener>();

export const onNotes = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const notify = (): void => { for (const fn of listeners) fn(); };

export const isReady = (): boolean => ready;
export const seedReport = (): SeedReport | null => report;

function rebuildTitleIndex(): void {
  titleIndex = new Map();
  for (const n of notes.values()) titleIndex.set(n.title, n.id);
}

export async function initNotes(): Promise<SeedReport> {
  report = await ensureSeeded();
  const map = await loadNotes();
  notes.clear();
  for (const [id, n] of map) notes.set(id, n);
  const ls = await getAll<LinkRow>('links');
  links.clear();
  for (const l of ls) links.set(l.key, l);
  rebuildTitleIndex();
  ready = true;
  notify();
  return report;
}

export const noteOf = (id: string): Note | undefined => notes.get(id);

export const idOfTitle = (title: string): string | undefined => titleIndex.get(title.trim());

/** 按标题找笔记；标题改了要重建索引，由 patchNote 负责 */
export function resolve(target: string): Note | undefined {
  const id = titleIndex.get(target.trim());
  return id ? notes.get(id) : undefined;
}

/** 本地改名不换 id：坐标契约靠 id，标题只是它的名字 */
export async function patchNote(id: string, patch: Partial<Pick<Note, 'title' | 'body'>>): Promise<Note | undefined> {
  const cur = notes.get(id);
  if (!cur) return undefined;
  const next: Note = {
    ...cur,
    ...patch,
    id,
    updatedAt: Date.now()
  };
  notes.set(id, next);
  rebuildTitleIndex();
  await putOne('notes', next);
  notify();
  return next;
}

/** 新建笔记：id 用「最大序号 +1」，这样恒星坐标能沿同一个规律长出来 */
export function nextNoteId(): string {
  let max = 0;
  for (const id of notes.keys()) {
    const m = /^n(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `n${max + 1}`;
}

export async function createNote(title: string, body = ''): Promise<Note> {
  const now = Date.now();
  const note: Note = { id: nextNoteId(), title, body, createdAt: now, updatedAt: now };
  notes.set(note.id, note);
  rebuildTitleIndex();
  await putOne('notes', note);
  notify();
  return note;
}

/** 删除一篇笔记：内存 + 持久化 + 以它为端点的关联光丝一起走 */
export async function deleteNote(id: string): Promise<void> {
  if (!notes.has(id)) return;
  notes.delete(id);
  rebuildTitleIndex();
  await delOne('notes', id);
  // 光丝是两端的关联，一端没了就是孤儿：不删掉，星图上会留一条连向虚空的线
  for (const [k, l] of [...links]) {
    if (l.a !== id && l.b !== id) continue;
    links.delete(k);
    await delOne('links', k);
  }
  notify();
}

export interface BacklinkHit { id: string; title: string; count: number; }

/** 反链：谁的正文里写了 [[本文标题]]。按出现次数降序，最多 5 条。 */
export function backlinksOf(id: string, limit = 5): BacklinkHit[] {
  const me = notes.get(id);
  if (!me) return [];
  const hits: BacklinkHit[] = [];
  for (const n of notes.values()) {
    if (n.id === id) continue;
    const count = parseLinks(n.body).filter(t => t === me.title).length;
    if (count > 0) hits.push({ id: n.id, title: n.title, count });
  }
  hits.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  return hits.slice(0, limit);
}

/** 出链：本文提到的、且确实存在的笔记 */
export function outlinksOf(id: string): { title: string; id: string | null }[] {
  const me = notes.get(id);
  if (!me) return [];
  return parseLinks(me.body).map(t => ({ title: t, id: titleIndex.get(t) ?? null }));
}
