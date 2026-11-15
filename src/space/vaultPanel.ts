/**
 * 学习资料库面板（星云蛛改造）：双栏阅读器。
 *
 * 左栏常驻文件树（面包屑 / 搜索 / 类型筛选 / 排序），右栏是阅读区 ——
 * 点一个文件只在右边换内容，列表不消失，读完接着点下一个，不必来回退。
 * 右栏头部有 ‹ › 上一个/下一个文件、收栏/展栏（宽表格用）、↓ 下载。
 * 键盘：↑↓ 选文件（阅读态下 = 上一个/下一个）、Enter 打开、Esc 逐层退。
 *
 * 打开策略：先渲染本地缓存的文件树（零等待），绝不自动请求 GitHub ——
 * 未认证限额 60 次/小时，只在用户点「⟳ 同步」时才拉取，避免白白消耗配额。
 * 预览：md 渲染成文章、图片内嵌、代码/文本 <pre>、pdf 新标签、
 * docx/xlsx/html 面板内解析，其余浏览器放不了的文件点击即下载。
 * 换仓库：右上 ⚙ 填 用户名/仓库名/分支，存后端 meta 表。
 */
import {
  agoLabel, cachedTree, contentErrorText, fetchContent, fetchTree, kindOf, loadCfg, saveCfg, sizeLabel, zipUrl,
  type FileKind, type VaultConfig, type VaultEntry, type VaultTree
} from './vault';
import { mdLite } from '../ui/mdLite';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

const REFRESH_MIN = 10;

interface Row {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  /** 该文件夹下的直接条数（只给文件夹显示） */
  count?: number;
}

type FilterKey = 'all' | 'doc' | 'sheet' | 'web' | 'text' | 'img';
type SortKey = 'name' | 'size' | 'kind';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'doc', label: 'Word' },
  { key: 'sheet', label: '表格' },
  { key: 'web', label: '网页' },
  { key: 'text', label: '文本' },
  { key: 'img', label: '图片' }
];

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'name', label: '名称' },
  { key: 'size', label: '大小' },
  { key: 'kind', label: '类型' }
];

/** 文件归到哪个筛选组（folder/other 不参与筛选） */
function groupOf(k: FileKind): FilterKey | null {
  if (k === 'docx' || k === 'doc') return 'doc';
  if (k === 'sheet') return 'sheet';
  if (k === 'html') return 'web';
  if (k === 'md' || k === 'text' || k === 'pdf') return 'text';
  if (k === 'image') return 'img';
  return null;
}

function kindLabel(k: FileKind): string {
  switch (k) {
    case 'md': return 'Markdown';
    case 'image': return '图片';
    case 'pdf': return 'PDF';
    case 'docx': return 'Word';
    case 'sheet': return '表格';
    case 'html': return '网页';
    case 'doc': return '文档';
    case 'text': return '文本';
    case 'folder': return '文件夹';
    default: return '文件';
  }
}

