/**
 * 学习资料库面板（星云蛛改造）：浏览 / 搜索 / 预览 / 下载 GitHub 学习文件。
 *
 * 打开策略：先渲染本地缓存的文件树（零等待），缓存超过 10 分钟或换了仓库才
 * 重新请求 GitHub —— 未认证限额 60 次/小时，不能每次打开都花一次。
 * 预览：md 渲染成文章、图片内嵌、代码/文本 <pre>、pdf 新标签、
 * Word 等浏览器放不了的文件点击即下载。
 * 换仓库：右上 ⚙ 填 用户名/仓库名/分支，存后端 meta 表。
 */
import {
  agoLabel, cachedTree, contentErrorText, fetchContent, fetchTree, kindOf, loadCfg, saveCfg, sizeLabel, zipUrl,
  type VaultConfig, type VaultEntry, type VaultTree
} from './vault';
import { mdLite } from '../ui/mdLite';

const REFRESH_MIN = 10;

interface Row {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  /** 该文件夹下的直接条数（只给文件夹显示） */
  count?: number;
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

  const body = document.createElement('div');
  body.className = 'vp-body';

  const foot = document.createElement('div');
  foot.className = 'vp-foot';

  el.append(head, bar, body, foot);
  document.body.appendChild(el);

  let cfg: VaultConfig | null = null;
  let tree: VaultTree | null = null;
  let dir: string[] = [];
  let view: 'browse' | 'md' | 'image' | 'text' | 'settings' = 'browse';
  let busy = false;
  let objectUrl: string | null = null;

  /* ---------------- 基础渲染 ---------------- */

  const isOpen = (): boolean => !el.hidden;

  function close(): void {
    el.hidden = true;
    search.value = '';
    dir = [];
    view = 'browse';
    releaseUrl();
    body.textContent = '';
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
    root.addEventListener('click', () => { dir = []; view = 'browse'; render(); });
    crumb.append(root);
    dir.forEach((seg, i) => {
      crumb.append(' / ');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vp-crumb-item';
      b.textContent = seg;
      if (i < dir.length - 1 || view !== 'browse') {
        b.addEventListener('click', () => { dir = dir.slice(0, i + 1); view = 'browse'; render(); });
      } else {
        b.classList.add('here');
      }
      crumb.append(b);
    });
  }

  function markSub(): void {
    const small = document.querySelector<HTMLElement>('.entity[data-id="spider"] .cap small');
    if (small && tree) {
      small.textContent = tree.entries.length
        ? `${tree.entries.length} 个文件 · 点击浏览`
        : '点击浏览 GitHub 学习文件';
    }
  }

  /* ---------------- 浏览列表 ---------------- */

