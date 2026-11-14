/**
 * 学习资料库（星云蛛改造）：GitHub 公开仓库的文件树客户端。
 *
 * 数据流：Git Trees API 一次拉全树（recursive=1）→ 缓存 localStorage；
 * 文件内容走 raw.githubusercontent.com 直链（CDN，不占 API 限额）。
 * 关联配置存后端 meta 表（换仓库不用改代码），本地 localStorage 兜底。
 *
 * 未认证限额 60 次/小时，只花在「拉树」上：缓存 + 手动同步完全够用。
 */
export interface VaultConfig {
  /** owner/repo 形式，如 xiaohei52056/study-vault */
  repo: string;
  branch: string;
}

export interface VaultEntry {
  path: string;
  size: number;
}

export interface VaultTree {
  at: number;
  repo: string;
  branch: string;
  entries: VaultEntry[];
  truncated: boolean;
}

export type VaultError =
  | { kind: 'missing'; repo: string }
  | { kind: 'empty'; repo: string }
  | { kind: 'ratelimit' }
  | { kind: 'toolarge'; path: string }
  | { kind: 'offline' };

const CFG_KEY = 'vibedesk.vault.cfg';
const TREE_KEY = 'vibedesk.vault.tree';
export const DEFAULT_CFG: VaultConfig = { repo: 'xiaohei52056/study-vault', branch: 'main' };

const META_BASES = ['/api', 'http://localhost:8080/api'];

const normCfg = (raw: unknown): VaultConfig | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<VaultConfig>;
  if (typeof o.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(o.repo.trim())) return null;
  return { repo: o.repo.trim(), branch: typeof o.branch === 'string' && o.branch.trim() ? o.branch.trim() : 'main' };
};

/* ---------------- 配置：后端 meta 为主，localStorage 兜底 ---------------- */

export function loadCfgLocal(): VaultConfig {
  try {
    const cfg = normCfg(JSON.parse(localStorage.getItem(CFG_KEY) ?? 'null'));
    if (cfg) return cfg;
  } catch { /* 坏数据当没配过 */ }
  return { ...DEFAULT_CFG };
}

export async function loadCfg(): Promise<VaultConfig> {
  for (const base of META_BASES) {
    try {
      const res = await fetch(`${base}/meta/vault.cfg`);
      if (!res.ok) continue;
      const data = await res.json() as { exists?: boolean; v?: string };
      const cfg = normCfg(data.exists && data.v ? JSON.parse(data.v) : null);
      if (cfg) {
        localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
        return cfg;
      }
    } catch { /* 换下一个基址 */ }
  }
  return loadCfgLocal();
}

export async function saveCfg(cfg: VaultConfig): Promise<void> {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  for (const base of META_BASES) {
    try {
      const res = await fetch(`${base}/meta/vault.cfg`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: JSON.stringify(cfg) })
      });
      if (res.ok) return;
    } catch { /* 换下一个基址 */ }
  }
  // 后端不在也无所谓：localStorage 已经生效
}

/* ---------------- 文件树 ---------------- */

export function cachedTree(): VaultTree | null {
  try {
    const t = JSON.parse(localStorage.getItem(TREE_KEY) ?? 'null') as VaultTree | null;
    return t && Array.isArray(t.entries) ? t : null;
  } catch { return null; }
}

/** raw 直链：预览与下载都用它 */
export function rawUrl(cfg: VaultConfig, path: string): string {
  return `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** 整仓打包（GitHub 官方 zip） */
export function zipUrl(cfg: VaultConfig): string {
  return `https://github.com/${cfg.repo}/archive/refs/heads/${cfg.branch}.zip`;
}

