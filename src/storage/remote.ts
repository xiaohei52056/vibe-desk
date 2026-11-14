/**
 * 云端同步：Spring Boot 后端（backend/，默认 localhost:8080，dev 走 Vite 代理）。
 *
 * 两条路，语义与文件导入导出完全一致 —— 同一份 Bundle，三种走法：
 *   文件导出/导入、云端拉取/推送，数据形态不变。
 *   拉取 GET  /api/sync/bundle → applyBundle（替换本地）
 *   推送 POST /api/sync/bundle ← buildBundle（替换云端）
 *
 * 失败要给人话：后端没启动是最常见的情形，别把 fetch 原始报错甩给用户。
 */
import { applyBundle, buildBundle, type Bundle } from './transfer';

const SYNC_URL = '/api/sync/bundle';

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

/** 后端在不在：调用方拿它决定提示文案（启动后端 / 后端出错） */
export async function cloudHealth(): Promise<CloudHealth> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`后端返回 ${res.status}`);
  return res.json() as Promise<CloudHealth>;
}

/** 云端拉取：服务器 → 本地（替换式。调用方负责确认与工位收尾） */
export async function pullFromCloud(): Promise<SyncSummary> {
  const res = await fetch(SYNC_URL);
  if (!res.ok) throw new Error(`后端返回 ${res.status}`);
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

/** 云端推送：本地 → 服务器（替换式。后端拒绝空包，覆盖前先确认） */
export async function pushToCloud(): Promise<SyncSummary> {
  const bundle = await buildBundle();
  const res = await fetch(SYNC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bundle)
  });
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
