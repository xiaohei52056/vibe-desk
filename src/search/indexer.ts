/**
 * 内存倒排索引。
 *
 * 为什么不用 FlexSearch / Lunr：一千篇量级下，一个
 * `Map<term, Map<docId, weight>>` 就够用，而依赖的体积和「它到底怎么切词」
 * 这个黑箱都不划算 —— 中文切词出问题的时候，你必须能一眼看懂为什么这条没搜到。
 *
 * 切法：中文按 2-gram（「坐标冻结」→ 坐标 / 标冻 / 冻结），英文按词。
 * 两字以上才进索引，单字查询走线性扫 —— 只有这一种情况会绕过索引，
 * 而不给索引加一张单字表能省掉近一半内存。
 *
 * 打分：标题 ×6、标签 ×4、正文 ×1，再加一点时间衰减（最近动过的先浮上来）。
 * 严匹配（所有 2-gram 都在）为空时退一步做并集，避免用户少打一个字就零结果。
 */
import { notes } from '../notes/store';
import { countWords, excerpt, maturityOf, parseTags, relTime } from '../notes/parse';
import { decisions } from '../notes/decisions';

const CJK = /[\u3400-\u9fbf]/;
const WORD = /[\u3400-\u9fbf]+|[A-Za-z0-9][A-Za-z0-9_'-]*/g;

interface Doc {
  title: string;
  body: string;
  tags: string[];
  at: number;
}

export interface Hit {
  id: string;
  title: string;
  snippet: string;
  meta: string;
  /** 只在内部排序用，不显示 */
  score: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

const docs = new Map<string, Doc>();
const postings = new Map<string, Map<string, number>>();
const docTerms = new Map<string, string[]>();

/** 一段文字切成索引词。返回的数组允许有重复，删除时靠 set 无关紧要。 */
export function termsOf(text: string): string[] {
  const out: string[] = [];
  const s = text.toLowerCase();
  WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(s)) !== null) {
    const w = m[0];
    if (CJK.test(w.charAt(0))) {
      if (w.length < 2) continue;              // 单字不进索引
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    } else if (w.length >= 2) {
      out.push(w);
    }
  }
  return out;
}

function bump(term: string, id: string, weight: number): void {
  let p = postings.get(term);
  if (!p) { p = new Map(); postings.set(term, p); }
  p.set(id, (p.get(id) ?? 0) + weight);
}

function indexDoc(id: string, doc: Doc): void {
  const seen: string[] = [];
  const push = (term: string, weight: number): void => { seen.push(term); bump(term, id, weight); };
  for (const t of termsOf(doc.title)) push(t, 6);
  for (const tag of doc.tags) for (const t of termsOf(tag)) push(t, 4);
  for (const t of termsOf(doc.body)) push(t, 1);
  docTerms.set(id, seen);
  docs.set(id, doc);
}

function dropDoc(id: string): void {
  for (const term of docTerms.get(id) ?? []) {
    const p = postings.get(term);
    if (!p) continue;
    p.delete(id);
    if (!p.size) postings.delete(term);
  }
  docTerms.delete(id);
  docs.delete(id);
}

/**
 * 增量同步：只重建改动过的那几篇。
 * 每次落盘都全量重建，在千篇量级上会拖慢输入（500ms 一存），这里按 updatedAt 判断。
 */
export function syncIndex(): void {
  for (const id of [...docs.keys()]) if (!notes.has(id)) dropDoc(id);
  for (const n of notes.values()) {
    const cur = docs.get(n.id);
    if (cur && cur.at === n.updatedAt) continue;
    if (cur) dropDoc(n.id);
    indexDoc(n.id, { title: n.title, body: n.body, tags: parseTags(n.body), at: n.updatedAt });
  }
}

export const indexSize = (): number => docs.size;

function recency(at: number): number {
  const days = (Date.now() - at) / 86400000;
  return 2 / (1 + days / 14);                 // 两周内还有一点分量，之后趋近 0
}

function metaOf(doc: Doc): string {
  return `${maturityOf(doc.body)} · ${countWords(doc.body)} 字 · ${relTime(doc.at)}`;
}

