/**
 * 数据出入口：一份 JSON，进得去也出得来。
 *
 * 三条原则：
 *   1. 导出必须是人能读的：字段名就是库里那张表的名字，不加密、不压缩。
 *      唯一的例外是 assets —— 图片只能以 base64 进 JSON，其余全都可读。
 *   2. 导入是替换，不是合并：合并需要解决「同 id 不同内容谁赢」，那是一个版本系统该干的事。
 *      替换至少是可预期的 —— 所以导入前必须先导出一次，界面上也这么提示。
 *   3. v1 的旧文件必须还能读：没有 assets 字段就当空数组，不因为升级把人挡在门外。
 */
import {
  clearStore, getAll, putOne,
  type DecisionRow, type EntityRow, type LinkRow, type Note, type ReviewRow
} from './db';
import { allAssets, type AssetRow } from '../notes/images';

/** 图片在 JSON 里的形态：data 为 base64（不带 data: 前缀） */
export interface AssetPack {
  id: string;
  mime: string;
  at: number;
  w: number;
  h: number;
  data: string;
}

export interface Bundle {
  app: 'vibe-desk';
  /** v3：附带光门 / 项目卡配置；v1/v2 文件照样能读 */
  version: 3;
  at: number;
  notes: Note[];
  links: LinkRow[];
  review: ReviewRow[];
  decisions: DecisionRow[];
  assets: AssetPack[];
  entities: EntityRow[];
}

async function blobToB64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64ToBlob(data: string, mime: string): Blob {
  const bin = atob(data);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

export async function buildBundle(): Promise<Bundle> {
  const assets: AssetPack[] = [];
  for (const a of await allAssets()) {
    assets.push({ id: a.id, mime: a.mime, at: a.at, w: a.w, h: a.h, data: await blobToB64(a.blob) });
  }
  return {
    app: 'vibe-desk',
    version: 3,
    at: Date.now(),
    notes: await getAll<Note>('notes'),
    links: await getAll<LinkRow>('links'),
    review: await getAll<ReviewRow>('review'),
    decisions: await getAll<DecisionRow>('decisions'),
    assets,
    entities: await getAll<EntityRow>('entities')
  };
}

export function bundleName(at = Date.now()): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `vibe-desk-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

export function downloadBundle(bundle: Bundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = bundleName(bundle.at);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器拿不到文件，给两秒
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

/** 解析与兜底：宁可丢一条坏记录，也不要因为一个字段类型不对整份导入失败 */
export function parseBundle(text: string): Bundle {
  const raw = JSON.parse(text) as Partial<Bundle> & { notes?: unknown };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.notes)) {
    throw new Error('不是 VIBE DESK 的导出文件');
  }
  const at = num(raw.at, Date.now());
  const notes: Note[] = (raw.notes as unknown[]).map((n, i) => {
    const o = n as Partial<Note>;
    return {
      id: str(o.id) || `n${i + 1}`,
      title: str(o.title) || '无标题',
      body: str(o.body),
      createdAt: num(o.createdAt, at),
      updatedAt: num(o.updatedAt, at)
    };
  }).filter(n => n.id);

  const links: LinkRow[] = ((raw.links ?? []) as unknown[]).map(l => {
    const o = l as Partial<LinkRow>;
    const a = str(o.a);
    const b = str(o.b);
    if (!a || !b) return null;
    const [x, y] = a < b ? [a, b] : [b, a];
    return {
      key: `${x}~${y}`, a: x, b: y,
      w: num(o.w, 1), lastWalkedAt: num(o.lastWalkedAt, 0)
    };
  }).filter((l): l is LinkRow => !!l);

  const review: ReviewRow[] = ((raw.review ?? []) as unknown[]).map(r => {
    const o = r as Partial<ReviewRow>;
    const noteId = str(o.noteId);
    if (!noteId) return null;
    return { noteId, dueAt: num(o.dueAt, at), lastAt: num(o.lastAt, 0), iv: num(o.iv, 4) };
  }).filter((r): r is ReviewRow => !!r);

  const decisions: DecisionRow[] = ((raw.decisions ?? []) as unknown[]).map(d => {
    const o = d as Partial<DecisionRow>;
    const q = str(o.q);
    if (!q) return null;
    return {
      id: str(o.id) || `d${Math.random().toString(36).slice(2, 8)}`,
      noteId: str(o.noteId),
      q,
      opts: Array.isArray(o.opts) ? o.opts.filter((x): x is string => typeof x === 'string') : [],
      pick: str(o.pick),
      why: str(o.why),
      at: num(o.at, at)
    };
  }).filter((d): d is DecisionRow => !!d);

  // v1 文件没有 assets 字段：当作空数组，旧备份照样能进来
  const assets: AssetPack[] = ((raw.assets ?? []) as unknown[]).map(a => {
    const o = a as Partial<AssetPack>;
    const id = str(o.id);
    const data = str(o.data);
    if (!id || !data) return null;
    return {
      id,
      mime: str(o.mime) || 'image/png',
      at: num(o.at, at),
      w: num(o.w, 0),
      h: num(o.h, 0),
      data
    };
  }).filter((a): a is AssetPack => !!a);

  // v1/v2 文件没有 entities 字段：当作空数组，旧备份照样能进来
  const entities: EntityRow[] = ((raw.entities ?? []) as unknown[]).map(x => {
    const o = x as Partial<EntityRow>;
    const id = str(o.id);
    if (!id) return null;
    return {
      id,
      kind: (['gate', 'project', 'core', 'spider'] as const).includes(o.kind as EntityRow['kind'])
        ? (o.kind as EntityRow['kind']) : 'project',
      label: str(o.label),
      sub: str(o.sub),
      url: str(o.url),
      detail: str(o.detail),
      updatedAt: num(o.updatedAt, at)
    };
  }).filter((x): x is EntityRow => !!x);

  return { app: 'vibe-desk', version: 3, at, notes, links, review, decisions, assets, entities };
}

/** 替换式导入：先清空六张表，再逐条写入 */
export async function applyBundle(bundle: Bundle): Promise<Bundle> {
  for (const store of ['notes', 'links', 'review', 'decisions', 'assets', 'entities'] as const) {
    await clearStore(store);
  }
  for (const n of bundle.notes) await putOne('notes', n);
  for (const l of bundle.links) await putOne('links', l);
  for (const r of bundle.review) await putOne('review', r);
  for (const d of bundle.decisions) await putOne('decisions', d);
  for (const a of bundle.assets ?? []) {
    const row: AssetRow = {
      id: a.id,
      blob: b64ToBlob(a.data, a.mime),
      mime: a.mime,
      w: a.w,
      h: a.h,
      at: a.at
    };
    await putOne('assets', row);
  }
  for (const e of bundle.entities ?? []) await putOne('entities', e);
  return bundle;
}
