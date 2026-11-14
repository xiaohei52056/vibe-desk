/**
 * 手动连线的「删除墓碑」。
 *
 * 启动自动同步是合并式（云端缺的不会删本地），如果只把一条线从本地删掉，
 * 云端那份还会在下次启动时把它补回来 —— 用户会以为断开没生效。
 * 所以断开时记一个墓碑，同步时跳过这些 key；重新连上再把墓碑抹掉。
 *
 * 墓碑同时落到后端 meta 表一份：新设备 / 清过浏览器数据的 profile 没有
 * 本地墓碑，一次性迁移会从正文 [[双链]] 把剪掉的线重新派生出来 ——
 * 云端墓碑就是防复活的最后一道闸。
 */
import { metaGet, metaSet } from './db';

const KEY = 'vibedesk.tieTombstones';

const META_BASES = ['/api', 'http://localhost:8080/api'];

export async function tombstoned(): Promise<Set<string>> {
  const v = await metaGet(KEY);
  return new Set(
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  );
}

/** 云端那份墓碑；后端不在或没记录就返回空集合 */
export async function serverTombstones(): Promise<Set<string>> {
  for (const base of META_BASES) {
    try {
      const res = await fetch(`${base}/meta/${KEY}`);
      if (!res.ok) continue;
      const data = await res.json() as { exists?: boolean; v?: unknown };
      if (!data.exists) return new Set();
      const v = typeof data.v === 'string' ? JSON.parse(data.v) : data.v;
      return new Set(
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
      );
    } catch { /* 换下一个基址 */ }
  }
  return new Set();
}

/** 尽力把墓碑推到后端；失败静默 —— 本地墓碑始终是准的 */
function pushRemote(list: string[]): void {
  void (async () => {
    for (const base of META_BASES) {
      try {
        const res = await fetch(`${base}/meta/${KEY}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ v: JSON.stringify(list) })
        });
        if (res.ok) return;
      } catch { /* 换下一个基址 */ }
    }
  })();
}

export async function addTombstone(key: string): Promise<void> {
  const s = await tombstoned();
  if (s.has(key)) return;
  s.add(key);
  await metaSet(KEY, [...s]);
  pushRemote([...s]);
}

export async function clearTombstone(key: string): Promise<void> {
  const s = await tombstoned();
  if (!s.delete(key)) return;
  await metaSet(KEY, [...s]);
  pushRemote([...s]);
}