/** 命中附近的原句：搜完之后要能立刻判断「是不是我要的那篇」 */
function snippetOf(body: string, words: readonly string[]): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\(asset:[^)]*\)/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    .replace(/[*_>#^]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = plain.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return excerpt(body, 60);
  const start = Math.max(0, at - 16);
  // 从句子中间切进去时，开头常常落在标点上；直接显示「…。 参见」很像 bug
  const cut = plain.slice(start, start + 58).replace(/^[。，、；：！？…\s]+/, '').trim();
  return (start > 0 ? '…' : '') + cut + (start + 58 < plain.length ? '…' : '');
}

function intersect(tokens: readonly string[]): Set<string> {
  let acc: Set<string> | null = null;
  for (const t of tokens) {
    const p = postings.get(t);
    const cur = new Set(p ? p.keys() : []);
    if (!acc) acc = cur;
    else for (const id of [...acc]) if (!cur.has(id)) acc.delete(id);
    if (acc.size === 0) return acc;
  }
  return acc ?? new Set();
}

function union(tokens: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    const p = postings.get(t);
    if (p) for (const id of p.keys()) out.add(id);
  }
  return out;
}

function hitOf(id: string, tokens: readonly string[], words: readonly string[]): Hit | null {
  const doc = docs.get(id);
  if (!doc) return null;
  let score = recency(doc.at);
  for (const t of tokens) score += postings.get(t)?.get(id) ?? 0;
  return {
    id,
    title: doc.title || '无标题',
    snippet: snippetOf(doc.body, words),
    meta: metaOf(doc),
    score
  };
}

const byScore = (a: Hit, b: Hit): number => b.score - a.score || a.title.localeCompare(b.title);

export function searchNotes(q: string): Hit[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const words = query.split(/\s+/).filter(Boolean);
  const tokens = termsOf(query);

  // 单字 / 单字母：索引里没有，直接扫。千篇量级下这一步是毫秒级
  if (!tokens.length) {
    const out: Hit[] = [];
    for (const [id, doc] of docs) {
      const hay = `${doc.title}\n${doc.body}`.toLowerCase();
      if (!hay.includes(query)) continue;
      const h = hitOf(id, [], words);
      if (h) out.push(h);
    }
    return out.sort(byScore).slice(0, 12);
  }

  const exact = intersect(tokens);
  const ids = exact.size ? exact : union(tokens);
  const out: Hit[] = [];
  for (const id of ids) {
    const h = hitOf(id, tokens, words);
    if (h) out.push(h);
  }
  return out.sort(byScore).slice(0, 12);
}

/** `#标签` 查询：按标签精确匹配，按最近改动排序 */
export function searchByTag(raw: string): Hit[] {
  const tag = raw.replace(/^#/, '').trim().toLowerCase();
  if (!tag) return [];
  const out: Hit[] = [];
  for (const [id, doc] of docs) {
    if (!doc.tags.some(t => t.toLowerCase() === tag)) continue;
    const h = hitOf(id, [], [tag]);
    if (h) out.push(h);
  }
  return out.sort((a, b) => (docs.get(b.id)?.at ?? 0) - (docs.get(a.id)?.at ?? 0)).slice(0, 12);
}

/* ============================================================
   决策也进搜索。
   —— 搜「当初为什么」比搜标题更接近真实需求，所以问题、选项、
      选择、理由四段全进匹配范围；
   —— 决策数量是「几十条」量级，线性扫足够，硬塞进倒排反而是
      给自己加一层「索引和记录不同步」的负担；
   —— 命中一条决策 = 打开它所在的笔记并就地展开那一条，
      不做「决策列表页」—— 那会立刻长出筛选与统计（C7）。
   ============================================================ */

export interface DecHit {
  id: string;
  noteId: string;
  title: string;
  snippet: string;
  meta: string;
}

export function searchDecisions(q: string): DecHit[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: DecHit[] = [];
  for (const d of decisions.values()) {
    const hay = `${d.q}\n${d.opts.join(' ')}\n${d.pick}\n${d.why}`.toLowerCase();
    if (!words.every(w => hay.includes(w))) continue;
    out.push({
      id: d.id,
      noteId: d.noteId,
      title: d.q,
      snippet: (d.pick ? `选了 ${d.pick}` : '') + (d.why ? ` · ${d.why}` : ''),
      meta: `决策 · ${relTime(d.at)}`
    });
  }
  return out.sort((a, b) => (decisions.get(b.id)?.at ?? 0) - (decisions.get(a.id)?.at ?? 0)).slice(0, 6);
}

/** 空查询时的落点：最近动过的几篇，不是「全部笔记列表」 */export function recentNotes(limit = 5): Hit[] {
  return [...docs.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, limit)
    .map(([id, doc]) => ({
      id,
      title: doc.title || '无标题',
      snippet: excerpt(doc.body, 56),
      meta: metaOf(doc),
      score: 0
    }));
}

/** 空查询时的标签条：按出现频次取前几个，点一下就按它筛 */
export function topTags(limit = 6): TagCount[] {
  const freq = new Map<string, number>();
  for (const doc of docs.values()) {
    for (const t of doc.tags) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}
