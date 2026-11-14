/**
 * 存储层：IndexedDB，四个 store + 一个 meta。
 *
 * 三条设计约束（写在代码里，不靠记忆）：
 *   1. 一个 store 一件事。不做宽表，不把笔记和决策塞同一行 —— 否则以后
 *      想单独查「哪些决策挂在 n4 上」就得全表扫。
 *   2. 迁移只读不删。v1.6 的 localStorage 键永久保留，回退到原型时数据还在。
 *   3. 写入按字段合并，不整对象覆盖 —— 同时开两个工位时不会互相吃掉改动。
 */

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface LinkRow {
  /** 无向键：小的 id 在前 */
  key: string;
  a: string;
  b: string;
  w: number;
  lastWalkedAt: number;
}

export interface ReviewRow {
  noteId: string;
  dueAt: number;
  lastAt: number;
  iv: number;
}

export interface DecisionRow {
  id: string;
  noteId: string;
  q: string;
  opts: string[];
  pick: string;
  why: string;
  at: number;
}

export interface EntityRow {
  id: string;
  kind: 'gate' | 'project' | 'core' | 'spider';
  label: string;
  sub: string;
  /** 站外入口 / 仓库链接 */
  url: string;
  /** JSON 字符串：项目卡 {goal,current,next} 或光门 {note} */
  detail: string;
  updatedAt: number;
}

export const DB_NAME = 'vibedesk';
/** v3：新增 entities（光门与项目卡配置）。升级只加表，不动旧数据 */
export const DB_VERSION = 3;
export const STORES = ['notes', 'links', 'review', 'decisions', 'assets', 'meta', 'entities'] as const;
export type StoreName = (typeof STORES)[number];

/** 原型用的键。迁移只读它，永不删除 */
const LEGACY_KEY = 'vibe-desk-v12';
const MIGRATED = 'migratedAt';

let dbp: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('links')) {
        const s = db.createObjectStore('links', { keyPath: 'key' });
        s.createIndex('a', 'a');
        s.createIndex('b', 'b');
      }
      if (!db.objectStoreNames.contains('review')) {
        db.createObjectStore('review', { keyPath: 'noteId' });
      }
      if (!db.objectStoreNames.contains('decisions')) {
        const s = db.createObjectStore('decisions', { keyPath: 'id' });
        s.createIndex('noteId', 'noteId');
      }
      if (!db.objectStoreNames.contains('assets')) {
        const s = db.createObjectStore('assets', { keyPath: 'id' });
        s.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains('entities')) {
        db.createObjectStore('entities', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
  return dbp;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`${store} ${mode} failed`));
  }));
}

export const getAll = <T>(store: StoreName): Promise<T[]> =>
  tx<T[]>(store, 'readonly', s => s.getAll() as IDBRequest<T[]>);

export const getOne = <T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> =>
  tx<T | undefined>(store, 'readonly', s => s.get(key) as IDBRequest<T | undefined>);

export const putOne = <T>(store: StoreName, value: T): Promise<IDBValidKey> =>
  tx<IDBValidKey>(store, 'readwrite', s => s.put(value));

export const delOne = (store: StoreName, key: IDBValidKey): Promise<undefined> =>
  tx<undefined>(store, 'readwrite', s => s.delete(key));

/** 只给「替换式导入」用：整张表清空。日常写入永远不调它 */
export const clearStore = (store: StoreName): Promise<undefined> =>
  tx<undefined>(store, 'readwrite', s => s.clear());

export const metaGet = async (k: string): Promise<unknown> => {
  const row = await getOne<{ k: string; v: unknown }>('meta', k);
  return row?.v;
};

export const metaSet = (k: string, v: unknown): Promise<IDBValidKey> => putOne('meta', { k, v });

/* ============================================================
   种子与迁移
   ============================================================ */

const DAY = 86400000;
const now = Date.now();

