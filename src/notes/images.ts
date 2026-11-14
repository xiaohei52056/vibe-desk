/**
 * 图片资源：粘贴进笔记的截图存在 IndexedDB 的 assets 表。
 *
 * 两条原则：
 *   1. 正文永远是可读文本：图只留一行 `![说明](asset:img-xxx)`，
 *      删掉这行就是删掉引用，笔记本身不会被二进制撑大；
 *   2. 读写都走一个 URL 缓存：同一张图在编辑器、观看态、缩略图里
 *      共用同一个 blob URL，不重复 createObjectURL。
 */
import { getOne, putOne, getAll } from '../storage/db';

export interface AssetRow {
  id: string;
  blob: Blob;
  mime: string;
  w: number;
  h: number;
  at: number;
}

/** 正文里的图片引用：![说明](asset:img-xxx) */
export const IMG_RE = /!\[([^\]]*)\]\(asset:([\w-]+)\)/g;

const URLS = new Map<string, string>();

function newId(): string {
  return `img-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function imageSize(blob: Blob): Promise<{ w: number; h: number }> {
  try {
    const bmp = await createImageBitmap(blob);
    const s = { w: bmp.width, h: bmp.height };
    bmp.close();
    return s;
  } catch {
    return { w: 0, h: 0 };      // 尺寸拿不到不影响存取，只是缩略图按原始比例
  }
}

export async function saveImage(blob: Blob): Promise<AssetRow> {
  const size = await imageSize(blob);
  const row: AssetRow = {
    id: newId(),
    blob,
    mime: blob.type || 'image/png',
    w: size.w,
    h: size.h,
    at: Date.now()
  };
  await putOne('assets', row);
  return row;
}

export async function assetUrl(id: string): Promise<string | null> {
  const hit = URLS.get(id);
  if (hit) return hit;
  const row = await getOne<AssetRow>('assets', id);
  if (!row) return null;
  const url = URL.createObjectURL(row.blob);
  URLS.set(id, url);
  return url;
}

/** 正文里引用了哪些图（按出现顺序去重） */
export function imagesOf(body: string): string[] {
  const out: string[] = [];
  IMG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMG_RE.exec(body)) !== null) {
    const id = m[2];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 导出用：整表读出（含 blob），transfer 负责编码 */
export const allAssets = (): Promise<AssetRow[]> => getAll<AssetRow>('assets');