  const inDir = (): VaultEntry[] =>
    (tree?.entries ?? []).filter(e => e.path.startsWith(dir.join('/') + (dir.length ? '/' : '')));

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
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return [...dirRows, ...files];
  }

  function searchRows(q: string): Row[] {
    const needle = q.trim().toLowerCase();
    return (tree?.entries ?? [])
      .filter(e => e.path.toLowerCase().includes(needle))
      .slice(0, 80)
      .map(e => ({ name: e.path, path: e.path, dir: false, size: e.size }));
  }

  const iconChar = (kind: ReturnType<typeof kindOf>): string =>
    kind === 'folder' ? '▸' : kind === 'md' ? '❯' : kind === 'image' ? '▣'
      : kind === 'pdf' ? 'P' : kind === 'doc' ? 'W' : kind === 'text' ? '≡' : '·';

  function rowEl(r: Row): HTMLElement {
    const row = document.createElement('div');
    row.className = 'vp-row';
    const k = kindOf(r.path, r.dir);
    const icon = document.createElement('span');
    icon.className = `vp-icon k-${k}`;
    icon.textContent = iconChar(k);
    const name = document.createElement('span');
    name.className = 'vp-name';
    name.textContent = r.dir ? `${r.name}/` : r.name;
    name.title = r.dir ? `进入 ${r.name}` : k === 'md' || k === 'image' || k === 'text'
      ? `点击预览 ${r.name}` : k === 'pdf' ? '新标签打开' : '点击下载';
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
    row.addEventListener('click', () => void activate(r));
    return row;
  }

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

  async function activate(r: Row): Promise<void> {
    if (!cfg) return;
    if (r.dir) { dir = r.path.split('/'); view = 'browse'; render(); return; }
    const k = kindOf(r.path, false);
    if (k === 'doc' || k === 'other') { void grab(r.path); return; }
    if (k === 'pdf') {
      say('打开 pdf 中…');
      try {
        const blob = await fetchContent(cfg, r.path, true) as Blob;
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        say('pdf 已在新标签打开');
      } catch (err) { say(contentErrorText(err, r.name)); }
      return;
    }
    spin(true);
    say('加载内容…');
    try {
      const wantBlob = k === 'image';
      const content = await fetchContent(cfg, r.path, wantBlob);
      if (wantBlob) {
        releaseUrl();
        objectUrl = URL.createObjectURL(content as Blob);
        view = 'image';
        body.textContent = '';
        const img = document.createElement('img');
        img.className = 'vp-image';
        img.src = objectUrl;
        img.alt = r.name;
        body.append(img);
        renderCrumb();
        say(`${r.name} · ${sizeLabel(r.size)}`);
        return;
      }
      const text = content as string;
      if (k === 'md') {
        view = 'md';
        body.textContent = '';
        const art = document.createElement('div');
        art.className = 'vp-md';
        art.innerHTML = mdLite(text);
        body.append(art);
      } else {
        view = 'text';
        body.textContent = '';
        const pre = document.createElement('pre');
        pre.className = 'vp-text';
        pre.textContent = text.slice(0, 200000);
        body.append(pre);
      }
      renderCrumb();
      body.scrollTop = 0;
      say(`${r.name} · ${sizeLabel(r.size)}`);
    } catch (err) {
      say(contentErrorText(err, r.name));
    } finally {
      spin(false);
    }
  }

  /* ---------------- 视图 ---------------- */

  function renderBrowse(): void {
    const q = search.value.trim();
    const rows = q ? searchRows(q) : buildRows();
    body.textContent = '';
    if (!tree) { renderMissing(); return; }
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'vp-empty';
      empty.textContent = q ? `没有文件名包含「${q}」`
        : '仓库里还没有文件 · 去 GitHub 上传学习文件后点「⟳ 同步」';
      body.append(empty);
      return;
    }
    const list = document.createElement('div');
    list.className = 'vp-list';
    for (const r of rows) list.append(rowEl(r));
    body.append(list);
    if (q) say(`全库搜索 · ${rows.length} 个结果${tree && tree.truncated ? '（树不完整）' : ''}`);
  }

  /** 仓库不存在/为空时的引导 */
  function renderMissing(): void {
    body.textContent = '';
    const box = document.createElement('div');
    box.className = 'vp-empty';
    box.innerHTML =
      '还没关联到仓库，三步接上：<br>' +
      '1. GitHub 新建一个<strong>公开</strong>仓库（如 study-vault）<br>' +
      '2. 把学习文件传进去（网页上直接拖整个文件夹即可）<br>' +
      '3. 点右上 <strong>⚙ 设置</strong> 填 用户名/仓库名/分支，保存后自动同步';
    body.append(box);
  }

  function renderSettings(): void {
    if (!cfg) return;
    body.textContent = '';
    view = 'settings';
    renderCrumb();
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
        view = 'browse';
        dir = [];
        await refresh(true);
      })();
    });
    const tip = document.createElement('div');
    tip.className = 'vp-tip';
    tip.textContent = '要求公开仓库；分支一般填 main';
    form.append(save, tip);
    body.append(form);
    repoIn.focus();
  }

  function render(): void {
    renderCrumb();
    if (view === 'settings') { renderSettings(); return; }
    if (view === 'browse') { renderBrowse(); }
    footText();
  }

  function footText(): void {
    if (!tree) {
      say(cfg ? `${cfg.repo} · ${cfg.branch} · 尚未同步` : '');
      return;
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
      if (view === 'browse') render();
      markSub();
    } catch (err) {
      const kind = (err as { kind?: string })?.kind;
      if (kind === 'missing') {
        say(`GitHub 上没有 ${cfg.repo} 这个仓库`);
        if (view === 'browse') renderMissing();
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
    view = 'browse';
    if (!cfg) cfg = await loadCfg();
    tree = cachedTree();
    if (tree && (tree.repo !== cfg.repo || tree.branch !== cfg.branch)) tree = null;
    render();
    await refresh(false);
  }

  syncBtn.addEventListener('click', () => { void refresh(true); });
  zipBtn.addEventListener('click', () => { if (cfg) window.open(zipUrl(cfg), '_blank', 'noopener,noreferrer'); });
  cfgBtn.addEventListener('click', () => { view = 'settings'; renderSettings(); });
  closeBtn.addEventListener('click', close);
  search.addEventListener('input', () => { if (view === 'browse') renderBrowse(); });

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || el.hidden) return;
    if (view !== 'browse' && view !== 'settings') { view = 'browse'; render(); return; }
    ev.stopImmediatePropagation();
    close();
  };
  window.addEventListener('keydown', onKey, true);

  return {
    open() { void open(); },
    close,
    isOpen,
    destroy() { window.removeEventListener('keydown', onKey, true); close(); el.remove(); }
  };
}