/** 拉全树并写缓存。失败抛 VaultError，调用方按 kind 给人话提示 */
export async function fetchTree(cfg: VaultConfig): Promise<VaultTree> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${cfg.repo}/git/trees/${cfg.branch}?recursive=1`,
      { headers: { Accept: 'application/vnd.github+json' } });
  } catch {
    throw { kind: 'offline' } as VaultError;
  }
  if (res.status === 404) throw { kind: 'missing', repo: cfg.repo } as VaultError;
  if (res.status === 403) throw { kind: 'ratelimit' } as VaultError;
  if (!res.ok) throw { kind: 'offline' } as VaultError;
  const data = await res.json() as { tree?: Array<{ type: string; path: string; size?: number }>; truncated?: boolean };
  const entries = (data.tree ?? [])
    .filter(n => n.type === 'blob')
    .map(n => ({ path: n.path, size: n.size ?? 0 }));
  const tree: VaultTree = { at: Date.now(), repo: cfg.repo, branch: cfg.branch, entries, truncated: !!data.truncated };
  localStorage.setItem(TREE_KEY, JSON.stringify(tree));
  return tree;
}

/* ---------------- 小工具 ---------------- */

export function extOf(path: string): string {
  const name = path.split('/').pop() ?? '';
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function sizeLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 文件多少天前同步的人话时间 */
export function agoLabel(at: number): string {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
export const MD_EXT = new Set(['md', 'markdown']);
export const TEXT_EXT = new Set(['txt', 'json', 'yml', 'yaml', 'toml', 'csv', 'log', 'ini', 'conf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'hpp',
  'cs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'html', 'css', 'scss', 'vue', 'swift', 'xml', 'ipynb']);
/** 浏览器没法预览的文档类：点击即下载 */
export const DOC_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', '7z', 'gz', 'tar', 'exe', 'apk']);

export type FileKind = 'folder' | 'md' | 'image' | 'text' | 'pdf' | 'doc' | 'other';

export function kindOf(path: string, isDir: boolean): FileKind {
  if (isDir) return 'folder';
  const ext = extOf(path);
  if (MD_EXT.has(ext)) return 'md';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (DOC_EXT.has(ext)) return 'doc';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

/** 跨域下载：fetch → blob → objectURL，浏览器一定落盘而不是开新页 */
export async function downloadFile(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------------- 文件内容：双通道 ---------------- */

/**
 * 取文件内容。raw.githubusercontent.com 在不少网络环境下不可达（DNS 污染），
 * 所以 raw 直链失败时自动切换 GitHub Contents API（base64，仅 1MB 内文件）。
 * wantBlob=true 返回 Blob（图片/pdf/下载用），false 返回解码后的文本。
 */
export async function fetchContent(
  cfg: VaultConfig,
  path: string,
  wantBlob: boolean
): Promise<Blob | string> {
  try {
    const raw = await fetch(rawUrl(cfg, path));
    if (raw.ok) return wantBlob ? await raw.blob() : await raw.text();
  } catch { /* raw 不可达 → 走 API 兜底 */ }

  const apiPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(
    `https://api.github.com/repos/${cfg.repo}/contents/${apiPath}?ref=${cfg.branch}`,
    { headers: { Accept: 'application/vnd.github+json' } }
  );
  if (res.status === 404) throw { kind: 'missing', repo: cfg.repo } as VaultError;
  if (res.status === 403) throw { kind: 'ratelimit' } as VaultError;
  if (!res.ok) throw { kind: 'offline' } as VaultError;
  const data = await res.json() as { content?: string; encoding?: string; size?: number };
  if (data.encoding !== 'base64' || !data.content) {
    throw { kind: 'toolarge', path } as VaultError;
  }
  const bin = atob(data.content.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (wantBlob) return new Blob([bytes]);
  return new TextDecoder('utf-8').decode(bytes);
}

/** 统一的人话错误文案：面板 catch 里直接用 */
export function contentErrorText(err: unknown, name: string): string {
  const kind = (err as { kind?: string })?.kind;
  if (kind === 'toolarge') return `${name} 超过 1MB · 当前网络拿不到 raw 直链，换网络/代理后再试`;
  if (kind === 'ratelimit') return 'GitHub 接口次数暂时用完（60 次/小时）· 稍后再试';
  return `${name} 内容加载失败 · 检查网络后重试`;
}
