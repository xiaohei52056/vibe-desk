/**
 * 云端同步：Spring Boot 后端（backend/，默认 localhost:8080）。
 *
 * 三种走法，同一份 Bundle：文件导出/导入、手动云端拉取/推送、启动自动同步。
 *
 * 启动自动同步（autoSyncFromCloud）是默认行为，两条规矩：
 *   1. **合并，不替换**：云端有而本地没有的补进来；同 id 按 updatedAt 新者胜；
 *      本地独有的绝不删除。所以云端数据会自动出现，用户自己写的东西也不会被冲掉。
 *   2. **失败静默**：后端没启动、页面是静态部署、网络不通，都只当离线处理 ——
 *      不弹「云端不可达」打断阅读。
 *
 * 地址兼容：优先走同源 /api（Vite dev 有代理）；拿不到就直连 localhost:8080，
 * 这样静态构建版、别的端口打开时也能连到本机后端。
 */
import {
  getAll, putOne,
  type DecisionRow, type EntityRow, type LinkRow, type Note, type ReviewRow
} from './db';
import type { AssetRow } from '../notes/images';
import { applyBundle, buildBundle, type AssetPack, type Bundle } from './transfer';
import { tombstoned } from './tombstones';

const API_BASES = ['/api', 'http://localhost:8080/api'];
const API_TIMEOUT = 2500;
const SYNC_PATH = '/sync/bundle';
const HEALTH_PATH = '/health';

export interface SyncSummary {
  notes: number;
  links: number;
  review: number;
  decisions: number;
  assets: number;
  entities: number;
}

export interface CloudHealth {
  ok: boolean;
  notes: number;
  assets: number;
}

export interface AutoSyncReport {
  ok: boolean;
  /** 从云端补进来的笔记数 */
  added: number;
  /** 云端更新、覆盖了本地旧版的笔记数 */
  updated: number;
  reason?: string;
}

/** 依次尝试基址；GET 失败就换下一个，POST 不重试（避免写两次） */
async function apiFetch(path: string, init: RequestInit = {}, retryOnError = true): Promise<Response> {
  let last: unknown = null;
  for (const base of API_BASES) {
    try {
      const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(API_TIMEOUT) });
      if (res.ok || !retryOnError) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw last ?? new Error('后端不可达');
}

/** 后端在不在：只给调试/手动命令用，自动流程不依赖它 */
export async function cloudHealth(): Promise<CloudHealth> {
  const res = await apiFetch(HEALTH_PATH);
  return res.json() as Promise<CloudHealth>;
}

/** 取一份云端 Bundle；任何失败都返回 null，绝不抛到界面上 */
async function fetchBundle(): Promise<Bundle | null> {
  try {
    const res = await apiFetch(SYNC_PATH);
    const raw = await res.json() as Partial<Bundle>;
    if (!raw || raw.app !== 'vibe-desk' || !Array.isArray(raw.notes)) return null;
    return raw as Bundle;
  } catch {
    return null;
  }
}

/** 手动连线：立刻把一条关系送到云端。PUT/DELETE 幂等，两个基址都可以试 */
export async function putTieRemote(row: LinkRow): Promise<void> {
  try {
    await apiFetch('/links', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row)
    });
  } catch { /* 离线 */ }
}

/** 手动断开：云端那条也删掉，避免下次自动同步把它补回来 */
export async function deleteTieRemote(key: string): Promise<void> {
  try {
    await apiFetch('/links/' + encodeURIComponent(key), { method: 'DELETE' });
  } catch { /* 离线 */ }
}

