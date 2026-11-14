/**
 * 手动连线的「删除墓碑」。
 *
 * 启动自动同步是合并式（云端缺的不会删本地），如果只把一条线从本地删掉，
 * 云端那份还会在下次启动时把它补回来 —— 用户会以为断开没生效。
 * 所以断开时记一个墓碑，同步时跳过这些 key；重新连上再把墓碑抹掉。
 * 墓碑只存在本地 meta 表，不进导出包，也不进云端。
 */
import { metaGet, metaSet } from './db';

const KEY = 'vibedesk.tieTombstones';

export async function tombstoned(): Promise<Set<string>> {
  const v = await metaGet(KEY);
  return new Set(
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  );
}

export async function addTombstone(key: string): Promise<void> {
  const s = await tombstoned();
  if (s.has(key)) return;
  s.add(key);
  await metaSet(KEY, [...s]);
}

export async function clearTombstone(key: string): Promise<void> {
  const s = await tombstoned();
  if (!s.delete(key)) return;
  await metaSet(KEY, [...s]);
}