/** 与原型的七颗恒星一一对应：id 不变，坐标契约才不破 */
const SEED_NOTES: Note[] = [
  { id: 'n1', title: '论空间记忆与目录', createdAt: now - 9 * DAY, updatedAt: now - 3 * DAY,
    body: '记忆宫殿之所以有效，靠的是 **坐标绝对稳定**。\n\n一个会自己重排的星系，恰好把地基拆了。所以实体坐标永久化，公转只作用于装饰粒子。\n\n相关：[[坐标冻结契约]]、[[双链与块引用]]、[[Hebbian 联想衰减]]\n\n#空间记忆 #坐标冻结' },
  { id: 'n2', title: '坐标冻结契约', createdAt: now - 14 * DAY, updatedAt: now - 6 * DAY,
    body: '实体 `spacePos` 一经分配即永久化，公转只作用于装饰粒子。\n\n亮度只在 ±15% 内波动，**可见度下限 0.6**；旧笔记永不降到不可见。\n\n> 你最需要找回的，往往正是最久没动的那一个。\n\n参见 [[论空间记忆与目录]]\n\n#坐标冻结 #检索' },
  { id: 'n3', title: '双链与块引用', createdAt: now - 21 * DAY, updatedAt: now - 11 * DAY,
    body: '`[[笔记名]]` 是基础双链，`[[笔记名#^block-id]]` 是块级引用。\n\n每个 Block 有稳定 `blockId`，重构笔记不会打断引用。\n\n#双链 #块引用' },
  { id: 'n4', title: 'Hebbian 联想衰减', createdAt: now - 7 * DAY, updatedAt: now - 2 * DAY,
    body: '一条链接每次被「走过」，权重 +1；长时间不走按天衰减。\n\n权重**只映射到光丝粗细**，不改坐标、不改大小、不改可见度。\n\n参见 [[双链与块引用]]\n\n#联想 #光丝' },
  { id: 'n5', title: '光学景深笔记', createdAt: now - 18 * DAY, updatedAt: now - 8 * DAY,
    body: '景深靠尺度、虚化、遮挡与亮度衰减表达，不靠 Bloom 与发光描边。\n\n书写态背景零运动，正文对比度 ≥ 7:1。\n\n#视觉 #景深' },
  { id: 'n6', title: '反看板宣言', createdAt: now - 30 * DAY, updatedAt: now - 12 * DAY,
    body: '> 看板是仪表盘前的人，工作台是星系里的人。\n\n首页不出现指标数字、完成率、实时图表；默认态呈现文字与代码，不是状态块。\n\n#反看板' },
  { id: 'n7', title: '待写：从笔记到复习队列', createdAt: now, updatedAt: now, body: '' }
];

/** 原型的初始关联（P5.4 之后由 Hebbian 权重接管粗细） */
const SEED_LINKS: LinkRow[] = [
  ['n1', 'n2', 2.2], ['n1', 'n3', 1.6], ['n1', 'n4', 1.9], ['n1', 'n5', 1.3], ['n1', 'n6', 1.1],
  ['n4', 'n3', .8], ['n4', 'n6', .8], ['n5', 'n2', .8], ['n5', 'n7', .7], ['n6', 'n7', .8]
].map(([a, b, w]) => {
  const [x, y] = [a as string, b as string].sort();
  return { key: `${x}~${y}`, a: x, b: y, w: w as number, lastWalkedAt: now - 4 * DAY };
});

/** 两条真实决策：一条关于光丝编码，一条关于 3D 只做背景层（路线图 D7） */
const SEED_DECISIONS: DecisionRow[] = [
  {
    id: 'd1', noteId: 'n4', q: '光丝粗细用什么编码？', opts: ['线性映射', '对数映射'],
    pick: '对数映射', why: '线性会把 4.65 和 6.0 都压到最粗，高段失去区分度',
    at: now - 3 * DAY
  },
  {
    id: 'd2', noteId: 'n1', q: '单文件原型要不要上 Three.js？', opts: ['上 Three.js', 'CSS 3D 只给背景层'],
    pick: 'CSS 3D 只给背景层', why: '实体与 UI 必须永远 2D 正对，长文可读性优先；真立体留给 P5 渲染选型',
    at: now - 7 * DAY
  }
];

interface LegacyShape {
  notes?: Record<string, { title?: string; body?: string; text?: string; createdAt?: number; updatedAt?: number }>;
  links?: Record<string, number>;
  review?: Record<string, { due?: number; last?: number; iv?: number }>;
  decisions?: { id?: string; note?: string; q?: string; opts?: string[]; pick?: string; why?: string; at?: number }[];
}

