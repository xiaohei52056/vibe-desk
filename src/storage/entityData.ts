/**
 * 站点实体配置：纪念册光门、代码星系项目卡。
 *
 * 分工很明确：坐标是 coords.ts 的冻结契约（永不变），这里只存「写什么」——
 * 名字、副标题、站外链接、卡片三字段。
 *
 * 数据放 IndexedDB（离线可用），后端可达时自动拉一次 MySQL 的版本；
 * 后端不在就静默降级，绝不影响笔记数据。
 */
import { clearStore, getAll, putOne, type EntityRow } from './db';
import { setEntityOverrides } from '../space/coords';

let rows: readonly EntityRow[] = [];

export const entityRows = (): readonly EntityRow[] => rows;
export const entityOf = (id: string): EntityRow | undefined => rows.find(r => r.id === id);

/** detail 是 JSON 文本；坏数据一律当空对象，不让一颗星打不开 */
export function entityDetail(id: string): Record<string, string> {
  try {
    const raw = JSON.parse(entityOf(id)?.detail ?? '{}') as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, string>;
    }
  } catch { /* 忽略 */ }
  return {};
}

function apply(list: readonly EntityRow[]): void {
  rows = Object.freeze([...list]);
  setEntityOverrides(rows);
}

/** 写入本地并立即生效 */
export async function saveEntityRows(list: readonly EntityRow[]): Promise<void> {
  await clearStore('entities');
  for (const r of list) await putOne('entities', r);
  apply(list);
}

/** 启动时先让缓存生效（离线也能渲染真实项目卡） */
export async function initEntityRows(): Promise<void> {
  apply(await getAll<EntityRow>('entities'));
}

/** 后端可达时同步一次；返回是否真的更新了。失败静默，不打扰阅读 */
export async function syncEntityRows(): Promise<boolean> {
  try {
    const res = await fetch('/api/entities');
    if (!res.ok) return false;
    const remote = await res.json() as EntityRow[];
    if (!Array.isArray(remote) || !remote.length) return false;
    await saveEntityRows(remote);
    return true;
  } catch {
    return false;
  }
}