export interface VaultPanel {
  open(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function mountVaultPanel(): VaultPanel {
  const el = document.createElement('div');
  el.id = 'vault-panel';
  el.hidden = true;

  const head = document.createElement('div');
  head.className = 'vp-head';
  const title = document.createElement('span');
  title.className = 'vp-title';
  title.textContent = '学习资料库';
  const tools = document.createElement('span');
  tools.className = 'vp-tools';
  const mkTool = (text: string, tip: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = tip;
    return b;
  };
  const syncBtn = mkTool('⟳ 同步', '从 GitHub 重新拉取文件树');
  const zipBtn = mkTool('⤓ zip', '在 GitHub 下载整个仓库的 zip 包');
  const cfgBtn = mkTool('⚙ 设置', '关联到别的仓库');
  const closeBtn = mkTool('×', '收起');
  closeBtn.className = 'vp-close';
  tools.append(syncBtn, zipBtn, cfgBtn, closeBtn);
  head.append(title, tools);

  const bar = document.createElement('div');
  bar.className = 'vp-bar';
  const crumb = document.createElement('span');
  crumb.className = 'vp-crumb';
  const search = document.createElement('input');
  search.className = 'vp-search';
  search.placeholder = '搜索全库文件名…';
  search.type = 'text';
  bar.append(crumb, search);

  /* 左栏：筛选条 + 文件列表 */
  const main = document.createElement('div');
  main.className = 'vp-main';

  const side = document.createElement('div');
  side.className = 'vp-side';
  const filters = document.createElement('div');
  filters.className = 'vp-filters';
  const sortLab = document.createElement('span');
  sortLab.className = 'vp-sort-lab';
  sortLab.textContent = '排序';
  const sortSel = document.createElement('select');
  sortSel.className = 'vp-sort';
  sortSel.title = '排序方式';
  for (const s of SORTS) {
    const o = document.createElement('option');
    o.value = s.key;
    o.textContent = s.label;
    sortSel.append(o);
  }
  sortSel.value = 'name';
  const listPane = document.createElement('div');
  listPane.className = 'vp-list-pane';
  side.append(filters, listPane);

  /* 右栏：阅读区 */
  const pane = document.createElement('div');
  pane.className = 'vp-pane';
  const paneHead = document.createElement('div');
  paneHead.className = 'vp-pane-head';
  const paneBody = document.createElement('div');
  paneBody.className = 'vp-pane-body';
  pane.append(paneHead, paneBody);

  main.append(side, pane);

  const foot = document.createElement('div');
  foot.className = 'vp-foot';

  el.append(head, bar, main, foot);
  document.body.appendChild(el);

  let cfg: VaultConfig | null = null;
  let tree: VaultTree | null = null;
  let dir: string[] = [];
  let openPath: string | null = null;
  let inSettings = false;
  let filter: FilterKey = 'all';
  let sortKey: SortKey = 'name';
  let sel = 0;
  let lastRows: Row[] = [];
  let busy = false;
  let objectUrl: string | null = null;
  /** 收栏按钮：宽屏阅读是开关态，标签要跟着变 */
  let wideBtn: HTMLButtonElement | null = null;

  /* ---------------- 基础渲染 ---------------- */

  const isOpen = (): boolean => !el.hidden;

  function close(): void {
    el.hidden = true;
    search.value = '';
    dir = [];
    openPath = null;
    inSettings = false;
    sel = 0;
    main.classList.remove('reading', 'wide', 'settings');
    wideBtn = null;
    releaseUrl();
    listPane.textContent = '';
    paneHead.textContent = '';
    paneBody.textContent = '';
    paneBody.className = 'vp-pane-body';
  }

  function releaseUrl(): void {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  }

  const spin = (on: boolean): void => {
    busy = on;
    syncBtn.classList.toggle('busy', on);
    syncBtn.textContent = on ? '⟳ 同步中' : '⟳ 同步';
  };

  const say = (msg: string): void => { foot.textContent = msg; };

  function renderCrumb(): void {
    crumb.textContent = '';
    const root = document.createElement('button');
    root.type = 'button';
    root.className = 'vp-crumb-item';
    root.textContent = '学习资料';
    root.addEventListener('click', () => {
      dir = [];
      sel = 0;
      if (openPath) { closeFile(); return; }
      render();
    });
    crumb.append(root);
    dir.forEach((seg, i) => {
      crumb.append(' / ');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vp-crumb-item';
      b.textContent = seg;
      if (i < dir.length - 1) {
        b.addEventListener('click', () => { dir = dir.slice(0, i + 1); sel = 0; render(); });
      } else {
        b.classList.add('here');
      }
      crumb.append(b);
    });
    if (openPath) {
      crumb.append(' / ');
      const here = document.createElement('span');
      here.className = 'vp-crumb-item here';
      here.textContent = openPath.split('/').pop() ?? openPath;
      crumb.append(here);
    }
  }

  function markSub(): void {
    const small = document.querySelector<HTMLElement>('.entity[data-id="spider"] .cap small');
    if (small && tree) {
      small.textContent = tree.entries.length
        ? `${tree.entries.length} 个文件 · 点击浏览`
        : '点击浏览 GitHub 学习文件';
    }
  }

  /* ---------------- 文件行 ---------------- */

  const inDir = (): VaultEntry[] =>
    (tree?.entries ?? []).filter(e => e.path.startsWith(dir.join('/') + (dir.length ? '/' : '')));

  function cmp(a: Row, b: Row): number {
    if (sortKey === 'size') return b.size - a.size || a.name.localeCompare(b.name, 'zh-CN');
    if (sortKey === 'kind') {
      return kindOf(a.path, false).localeCompare(kindOf(b.path, false), 'zh-CN')
        || a.name.localeCompare(b.name, 'zh-CN');
    }
    return a.name.localeCompare(b.name, 'zh-CN');
  }

  function buildRows(): Row[] {
    const prefix = dir.join('/') + (dir.length ? '/' : '');
    const dirs = new Map<string, number>();
    const files: Row[] = [];
    for (const e of inDir()) {
      const rest = e.path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        files.push({ name: rest, path: e.path, dir: false, size: e.size });
      } else {
        const name = rest.slice(0, slash);
        const full = prefix + name;
        dirs.set(full, (dirs.get(full) ?? 0) + 1);
      }
    }
    const dirRows: Row[] = [...dirs.entries()]
      .map(([path, count]) => ({ name: path.split('/').pop()!, path, dir: true, size: 0, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    files.sort(cmp);
    return [...dirRows, ...files];
  }

  function searchRows(q: string): Row[] {
    const needle = q.trim().toLowerCase();
    return (tree?.entries ?? [])
      .filter(e => e.path.toLowerCase().includes(needle))
      .slice(0, 120)
      .map(e => ({ name: e.path, path: e.path, dir: false, size: e.size }))
      .sort(cmp);
  }

  /** 筛选态：全库平铺，只留该组文件 */
  function filterRows(): Row[] {
    return (tree?.entries ?? [])
      .filter(e => groupOf(kindOf(e.path, false)) === filter)
      .map(e => ({ name: e.path, path: e.path, dir: false, size: e.size }))
      .sort(cmp);
  }

  function collectRows(): Row[] {
    const q = search.value.trim();
    if (q) return searchRows(q);
    if (filter !== 'all') return filterRows();
    return buildRows();
  }

  const iconChar = (kind: ReturnType<typeof kindOf>): string =>
    kind === 'folder' ? '▸' : kind === 'md' ? '❯' : kind === 'image' ? '▣'
      : kind === 'pdf' ? 'P' : kind === 'docx' ? 'W' : kind === 'sheet' ? '▦'
      : kind === 'html' ? '⧉' : kind === 'doc' ? '⤓' : kind === 'text' ? '≡' : '·';

  function rowEl(r: Row): HTMLElement {
    const row = document.createElement('div');
    row.className = 'vp-row';
    row.dataset['path'] = r.path;
    if (!r.dir && r.path === openPath) row.classList.add('here');
    const k = kindOf(r.path, r.dir);
    const icon = document.createElement('span');
    icon.className = `vp-icon k-${k}`;
    icon.textContent = iconChar(k);
    const name = document.createElement('span');
    name.className = 'vp-name';
    name.textContent = r.dir ? `${r.name}/` : r.name;
    name.title = r.dir ? `进入 ${r.name}` : r.path;
    const meta = document.createElement('span');
    meta.className = 'vp-meta';
    meta.textContent = r.dir ? `${r.count} 项` : sizeLabel(r.size);
    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'vp-dl';
    dl.textContent = '↓';
    dl.title = `下载 ${r.name.split('/').pop()}`;
    dl.addEventListener('click', ev => { ev.stopPropagation(); void grab(r.path); });
    row.append(icon, name, meta, dl);
    row.addEventListener('click', () => {
      sel = Math.max(0, lastRows.findIndex(x => x.path === r.path));
      if (r.dir) { void activate(r); return; }
      void openFile(r);
    });
    return row;
  }

  /* ---------------- 下载 ---------------- */

  async function grab(path: string): Promise<void> {
    if (!cfg) return;
    const name = path.split('/').pop() ?? path;
    say(`下载中 · ${name}`);
    try {
      const blob = await fetchContent(cfg, path, true) as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      say(`已下载 · ${name}`);
    } catch (err) {
      say(contentErrorText(err, name));
    }
  }

  /* ---------------- 阅读区 ---------------- */

  const paneIdle = (): void => {
    paneHead.textContent = '';
    paneBody.className = 'vp-pane-body';
    paneBody.textContent = '';
    const tip = document.createElement('div');
    tip.className = 'vp-empty';
    tip.innerHTML = tree
      ? '从左侧选一个文件开始阅读<br><small>↑↓ 选择 · Enter 打开 · Esc 收起</small>'
      : (cfg ? '尚未从 GitHub 同步 · 点右上 <strong>⟳ 同步</strong> 拉取文件树' : '');
    paneBody.append(tip);
  };

  function paneHeadFor(r: Row): void {
    paneHead.textContent = '';
    const name = document.createElement('span');
    name.className = 'vp-pane-name';
    name.textContent = r.name;
    name.title = r.path;
    const meta = document.createElement('span');
    meta.className = 'vp-pane-meta';
    meta.textContent = `${kindLabel(kindOf(r.path, false))} · ${sizeLabel(r.size)}`;

    const acts = document.createElement('div');
    acts.className = 'vp-pane-acts';
    const mkAct = (text: string, tip: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.title = tip;
      b.addEventListener('click', fn);
      return b;
    };
    const wide = main.classList.contains('wide');
    const wb = mkAct(wide ? '展栏' : '收栏', '收起 / 展开左侧文件列表（宽表格用）', () => {
      const on = main.classList.toggle('wide');
      wb.textContent = on ? '展栏' : '收栏';
      say(on ? '左侧列表已收起 · 再点「展栏」或 Esc 恢复' : '');
    });
    wideBtn = wb;
    acts.append(
      mkAct('‹', '上一个文件（↑）', () => step(-1)),
      mkAct('›', '下一个文件（↓）', () => step(1)),
      wb,
      mkAct('↓ 下载', `下载 ${r.name}`, () => void grab(r.path)),
      mkAct('×', '关闭阅读区（Esc）', () => closeFile())
    );
    paneHead.append(name, meta, acts);
  }

  function paneMsg(msg: string): void {
    paneBody.className = 'vp-pane-body';
    paneBody.textContent = '';
    const box = document.createElement('div');
    box.className = 'vp-empty';
    box.innerHTML = msg;
    paneBody.append(box);
  }

  /** 取内容可能等几秒（raw 超时 → API 兜底）：先给个占位，别让右栏看起来是空的 */
  function paneLoading(r: Row): void {
    paneMsg(`加载中 · ${r.name}`);
  }

  function closeFile(): void {
    openPath = null;
    main.classList.remove('reading', 'wide');
    wideBtn = null;
    paneHead.textContent = '';
    paneBody.textContent = '';
    paneBody.className = 'vp-pane-body';
    releaseUrl();
    paneIdle();
    render();
  }

  /** 当前列表里可见的文件（不含文件夹），供 ‹ › 翻页 */
  function siblings(): Row[] {
    return lastRows.filter(r => !r.dir);
  }

  function step(d: number): void {
    const list = siblings();
    if (!list.length) return;
    let i = list.findIndex(r => r.path === openPath);
    i = i === -1 ? 0 : (i + d + list.length) % list.length;
    void openFile(list[i]);
  }

  async function openFile(r: Row): Promise<void> {
    if (!cfg) return;
    openPath = r.path;
    main.classList.add('reading');
    renderCrumb();
    renderBrowse(true);
    paneHeadFor(r);
    paneBody.className = 'vp-pane-body';
    paneBody.textContent = '';
    paneBody.scrollTop = 0;

    const k = kindOf(r.path, false);
    if (k === 'doc' || k === 'other') { unsupported(r); return; }
    paneLoading(r);
    if (k === 'docx') { await previewDocx(r); return; }
    if (k === 'sheet') { await previewSheet(r); return; }
    if (k === 'html') { await previewHtml(r); return; }
    if (k === 'pdf') { await openPdf(r); return; }
    await previewText(r, k === 'image');
  }

  /** doc/ppt/zip 等浏览器放不了的：给下载入口，不做假预览 */
  function unsupported(r: Row): void {
    paneMsg(
      `<strong>${r.name}</strong> 浏览器无法预览这种格式<br>` +
      '点右侧「↓ 下载」保存到本地再打开'
    );
    say(`${r.name} · ${kindLabel(kindOf(r.path, false))} · 需下载后打开`);
  }

  async function openPdf(r: Row): Promise<void> {
    if (!cfg) return;
    paneMsg(`<strong>${r.name}</strong><br>pdf 已在新标签打开，若没弹出请允许弹窗`);
    say('打开 pdf 中…');
    try {
      const blob = await fetchContent(cfg, r.path, true) as Blob;
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      say(`${r.name} · ${sizeLabel(r.size)} · pdf 已在新标签打开`);
    } catch (err) {
      paneMsg(contentErrorText(err, r.name));
      say(contentErrorText(err, r.name));
    }
  }

  async function previewText(r: Row, isImage: boolean): Promise<void> {
    if (!cfg) return;
    spin(true);
    say('加载内容…');
    try {
      const content = await fetchContent(cfg, r.path, isImage);
      paneBody.className = 'vp-pane-body';
      paneBody.textContent = '';
      if (isImage) {
        releaseUrl();
        objectUrl = URL.createObjectURL(content as Blob);
        const img = document.createElement('img');
        img.className = 'vp-image';
        img.src = objectUrl;
        img.alt = r.name;
        paneBody.append(img);
      } else {
        const text = content as string;
        if (kindOf(r.path, false) === 'md') {
          const art = document.createElement('div');
          art.className = 'vp-md';
          art.innerHTML = mdLite(text);
          paneBody.append(art);
        } else {
          const pre = document.createElement('pre');
          pre.className = 'vp-text';
          pre.textContent = text.slice(0, 200000);
          paneBody.append(pre);
        }
      }
      paneBody.scrollTop = 0;
      say(`${r.name} · ${sizeLabel(r.size)}`);
    } catch (err) {
      paneMsg(contentErrorText(err, r.name));
      say(contentErrorText(err, r.name));
    } finally {
      spin(false);
    }
  }

  /* ---------------- 文档/表格/网页 预览 ---------------- */

  async function previewDocx(r: Row): Promise<void> {
    if (!cfg) return;
    spin(true); say('解析 Word 文档…');
    try {
      const blob = await fetchContent(cfg, r.path, true) as Blob;
      const res = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
      paneBody.className = 'vp-pane-body';
      paneBody.textContent = '';
      const box = document.createElement('div');
      box.className = 'vp-doc';
      box.innerHTML = res.value;
      paneBody.append(box);
      paneBody.scrollTop = 0;
      say(`${r.name} · ${sizeLabel(r.size)} · ${res.messages.length ? '部分样式未转换' : '已转换'}`);
    } catch (err) {
      paneMsg(contentErrorText(err, r.name));
      say(contentErrorText(err, r.name));
    } finally { spin(false); }
  }

  async function previewSheet(r: Row): Promise<void> {
    if (!cfg) return;
    spin(true); say('解析 Excel 表格…');
    try {
      const blob = await fetchContent(cfg, r.path, true) as Blob;
      const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
      const names = wb.SheetNames;
      const renderSheet = (name: string): void => {
        const ws = wb.Sheets[name];
        const tbl = XLSX.utils.sheet_to_html(ws);
        paneBody.className = 'vp-pane-body';
        paneBody.textContent = '';
        const box = document.createElement('div');
        box.className = 'vp-sheet';
        const tabs = document.createElement('div');
        tabs.className = 'vp-sheet-tabs';
        for (const n of names) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'vp-sheet-tab' + (n === name ? ' here' : '');
          b.textContent = n;
          b.addEventListener('click', () => { renderSheet(n); });
          tabs.append(b);
        }
        const tableBox = document.createElement('div');
        tableBox.className = 'vp-sheet-table';
        tableBox.innerHTML = tbl;
        box.append(tabs, tableBox);
        paneBody.append(box);
        paneBody.scrollTop = 0;
      };
      renderSheet(names[0]);
      say(`${r.name} · ${sizeLabel(r.size)} · 共 ${names.length} 个工作表 · 点「收栏」可加宽阅读区`);
    } catch (err) {
      paneMsg(contentErrorText(err, r.name));
      say(contentErrorText(err, r.name));
    } finally { spin(false); }
  }

  async function previewHtml(r: Row): Promise<void> {
    if (!cfg) return;
    spin(true); say('加载网页…');
    try {
      const text = await fetchContent(cfg, r.path, false) as string;
      paneBody.className = 'vp-pane-body fill';
      paneBody.textContent = '';
      const frame = document.createElement('iframe');
      frame.className = 'vp-html';
      frame.setAttribute('sandbox', '');
      frame.setAttribute('title', r.name);
      frame.srcdoc = text;
      paneBody.append(frame);
      say(`${r.name} · ${sizeLabel(r.size)} · 沙箱内渲染（不执行脚本）`);
    } catch (err) {
      paneMsg(contentErrorText(err, r.name));
      say(contentErrorText(err, r.name));
    } finally { spin(false); }
  }

  /* ---------------- 视图 ---------------- */

  function renderFilters(): void {
    filters.textContent = '';
    const counts: Record<FilterKey, number> = { all: 0, doc: 0, sheet: 0, web: 0, text: 0, img: 0 };
    for (const e of tree?.entries ?? []) {
      const g = groupOf(kindOf(e.path, false));
      if (g) counts[g] += 1;
    }
    counts.all = tree?.entries.length ?? 0;
    for (const f of FILTERS) {
      if (f.key !== 'all' && !counts[f.key]) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vp-chip' + (filter === f.key ? ' on' : '');
      b.textContent = f.key === 'all' ? `全部 ${counts.all}` : `${f.label} ${counts[f.key]}`;
      b.addEventListener('click', () => {
        filter = f.key;
        sel = 0;
        render();
      });
      filters.append(b);
    }
    filters.append(sortLab, sortSel);
  }

  function renderBrowse(keepScroll = false): void {
    const rows = collectRows();
    lastRows = rows;
    const q = search.value.trim();
    listPane.textContent = '';
    if (!tree) {
      if (cfg) {
        const empty = document.createElement('div');
        empty.className = 'vp-empty';
        empty.innerHTML = '尚未从 GitHub 同步<br>点右上 <strong>⟳ 同步</strong> 拉取文件树';
        listPane.append(empty);
      } else {
        renderMissing();
      }
      return;
    }
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'vp-empty';
      empty.textContent = q ? `没有文件名包含「${q}」`
        : filter !== 'all' ? '这一类暂时没有文件'
        : '仓库里还没有文件 · 去 GitHub 上传学习文件后点「⟳ 同步」';
      listPane.append(empty);
      return;
    }
    if (sel >= rows.length) sel = rows.length - 1;
    const list = document.createElement('div');
    list.className = 'vp-list';
    rows.forEach((r, i) => {
      const row = rowEl(r);
      if (i === sel) row.classList.add('sel');
      list.append(row);
    });
    listPane.append(list);
    if (!keepScroll) listPane.scrollTop = 0;
    if (q) say(`全库搜索 · ${rows.length} 个结果${tree && tree.truncated ? '（树不完整）' : ''}`);
    else if (filter !== 'all') say(`${FILTERS.find(f => f.key === filter)?.label ?? ''} · ${rows.length} 个文件`);
  }

  /** 仓库不存在/为空时的引导 */
  function renderMissing(): void {
    listPane.textContent = '';
    const box = document.createElement('div');
    box.className = 'vp-empty';
    box.innerHTML =
      '还没关联到仓库，三步接上：<br>' +
      '1. GitHub 新建一个<strong>公开</strong>仓库（如 study-vault）<br>' +
      '2. 把学习文件传进去（网页上直接拖整个文件夹即可）<br>' +
      '3. 点右上 <strong>⚙ 设置</strong> 填 用户名/仓库名/分支，保存后点「⟳ 同步」';
    listPane.append(box);
  }

  function renderSettings(): void {
    if (!cfg) return;
    inSettings = true;
    main.classList.add('settings');
    filters.hidden = true;
    paneHead.textContent = '';
    paneBody.className = 'vp-pane-body';
    paneBody.textContent = '';

    const form = document.createElement('div');
    form.className = 'vp-form';
    const mk = (label: string, value: string, ph: string): HTMLInputElement => {
      const lab = document.createElement('label');
      lab.className = 'vp-field';
      const span = document.createElement('span');
      span.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.placeholder = ph;
      input.spellcheck = false;
      lab.append(span, input);
      form.append(lab);
      return input;
    };
    const repoIn = mk('仓库（用户名/仓库名）', cfg.repo, 'xiaohei52056/study-vault');
    const brIn = mk('分支', cfg.branch, 'main');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'vp-save';
    save.textContent = '保存并同步';
    save.addEventListener('click', () => {
      const next: VaultConfig = {
        repo: repoIn.value.trim(),
        branch: brIn.value.trim() || 'main'
      };
      if (!/^[\w.-]+\/[\w.-]+$/.test(next.repo)) { say('仓库名格式应为 用户名/仓库名'); return; }
      void (async () => {
        await saveCfg(next);
        cfg = next;
        tree = null;
        localStorage.removeItem('vibedesk.vault.tree');
        dir = [];
        filter = 'all';
        inSettings = false;
        main.classList.remove('settings');
        filters.hidden = false;
        paneIdle();
        render();
        await refresh(true);
      })();
    });
    const tip = document.createElement('div');
    tip.className = 'vp-tip';
    tip.textContent = '要求公开仓库；分支一般填 main';
    form.append(save, tip);
    paneBody.append(form);
    say('设置 · 改完点「保存并同步」');
    repoIn.focus();
  }

  function render(): void {
    renderCrumb();
    renderFilters();
    if (inSettings) { renderSettings(); footText(); return; }
    renderBrowse();
    footText();
  }

  function footText(): void {
    if (inSettings) return;
    if (!tree) {
      say(cfg ? `${cfg.repo} · ${cfg.branch} · 尚未同步` : '');
      return;
    }
    if (openPath) {
      const r = lastRows.find(x => x.path === openPath);
      if (r) { say(`${r.path} · ${sizeLabel(r.size)} · ↑↓ 换文件 · Esc 回列表`); return; }
    }
    say(`上次同步 ${agoLabel(tree.at)} · ${tree.repo} · ${tree.branch} · ${tree.entries.length} 个文件`);
  }

  /* ---------------- 同步 ---------------- */

  async function refresh(force: boolean): Promise<void> {
    if (!cfg || busy) return;
    const fresh = tree && tree.repo === cfg.repo && tree.branch === cfg.branch
      && Date.now() - tree.at < REFRESH_MIN * 60000;
    if (!force && fresh && tree) { render(); markSub(); return; }
    spin(true);
    if (force) say('正在从 GitHub 拉取文件树…');
    try {
      tree = await fetchTree(cfg);
      markSub();
      if (inSettings) return;
      render();
      if (openPath) {
        const still = lastRows.find(r => r.path === openPath);
        if (!still) closeFile();
      } else {
        paneIdle();
      }
    } catch (err) {
      const kind = (err as { kind?: string })?.kind;
      if (kind === 'missing') {
        say(`GitHub 上没有 ${cfg.repo} 这个仓库`);
        renderMissing();
      } else if (kind === 'ratelimit') {
        say('GitHub 接口次数暂时用完（60 次/小时）· 稍后再同步，缓存的文件仍可浏览');
      } else {
        say('连不上 GitHub · 检查网络后重试');
      }
    } finally {
      spin(false);
      // 拉取失败时 say() 里放着人话错误提示，别让底栏默认文案把它盖掉
      if (tree) footText();
    }
  }

  /* ---------------- 入口 ---------------- */

  async function open(): Promise<void> {
    el.hidden = false;
    inSettings = false;
    main.classList.remove('settings');
    filters.hidden = false;
    if (!cfg) cfg = await loadCfg();
    tree = cachedTree();
    if (tree && (tree.repo !== cfg.repo || tree.branch !== cfg.branch)) tree = null;
    render();
    if (openPath) {
      const r = lastRows.find(x => x.path === openPath);
      if (r) { paneHeadFor(r); main.classList.add('reading'); } else { closeFile(); }
    } else {
      main.classList.remove('reading', 'wide');
      paneIdle();
    }
    markSub();
    // 不自动同步：只在用户点「⟳ 同步」时才请求 GitHub，避免消耗 60 次/小时配额
  }

  async function activate(r: Row): Promise<void> {
    if (r.dir) {
      dir = r.path.split('/');
      sel = 0;
      render();
      return;
    }
    await openFile(r);
  }

  sortSel.addEventListener('change', () => {
    sortKey = (sortSel.value as SortKey) || 'name';
    sel = 0;
    renderBrowse();
  });

  syncBtn.addEventListener('click', () => { void refresh(true); });
  zipBtn.addEventListener('click', () => { if (cfg) window.open(zipUrl(cfg), '_blank', 'noopener,noreferrer'); });
  cfgBtn.addEventListener('click', () => { if (cfg) renderSettings(); });
  closeBtn.addEventListener('click', close);
  search.addEventListener('input', () => { sel = 0; renderBrowse(); });

  const onKey = (ev: KeyboardEvent): void => {
    if (el.hidden) return;
    if (ev.key === 'Escape') {
      ev.stopImmediatePropagation();
      if (main.classList.contains('wide')) {
        main.classList.remove('wide');
        if (wideBtn) wideBtn.textContent = '收栏';
        return;
      }
      if (inSettings) { inSettings = false; main.classList.remove('settings'); filters.hidden = false; render(); return; }
      if (openPath) { closeFile(); return; }
      close();
      return;
    }
    const t = ev.target instanceof HTMLElement ? ev.target.tagName : '';
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || inSettings) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (el.hidden) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const d = ev.key === 'ArrowDown' ? 1 : -1;
      if (openPath) { step(d); return; }
      if (!lastRows.length) return;
      sel = (sel + d + lastRows.length) % lastRows.length;
      renderBrowse(true);
      listPane.querySelector<HTMLElement>('.vp-row.sel')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (ev.key === 'Enter' && !openPath) {
      const r = lastRows[sel];
      if (!r) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      void activate(r);
    }
  };
  window.addEventListener('keydown', onKey, true);

  return {
    open() { void open(); },
    close,
    isOpen,
    destroy() { window.removeEventListener('keydown', onKey, true); close(); el.remove(); }
  };
}