export interface SeedReport {
  source: 'indexeddb' | 'legacy' | 'seed';
  notes: number;
  links: number;
  decisions: number;
}

/**
 * 已经跑起来的库也要补上两条种子决策 —— 但只补一次，靠 meta 记一笔。
 * 用「库为空」判断会有一个坑：你清空了自己写的决策，下次启动它们又回来了。
 */
const DEC_SEEDED = 'decSeededAt';

async function topUpDecisions(): Promise<void> {
  if (await metaGet(DEC_SEEDED)) return;
  const rows = await getAll<DecisionRow>('decisions');
  if (!rows.length) {
    for (const d of SEED_DECISIONS) await putOne('decisions', d);
  }
  await metaSet(DEC_SEEDED, { at: now, seeded: !rows.length });
}

/**
 * 首次启动：先看 IndexedDB 有没有东西，再看原型有没有留下数据，最后才落种子。
 * 迁移成功后只在 meta 里记一笔，原型那份 localStorage 原封不动。
 */
export async function ensureSeeded(): Promise<SeedReport> {
  const existing = await getAll<Note>('notes');
  const migrated = await metaGet(MIGRATED);
  if (existing.length && migrated) {
    await topUpDecisions();
    const links = await getAll<LinkRow>('links');
    const decisions = await getAll<DecisionRow>('decisions');
    return { source: 'indexeddb', notes: existing.length, links: links.length, decisions: decisions.length };
  }

  let raw: string | null = null;
  try { raw = localStorage.getItem(LEGACY_KEY); } catch { /* 隐私模式 */ }

  if (raw) {
    try {
      const data = JSON.parse(raw) as LegacyShape;
      const notes: Note[] = Object.entries(data.notes ?? {}).map(([id, n]) => ({
        id,
        title: n.title || id,
        body: typeof n.body === 'string' ? n.body : (typeof n.text === 'string' ? n.text : ''),
        createdAt: n.createdAt ?? now,
        updatedAt: n.updatedAt ?? now
      }));
      if (notes.length) {
        for (const n of notes) await putOne('notes', n);
        const links: LinkRow[] = Object.entries(data.links ?? {}).map(([key, w]) => {
          const [a, b] = key.split('~');
          return { key, a: a ?? key, b: b ?? key, w: Number(w) || 1, lastWalkedAt: now };
        }).filter(l => l.a !== l.b);
        for (const l of links) await putOne('links', l);
        const decisions: DecisionRow[] = (data.decisions ?? []).map((d, i) => ({
          id: d.id ?? `d${i + 1}`,
          noteId: d.note ?? '',
          q: d.q ?? '',
          opts: d.opts ?? [],
          pick: d.pick ?? '',
          why: d.why ?? '',
          at: d.at ?? now
        })).filter(d => d.q);
        for (const d of decisions) await putOne('decisions', d);
        for (const [noteId, r] of Object.entries(data.review ?? {})) {
          await putOne('review', {
            noteId, dueAt: r.due ?? now, lastAt: r.last ?? 0, iv: r.iv ?? 4
          } satisfies ReviewRow);
        }
        await metaSet(MIGRATED, { at: now, from: LEGACY_KEY, notes: notes.length });
        return { source: 'legacy', notes: notes.length, links: links.length, decisions: decisions.length };
      }
    } catch {
      // 数据坏了就落种子，不要因为一份旧 JSON 打不开整个应用
    }
  }

  for (const n of SEED_NOTES) await putOne('notes', n);
  for (const l of SEED_LINKS) await putOne('links', l);
  for (const d of SEED_DECISIONS) await putOne('decisions', d);
  await metaSet(MIGRATED, { at: now, from: 'seed', notes: SEED_NOTES.length });
  return { source: 'seed', notes: SEED_NOTES.length, links: SEED_LINKS.length, decisions: SEED_DECISIONS.length };
}

export async function saveNote(note: Note): Promise<void> {
  await putOne('notes', note);
}

export async function loadNotes(): Promise<Map<string, Note>> {
  const list = await getAll<Note>('notes');
  return new Map(list.map(n => [n.id, n]));
}
