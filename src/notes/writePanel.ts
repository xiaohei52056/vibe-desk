/**
 * 书写态面板：标题 + 正文 + 脚注。
 *
 * 刻意的克制：
 *   · 没有工具条。加粗靠 `**`，链接靠 `[[`，标题靠 `#` —— 这些都是可读的源码，
 *     不需要按钮把它们藏起来；
 *   · 没有保存按钮。停下来 500ms 就落盘，脚注只用一个词告诉你「已保存」；
 *   · 没有字数环、没有成熟度进度条。成熟度只是脚注里三个字。
 */
import type { EditorHandle } from './editor';
import type { EditorState } from '@codemirror/state';
import { saveImage } from './images';
import { noteOf, patchNote, backlinksOf, onNotes } from './store';
import { countWords, maturityOf, parseTags } from './parse';
import {
  addDecision, decisionsFor, onDecisions, removeDecision, splitOpts
} from './decisions';
import { toast } from '../ui/toast';
import { MOD_KEY } from '../ui/platform';

export interface WritePanelHooks {
  /**
   * 点反链跳到另一颗恒星。
   * 带上「从哪来」是为了走那条关联 —— 只有顺着引用跳过去才算走过（Hebbian）。
   */
  onJump(id: string, from: string): void;
}

const SAVE_DELAY = 500;

export class WritePanel {
  private id: string | null = null;
  private handle: EditorHandle | null = null;
  private timer = 0;
  private seq = 0;
  private dirty = false;
  private loading: string | null = null;
  /** 新建笔记时要停在标题上：标记在这里，由挂载完成后的回调消费 */
  private wantTitle = false;
  /** 展开的是哪一条决策（只记 id，不存整条 —— 记录以 Map 为准） */
  private decOpen: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeDec: (() => void) | null = null;
  private runner: { dispose(): void } | null = null;
  /**
   * 每篇笔记的编辑器完整状态（含撤销历史）。
   * 拆编辑器前存、重挂时接上 —— 内容撤回（Ctrl+Z）跨工位、跨开关都有效。
   * 上限 40 篇：超出的按最旧淘汰，避免长期占内存。
   */
  private readonly drafts = new Map<string, EditorState>();

