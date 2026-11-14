/**
 * 正文解析：纯函数，零 DOM。
 *
 * 独立成文件的原因只有一个 —— 这些东西要能单测。
 * 双链、标签、块 id、成熟度全部是「字符串进、结构出」，不该跟渲染绑在一起。
 */

export type Maturity = '幼苗' | '生长' | '常青';

export interface ParsedBody {
  /** [[目标]] 的目标标题，去重保序 */
  links: string[];
  tags: string[];
  blockIds: string[];
  /** 去掉代码围栏后的字数：中文按字、英文按词 */
  words: number;
  maturity: Maturity;
}

/** [[目标]] / [[目标|别名]] / [[目标#^block]] 都解析出「目标」 */
export function parseLinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const t = (m[1] ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function parseTags(body: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)#([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const t = m[1] ?? '';
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** `^block-id` 形式的块锚点，行首或行尾都算 */
export function parseBlockIds(body: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)\^([A-Za-z0-9-]{3,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const t = m[1] ?? '';
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 字数：中文按字算，英文按空白分词算。代码块不计入。 */
export function countWords(body: string): number {
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const latin = (text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? []).length;
  return cjk + latin;
}

/** 成熟度沿用原型阈值：宁可三个字，也不要一个进度条 */
export function maturityOf(body: string): Maturity {
  const len = body.length;
  const links = parseLinks(body).length;
  if (len < 80 || links === 0) return '幼苗';
  if (len > 240 && links > 1) return '常青';
  return '生长';
}

export function parseBody(body: string): ParsedBody {
  return {
    links: parseLinks(body),
    tags: parseTags(body),
    blockIds: parseBlockIds(body),
    words: countWords(body),
    maturity: maturityOf(body)
  };
}

/** 观看态摘要：去掉标记语法，取前两句 */
export function excerpt(body: string, max = 92): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\(asset:[^)]*\)/g, ' ')      // 图片引用不进摘要
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    .replace(/[*_>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const head = plain.slice(0, max);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf(' '));
  return (cut > max * 0.6 ? head.slice(0, cut) : head) + '…';
}

/** 「3 天前」这种相对时间。站体、面板、搜索三处都用它，别再各写一份。 */
export function relTime(at: number): string {
  const d = Math.floor((Date.now() - at) / 86400000);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${Math.floor(d / 365)} 年前`;
}

/** 标题兜底：正文第一行，去标记，截 24 字 */
export function titleFromBody(body: string): string {
  const line = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('```')) ?? '';
  const plain = line.replace(/^[#>\-\s]+/, '').replace(/[*`]/g, '').trim();
  return plain.slice(0, 24) || '无标题';
}
