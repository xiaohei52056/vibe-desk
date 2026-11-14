/**
 * 手动连线（唯一的关系真相）。
 *
 * 规则很简单：星图上的每一条线，都必须对应 links 表里的一条记录。
 * 正文里的 [[双链]] 只是文字，项目卡上的 tags 只是说明 ——
 * 两者都不再自动长出线来。要连线，就在星图上长按一颗星拖到另一颗。
 *
 * 一次性迁移：老数据里的「自动派生线」在首次升级时转成显式记录，
 * 这样已有的线不会凭空消失，但此后全部由用户自己管。
 */
import { notes, links, idOfTitle, patchNote } from './store';
import { linkKey, invalidateThreads, LINK } from './links';
import { parseLinks } from './parse';
import { putOne, delOne, metaGet, metaSet, type LinkRow } from '../storage/db';
import { addTombstone, clearTombstone, tombstoned } from '../storage/tombstones';
import { entityRows, entityTags } from '../storage/entityData';
import { putTieRemote, deleteTieRemote } from '../storage/remote';

export const TIE_EVENT = 'vibe:ties-changed';
const emit = (): void => { document.dispatchEvent(new CustomEvent(TIE_EVENT)); };

export const hasTie = (a: string, b: string): boolean => links.has(linkKey(a, b));

const isNote = (id: string): boolean => notes.has(id);
const isProject = (id: string): boolean =>
  entityRows().some(r => r.id === id && r.kind === 'project');

/** 只允许同层互连：笔记↔笔记、项目↔项目。跨层在星图上看不见，不做无效关系 */
export function linkablePair(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  return (isNote(a) && isNote(b)) || (isProject(a) && isProject(b));
}

/** 连接时把关系也写进源笔记正文，纯文本导出才带得走 */
async function writeBodyLink(from: string, to: string): Promise<void> {
  if (!isNote(from) || !isNote(to)) return;
  const title = notes.get(to)?.title?.trim();
  const cur = notes.get(from);
  if (!title || !cur) return;
  if (parseLinks(cur.body).includes(title)) return;   // 正文里本来就有，别重复写
  const line = `\n[[${title}]]`;
  await patchNote(from, { body: cur.body.replace(/\s+$/, '') + line });
}

/** 断开时只清掉我们插进去的那种「独占一行」的引用，不动用户原来的行内文字 */
async function stripBodyLink(a: string, b: string): Promise<void> {
  for (const [from, to] of [[a, b], [b, a]] as const) {
    if (!isNote(from) || !isNote(to)) continue;
    const title = notes.get(to)?.title?.trim();
    const cur = notes.get(from);
    if (!title || !cur) continue;
    const next = cur.body
      .split('\n')
      .filter(l => l.trim() !== `[[${title}]]`)
      .join('\n')
      .replace(/\s+$/, '');
    if (next !== cur.body) await patchNote(from, { body: next });
  }
}

export async function connectTie(from: string, to: string): Promise<boolean> {
  if (!linkablePair(from, to)) return false;
  const key = linkKey(from, to);
  if (links.has(key)) return false;
  const [a, b] = from < to ? [from, to] : [to, from];
  const row: LinkRow = { key, a, b, w: LINK.W0, lastWalkedAt: Date.now() };
  links.set(key, row);
  await putOne('links', row);
  await clearTombstone(key);
  await writeBodyLink(from, to);
  invalidateThreads();
  emit();
  void putTieRemote(row);       // 后端在线就立刻同步，离线不打扰
  return true;
}

export async function disconnectTie(from: string, to: string): Promise<boolean> {
  const key = linkKey(from, to);
  if (!links.has(key)) return false;
  links.delete(key);
  await delOne('links', key);
  await addTombstone(key);
  await stripBodyLink(from, to);
  invalidateThreads();
  emit();
  void deleteTieRemote(key);
  return true;
}

/** 老数据里由 tags 推导出来的项目对，只在迁移时用一次 */
function legacyTagPairs(): [string, string][] {
  const rows = entityRows().filter(r => r.kind === 'project');
  const out: [string, string][] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const ta = new Set(entityTags(rows[i]!.id));
      if (entityTags(rows[j]!.id).some(t => ta.has(t))) out.push([rows[i]!.id, rows[j]!.id]);
    }
  }
  return out;
}

const FLAG = 'vibedesk.tiesMigrated';

/**
 * 首次升级：把原先自动派生的线固化成显式记录。
 * 之后写 flag，不再重复 —— 用户断开的线不会被正文 / tags 悄悄长回来。
 */
export async function migrateAutoTies(): Promise<number> {
  if (await metaGet(FLAG)) return 0;
  // 实体配置还没到位（全新浏览器 + 后端没开）时先不落 flag，
  // 等下次启动拿到项目卡再把那几条线补齐
  if (!entityRows().length) return 0;
  const tombs = await tombstoned();
  const pairs: [string, string][] = [];

  // 正文 [[双链]] 派生过的线
  for (const n of notes.values()) {
    for (const title of parseLinks(n.body)) {
      const to = idOfTitle(title);
      if (to && to !== n.id) pairs.push([n.id, to]);
    }
  }
  // 项目共享标签派生过的线
  pairs.push(...legacyTagPairs());

  let added = 0;
  for (const [a, b] of pairs) {
    if (!linkablePair(a, b)) continue;
    const key = linkKey(a, b);
    if (links.has(key) || tombs.has(key)) continue;
    const [x, y] = a < b ? [a, b] : [b, a];
    const row: LinkRow = { key, a: x, b: y, w: LINK.W0, lastWalkedAt: Date.now() };
    links.set(key, row);
    await putOne('links', row);
    added++;
  }
  await metaSet(FLAG, Date.now());
  if (added) { invalidateThreads(); emit(); }
  return added;
}