function b64ToBlob(data: string, mime: string): Blob {
  const bin = atob(data);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

/**
 * 启动自动同步：云端 → 本地，合并式。
 * 只补不删；配置型数据（实体）以云端为准，笔记按时间新者胜。
 */
export async function autoSyncFromCloud(): Promise<AutoSyncReport> {
  const bundle = await fetchBundle();
  if (!bundle) return { ok: false, added: 0, updated: 0, reason: '后端不可达' };

  try {
    let added = 0;
    let updated = 0;

    // 笔记：本地没有就补，同 id 取 updatedAt 新者
    const localNotes = new Map((await getAll<Note>('notes')).map(n => [n.id, n]));
    for (const n of bundle.notes) {
      const cur = localNotes.get(n.id);
      if (!cur) { await putOne('notes', n); added++; }
      else if (n.updatedAt > cur.updatedAt) { await putOne('notes', n); updated++; }
    }

    // 双链：按 key 合并，最近「走过」的那份胜。
    // 用户在本地手动断开的关系有墓碑，云端那份必须跳过，否则等于没断开。
    const localLinks = new Map((await getAll<LinkRow>('links')).map(l => [l.key, l]));
    const tombs = await tombstoned();
    for (const l of bundle.links) {
      if (tombs.has(l.key)) continue;
      const cur = localLinks.get(l.key);
      if (!cur || l.lastWalkedAt > cur.lastWalkedAt) await putOne('links', l);
    }

    // 回看：到期时间更靠后的那份更接近真实进度
    const localReview = new Map((await getAll<ReviewRow>('review')).map(r => [r.noteId, r]));
    for (const r of bundle.review) {
      const cur = localReview.get(r.noteId);
      if (!cur || r.dueAt > cur.dueAt) await putOne('review', r);
    }

    // 决策 / 图片：只补缺失，不覆盖（用户可能删过、改过）
    const localDec = new Set((await getAll<DecisionRow>('decisions')).map(d => d.id));
    for (const d of bundle.decisions) if (!localDec.has(d.id)) await putOne('decisions', d);

    const localAssets = new Set((await getAll<AssetRow>('assets')).map(a => a.id));
    for (const a of (bundle.assets ?? []) as AssetPack[]) {
      if (localAssets.has(a.id)) continue;
      const row: AssetRow = {
        id: a.id, blob: b64ToBlob(a.data, a.mime),
        mime: a.mime, w: a.w, h: a.h, at: a.at
      };
      await putOne('assets', row);
    }

    // 站点实体是配置，云端为准：同 id 覆盖，缺失补
    for (const e of (bundle.entities ?? []) as EntityRow[]) await putOne('entities', e);

    return { ok: true, added, updated };
  } catch (err) {
    return { ok: false, added: 0, updated: 0, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** 手动云端拉取：服务器 → 本地（替换式。调用方负责确认与工位收尾） */
export async function pullFromCloud(): Promise<SyncSummary> {
  const res = await apiFetch(SYNC_PATH);
  const raw = await res.json() as Partial<Bundle>;
  if (!raw || raw.app !== 'vibe-desk' || !Array.isArray(raw.notes)) {
    throw new Error('云端返回的数据不是 VIBE DESK 格式');
  }
  const bundle = raw as Bundle;
  await applyBundle(bundle);
  return {
    notes: bundle.notes.length,
    links: bundle.links.length,
    review: bundle.review.length,
    decisions: bundle.decisions.length,
    assets: bundle.assets.length,
    entities: (bundle.entities ?? []).length
  };
}

/** 手动云端推送：本地 → 服务器（替换式。后端拒绝空包，覆盖前先确认） */
export async function pushToCloud(): Promise<SyncSummary> {
  const bundle = await buildBundle();
  const res = await apiFetch(SYNC_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bundle)
  }, false);
  const data = await res.json().catch(() => null) as
    { ok?: boolean; error?: string; counts?: Record<string, number> } | null;
  if (!res.ok || !data?.ok) throw new Error(data?.error ?? `后端返回 ${res.status}`);
  return {
    notes: data.counts?.notes ?? bundle.notes.length,
    links: data.counts?.links ?? bundle.links.length,
    review: data.counts?.review ?? bundle.review.length,
    decisions: data.counts?.decisions ?? bundle.decisions.length,
    assets: data.counts?.assets ?? bundle.assets.length,
    entities: data.counts?.entities ?? (bundle.entities ?? []).length
  };
}