  constructor(private readonly hooks: WritePanelHooks) {
    const title = this.el<HTMLInputElement>('note-title');
    title?.addEventListener('input', () => {
      this.dirty = true;
      this.paintSave('未保存');
      this.schedule();
    });
    title?.addEventListener('keydown', ev => {
      // 标题里按回车 = 直接进正文，不要新起一行
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.handle?.focus();
      }
    });
    this.unsubscribe = onNotes(() => this.paintMeta());
    this.unsubscribeDec = onDecisions(() => this.renderDecisions());
    // 决策区默认折叠；点标题行就地展开，不弹窗、不换页
    this.el('dec-head')?.addEventListener('click', () => this.toggleDecisions());
  }

  private el<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  private get titleEl(): HTMLInputElement | null { return this.el<HTMLInputElement>('note-title'); }
  private get hostEl(): HTMLElement | null { return this.el('note-host'); }

  async open(id: string): Promise<void> {
    const note = noteOf(id);
    if (!note) return;
    if (this.id === id && this.handle) { this.handle.focus(); return; }
    if (this.loading === id) return;          // 同一篇正在加载，别重入

    await this.flush();
    // 必须 await：teardown 里会把 seq 加一，不等它完成就往下走，
    // 本次加载会被自己的 seq 判定为「过期」，编辑器永远挂不上。
    await this.teardown();

    this.id = id;
    this.loading = id;
    const mine = ++this.seq;

    const title = this.titleEl;
    if (title) title.value = note.title;

    this.paintMeta();
    this.paintSave('已保存');
    this.renderDecisions();

    const host = this.hostEl;
    if (!host) return;
    try {
      const { mountEditor } = await import('./editor');
      if (mine !== this.seq) return;          // 期间切了别的笔记，丢弃这次加载
      this.loading = null;
      host.textContent = '';
      // 恢复撤销历史：缓存的编辑器状态只有在正文一致时才可用 ——
      // 内容被导入等外部途径改过就丢弃，绝不能拿旧状态覆盖新内容。
      const saved = this.drafts.get(id);
      const fromSaved = saved && saved.doc.toString() === note.body ? saved : undefined;
      if (saved && !fromSaved) this.drafts.delete(id);
      this.handle = mountEditor(host, note.body, {
        onChange: text => {
          this.dirty = true;
          this.paintSave('未保存');
          this.schedule(text);
        },
        onSave: () => { void this.flush(); },
        // 粘贴截图：存进 assets 表，正文只落一行引用
        onImage: async blob => {
          try {
            const row = await saveImage(blob);
            return row.id;
          } catch (err) {
            console.warn('[image] 保存失败', err);
            toast('图片没能存进来 · 存储不可用');
            return '';
          }
        }
      }, fromSaved);
      // 站体从观看态展开到书写态有 420ms，等布局稳定再测量，否则 CM 会按 0 宽排版
      window.setTimeout(() => { if (mine === this.seq) this.handle?.measure(); }, 460);
      window.setTimeout(() => {
        if (mine !== this.seq) return;
        // 新建笔记：停在标题上，并全选，让你直接打字覆盖
        if (this.wantTitle) {
          this.wantTitle = false;
          const t = this.titleEl;
          t?.focus();
          t?.select();
          return;
        }
        this.handle?.focus();
        // 只有空笔记才把光标送到文末；已有的笔记停在开头，
        // 进站是为了接着读，不是为了接着写
        if (!note.body.trim()) this.handle?.toEnd(false);
      }, 120);
    } catch (err) {
      this.loading = null;
      console.warn('[editor] 加载失败', err);
      if (host) host.textContent = '编辑器加载失败 · 内容仍可从观看态查看';
    }
  }

  private schedule(body?: string): void {
    if (body !== undefined) this.pendingBody = body;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.flush(); }, SAVE_DELAY);
  }

  private pendingBody: string | undefined;

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.id || !this.dirty) return;
    const id = this.id;
    const titleEl = this.titleEl;
    const body = this.pendingBody ?? this.handle?.getText() ?? noteOf(id)?.body ?? '';
    const title = (titleEl?.value ?? '').trim() || '无标题';
    this.paintSave('保存中…');
    try {
      await patchNote(id, { title, body });
      this.pendingBody = undefined;
      if (this.id === id) {
        this.dirty = false;
        this.paintSave('已保存');
        this.paintMeta();
      }
    } catch (err) {
      console.warn('[notes] 保存失败', err);
      this.paintSave('保存失败', 'err');
    }
  }

  /** 离开书写态：先把没落盘的内容写掉，再把撤销历史存下来，最后拆编辑器 */
  async teardown(): Promise<void> {
    await this.flush();
    // 沙盒先收：正在跑的 while(true) 不能留在页面背后
    this.runner?.dispose();
    if (this.id && this.handle) {
      if (this.drafts.size >= 40) {
        const oldest = this.drafts.keys().next().value;
        if (oldest !== undefined) this.drafts.delete(oldest);
      }
      this.drafts.set(this.id, this.handle.getState());
    }
    this.handle?.destroy();
    this.handle = null;
    this.id = null;
    this.loading = null;
    this.wantTitle = false;
    this.pendingBody = undefined;
    this.decOpen = null;
    this.closeDecForm();
    const box = this.el('decisions');
    if (box) {
      box.dataset['open'] = '0';
      const body = this.el('dec-body');
      if (body) body.textContent = '';
    }
    this.seq++;
  }

  /**
   * 新建笔记：光标直接落在标题上并全选。
   * 编辑器是异步挂载的，所以先记一个标记，由挂载回调消费；
   * 如果已经挂上了，就立刻生效。两种时序都要能落在标题上。
   */
  requestTitleFocus(): void {
    this.wantTitle = true;
    if (!this.handle) return;
    const t = this.titleEl;
    if (!t) return;
    this.wantTitle = false;
    t.focus();
    t.select();
  }

  /** 站体尺寸变化（展开 / 收回）后要重新测量 */
  measure(): void {
    this.handle?.measure();
  }

  /** 沙盒面板挂在书写态上：站体收起时由它自己杀掉还在跑的脚本 */
  attachRunner(runner: { dispose(): void }): void {
    this.runner = runner;
  }

  /** 沙盒用：光标所在的代码块 */
  codeAtCursor(): { code: string; lang: string; fromLine: number } | null {
    return this.handle?.codeAtCursor() ?? null;
  }

  /** 沙盒用：点错误行跳回正文对应行 */
  gotoLine(line: number): void {
    this.handle?.gotoLine(line);
  }

  focusBody(): void {
    this.handle?.focus();
  }

  /** 沙盒输出回写：作为 text 代码块插到光标处 —— 输出是「证据」，不是装饰 */
  insertOutput(text: string): void {
    const t = text.replace(/\s+$/, '');
    if (!t) { toast('没有可插入的输出'); return; }
    if (!this.handle) { toast('先进入书写态'); return; }
    this.handle.insertAtCursor('\n```text\n' + t + '\n```\n');
    toast('输出已插入正文');
  }

  get mountedFor(): string | null { return this.id; }

  /* ---------------- 决策日志 · 笔记的脚注 ---------------- */

  /** 展开 / 收起。展开不换页、不弹窗，就在原地长出来 */
  toggleDecisions(force?: boolean): void {
    const box = this.el<HTMLElement>('decisions');
    if (!box) return;
    const open = force !== undefined ? force : box.dataset['open'] !== '1';
    box.dataset['open'] = open ? '1' : '0';
    if (!open) this.decOpen = null;
    this.renderDecisions();
  }

  renderDecisions(): void {
    const box = this.el<HTMLElement>('decisions');
    const sum = this.el<HTMLElement>('dec-sum');
    const body = this.el<HTMLElement>('dec-body');
    const toggle = this.el<HTMLElement>('dec-toggle');
    if (!box || !sum || !body) return;

    const list = this.id ? decisionsFor(this.id) : [];
    if (toggle) toggle.textContent = box.dataset['open'] === '1' ? '收起' : '展开';

    // 折叠时只露最近一条：问题 → 选择。理由留到展开后
    sum.textContent = '';
    if (!list.length) {
      sum.textContent = `还没有记录 · ${MOD_KEY('D')} 记一条`;
    } else {
      const q = document.createElement('i');
      q.textContent = list[0]!.q;
      sum.appendChild(q);
      sum.appendChild(document.createTextNode(' → ' + list[0]!.pick));
    }

    body.textContent = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'dec-empty';
      empty.textContent = '当初为什么这么写，记在这儿一行。不写也不会怎样。';
      body.appendChild(empty);
      return;
    }

    for (const d of list) {
      const it = document.createElement('div');
      it.className = 'dec-item' + (this.decOpen === d.id ? ' on' : '');
      it.dataset['dec'] = d.id;

      const q = document.createElement('div');
      q.className = 'q';
      q.textContent = d.q;

      const pick = document.createElement('div');
      pick.className = 'pick';
      pick.appendChild(document.createTextNode('选了 '));
      const em = document.createElement('em');
      em.textContent = d.pick;
      pick.appendChild(em);
      const others = d.opts.filter(o => o !== d.pick);
      if (others.length) pick.appendChild(document.createTextNode('　另选 ' + others.join(' / ')));

      const why = document.createElement('div');
      why.className = 'why';
      why.textContent = d.why || '（当时没写理由）';

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = new Date(d.at).toISOString().slice(0, 10);
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '删除这条';
      del.addEventListener('click', ev => {
        ev.stopPropagation();
        if (this.decOpen === d.id) this.decOpen = null;
        void removeDecision(d.id).catch(err => console.warn('[decisions] 删除失败', err));
      });
      meta.appendChild(del);

      it.append(q, pick, why, meta);
      it.addEventListener('click', () => {
        this.decOpen = this.decOpen === d.id ? null : d.id;
        this.renderDecisions();
      });
      body.appendChild(it);
    }
  }

  /** Cmd+D：就地记一条。只有打开了笔记才允许 */
  openDecisionForm(): void {
    if (!this.id) { toast('先打开一篇笔记，再把决策挂上去'); return; }
    this.toggleDecisions(true);
    const form = this.el<HTMLElement>('dec-form');
    if (!form) return;
    if (form.classList.contains('show')) {
      this.el<HTMLInputElement>('d-q')?.focus();
      return;
    }
    this.decOpen = null;
    form.className = 'dec-form show';
    form.innerHTML =
      '<label><span>问题</span><input id="d-q" data-editor placeholder="当初在纠结什么？" autocomplete="off"></label>' +
      '<label><span>选项</span><input id="d-opts" data-editor placeholder="用逗号分隔，可留空" autocomplete="off"></label>' +
      '<label><span>选了</span><div class="chips" id="d-chips"></div></label>' +
      '<label><span>理由</span><input id="d-why" data-editor placeholder="为什么选它，而不是别的" autocomplete="off"></label>' +
      '<div class="acts"><button type="button" id="d-save">记下</button>' +
      '<button type="button" class="ghost" id="d-cancel">取消</button></div>';

    const q = this.el<HTMLInputElement>('d-q');
    const opts = this.el<HTMLInputElement>('d-opts');
    const why = this.el<HTMLInputElement>('d-why');
    const chips = this.el<HTMLElement>('d-chips');
    let pick = '';

    const rebuild = (): void => {
      if (!chips) return;
      const arr = splitOpts(opts?.value ?? '');
      chips.textContent = '';
      if (!arr.length) {
        const hint = document.createElement('span');
        hint.className = 'chip';
        hint.style.cssText = 'border-style:dashed;color:#C0B6A2';
        hint.textContent = '先填选项';
        chips.appendChild(hint);
        pick = '';
        return;
      }
      for (const o of arr) {
        const chip = document.createElement('span');
        chip.className = 'chip' + (o === pick ? ' on' : '');
        chip.textContent = o;
        chip.addEventListener('click', () => { pick = pick === o ? '' : o; rebuild(); });
        chips.appendChild(chip);
      }
    };
    rebuild();
    opts?.addEventListener('input', rebuild);

    this.el('d-cancel')?.addEventListener('click', () => this.closeDecForm());
    this.el('d-save')?.addEventListener('click', () => {
      const text = (q?.value ?? '').trim();
      if (!text) { toast('至少写一句「当初在纠结什么」'); q?.focus(); return; }
      const noteId = this.id;
      if (!noteId) return;
      const arr = splitOpts(opts?.value ?? '');
      void addDecision({
        noteId, q: text, opts: arr,
        pick: pick || arr[0] || '',
        why: (why?.value ?? '').trim()
      }).then(row => {
        this.decOpen = row.id;
        this.closeDecForm();
        this.toggleDecisions(true);
        toast('已记下 · 挂在当前笔记底部');
      }).catch(err => {
        console.warn('[decisions] 保存失败', err);
        toast('没能记下 · 存储不可用');
      });
    });

    q?.focus();
  }

  private closeDecForm(): void {
    const form = this.el<HTMLElement>('dec-form');
    if (!form) return;
    form.className = 'dec-form';
    form.textContent = '';
  }

  /**
   * 从搜索里命中一条决策：打开它所在的笔记，并把那条就地展开。
   * 返回 false 表示面板还没挂到这篇上 —— 调用方可以隔一帧再试。
   */
  revealDecision(noteId: string, decId: string): boolean {
    if (this.id !== noteId) return false;
    this.decOpen = decId;
    const box = this.el<HTMLElement>('decisions');
    if (box) box.dataset['open'] = '1';
    this.renderDecisions();
    return true;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeDec?.();
    this.unsubscribeDec = null;
    void this.teardown();
  }

  private paintSave(text: string, cls?: 'err'): void {
    const el = this.el('save-state');
    if (!el) return;
    el.textContent = text;
    el.className = 'wc-save' + (text === '已保存' ? '' : ' dirty') + (cls === 'err' ? ' err' : '');
  }

  private paintMeta(): void {
    if (!this.id) return;
    const note = noteOf(this.id);
    if (!note) return;
    const body = this.handle?.getText() ?? note.body;
    const tags = parseTags(body);
    const meta = this.el('note-meta');
    if (meta) meta.textContent = `${maturityOf(body)} · ${countWords(body)} 字${tags.length ? ' · #' + tags.join(' #') : ''}`;

    const linksEl = this.el('note-links');
    const sep = this.el('note-sep');
    if (!linksEl || !sep) return;
    const backs = backlinksOf(note.id);
    linksEl.textContent = '';
    sep.style.display = backs.length ? '' : 'none';
    if (!backs.length) return;
    const label = document.createElement('span');
    label.textContent = '被引用 ';
    linksEl.appendChild(label);
    backs.forEach((b, i) => {
      if (i) linksEl.appendChild(document.createTextNode('、'));
      const a = document.createElement('b');
      a.textContent = b.title;
      a.title = `打开「${b.title}」`;
      a.addEventListener('click', () => this.hooks.onJump(b.id, note.id));
      linksEl.appendChild(a);
    });
  }
}
