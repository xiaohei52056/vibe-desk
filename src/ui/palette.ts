/**
 * 命令面板：搜索与整理的唯一入口。
 *
 * 刻意没有「笔记列表页」。一旦有了列表页，下一步就会长出排序条、筛选器、
 * 分页和「共 42 篇」——那就变成看板了。这里的原则是：
 *   · 索引常驻，界面临时。按 `/` 才出现，Esc 就走；
 *   · 默认只给「最近动过的五篇」，不给全量；
 *   · 整理靠查询语法（`#标签`）和标签条，不靠栏目标签页。
 *
 * 复用原型的面板样式：纸面、细边、等宽小字。它属于「工具」，不属于「仪表盘」。
 */
import type { SceneName } from '../core/state';
import {
  recentNotes, searchByTag, searchDecisions, searchNotes, topTags,
  type DecHit, type Hit
} from '../search/indexer';
import { isReady } from '../notes/store';
import { MOD_KEY } from './platform';

export type PaletteMode = 'search' | 'command';

export interface PaletteHooks {
  /** 跳到某篇笔记：可选直接进书写态、并把光标放到标题上 */
  openNote(id: string, opts?: { write?: boolean; title?: boolean }): void;
  /** 命中一条决策：打开它所在的笔记，并把那条就地展开 */
  openDecision(noteId: string, decId: string): void;
  createNote(): void;
  goScene(scene: SceneName): void;
  closeStation(): void;
  /** 导出一份人能读的 JSON；导入是替换式（调用方负责提示） */
  exportData(): void;
  importData(): void;
  /** 云端拉取：Spring Boot 后端 → 本地（替换式，调用方确认） */
  pullCloud(): void;
  /** 云端推送：本地 → Spring Boot 后端（替换式，调用方确认） */
  pushCloud(): void;
}

type Row =
  | { kind: 'note'; id: string; label: string; snippet: string; meta: string }
  | { kind: 'dec'; id: string; noteId: string; label: string; snippet: string; meta: string }
  | { kind: 'cmd'; label: string; meta: string; run: () => void };

interface Cmd {
  label: string;
  meta: string;
  run: () => void;
}

export class Palette {
  private opened = false;
  private sel = 0;
  private rows: Row[] = [];
  private input: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private footEl: HTMLElement | null = null;
  private tagsEl: HTMLElement | null = null;
  private cmds: Cmd[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: PaletteHooks
  ) {
    this.root.addEventListener('mousedown', ev => {
      if (ev.target === this.root) this.close();
    });
    this.buildCommands();
  }

  private buildCommands(): void {
    this.cmds = [
      { label: '新建笔记', meta: '创建', run: () => this.hooks.createNote() },
      { label: '学习星系', meta: '飞向', run: () => this.hooks.goScene('study') },
      { label: '银河层', meta: '回到', run: () => this.hooks.goScene('galaxy') },
      { label: '代码星系', meta: '飞向', run: () => this.hooks.goScene('code') },
      { label: '收站', meta: 'Esc', run: () => this.hooks.closeStation() },
      { label: '导出全部数据', meta: 'JSON', run: () => this.hooks.exportData() },
      { label: '导入数据（替换）', meta: 'JSON', run: () => this.hooks.importData() },
      { label: '强制云端覆盖本地', meta: '手动', run: () => this.hooks.pullCloud() },
      { label: '云端推送（覆盖云端）', meta: 'MySQL', run: () => this.hooks.pushCloud() }
    ];
  }

  get isOpen(): boolean { return this.opened; }

  open(mode: PaletteMode = 'search', initial?: string): void {
    if (this.opened) { this.input?.focus(); return; }
    this.opened = true;
    this.root.classList.remove('hidden');
    this.root.innerHTML = `
      <div class="p-wrap" role="dialog" aria-label="搜索与命令">
        <div class="p-head"><h2>${mode === 'command' ? '命令' : '搜索 · 飞向目标'}</h2>
          <span>/ 搜索　${MOD_KEY('K')} 命令　↑↓ 选择　Enter 直达　Esc 关闭</span></div>
        <input class="p-input" id="p-input" data-editor spellcheck="false" autocomplete="off"
               placeholder="搜标题、正文、标签；#标签 按标签筛；> 只看命令">
        <div class="p-tags" id="p-tags"></div>
        <div class="p-list" id="p-list"></div>
        <div class="p-foot" id="p-foot"></div>
      </div>`;

    this.input = this.root.querySelector<HTMLInputElement>('#p-input');
    this.listEl = this.root.querySelector<HTMLElement>('#p-list');
    this.footEl = this.root.querySelector<HTMLElement>('#p-foot');
    this.tagsEl = this.root.querySelector<HTMLElement>('#p-tags');

    const input = this.input;
    if (input) {
      input.value = initial ?? (mode === 'command' ? '>' : '');
      input.addEventListener('input', () => this.filter());
      input.addEventListener('keydown', ev => {
        // 面板里的键一律不许冒到全局：否则在输入框里按 n 会新建一篇笔记
        ev.stopPropagation();
        if (ev.key === 'Escape') { ev.preventDefault(); this.close(); return; }
        if (ev.key === 'ArrowDown') { ev.preventDefault(); this.move(1); return; }
        if (ev.key === 'ArrowUp') { ev.preventDefault(); this.move(-1); return; }
        if (ev.key === 'Tab') { ev.preventDefault(); this.move(ev.shiftKey ? -1 : 1); return; }
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const row = this.rows[this.sel];
          if (row) this.choose(row);
        }
      });
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }

    this.filter();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.classList.add('hidden');
    this.root.textContent = '';
    this.input = null;
    this.listEl = null;
    this.footEl = null;
    this.tagsEl = null;
    this.rows = [];
    this.sel = 0;
  }

  /** 索引或笔记变了：面板开着就原地重算，不重开 */
  refresh(): void {
    if (this.opened) this.filter();
  }

  /* ------------------------------------------------------------------ */

  private filter(): void {
    const raw = this.input?.value ?? '';
    const q = raw.trim();
    const notes: Hit[] = [];
    const decs: DecHit[] = [];
    const cmds: Cmd[] = [];
    let foot = '空间负责偶遇，索引负责「一定找得到」';
    let tags: { tag: string; count: number }[] = [];

    if (!q) {
      // 首次启动时 IndexedDB 还在开：别用「最近动过」这种肯定句骗人
      notes.push(...recentNotes(isReady() ? 4 : 0));
      tags = topTags(6);
      cmds.push(...this.cmds);
      foot = isReady()
        ? '最近动过 · 点标签按标签筛 · `>` 只看命令'
        : '索引准备中…';
    } else if (q.startsWith('>')) {
      const key = q.slice(1).trim();
      cmds.push(...this.cmds.filter(c => !key || c.label.includes(key)));
    } else if (q.startsWith('#')) {
      notes.push(...searchByTag(q));
      foot = notes.length ? `标签 ${q}` : `还没有笔记用 ${q} 这个标签`;
    } else {
      notes.push(...searchNotes(q));
      // 决策也进搜索：命中后直接打开所在笔记并展开那一条，不做决策列表
      decs.push(...searchDecisions(q));
      cmds.push(...this.cmds.filter(c => c.label.includes(q)));
      const total = notes.length + decs.length;
      foot = total ? `${total} 条命中` : '没有命中 · 换个词，或试试标签';
    }

    this.rows = [
      ...notes.map(n => ({ kind: 'note' as const, id: n.id, label: n.title, snippet: n.snippet, meta: n.meta })),
      ...decs.map(d => ({
        kind: 'dec' as const, id: d.id, noteId: d.noteId,
        label: d.title, snippet: d.snippet, meta: d.meta
      })),
      ...cmds.map(c => ({ kind: 'cmd' as const, label: c.label, meta: c.meta, run: c.run }))
    ];
    if (this.sel >= this.rows.length) this.sel = Math.max(0, this.rows.length - 1);
    this.draw();
    this.drawTags(tags);
    if (this.footEl) this.footEl.textContent = foot;
  }

  private draw(): void {
    const list = this.listEl;
    if (!list) return;
    list.textContent = '';

    this.rows.forEach((row, i) => {
      const el = document.createElement('div');
      const dec = row.kind === 'dec';
      el.className = 'p-row'
        + (i === this.sel ? ' sel' : '')
        + (row.kind === 'cmd' ? ' cmd' : '')
        + (dec ? ' dec' : '');
      el.dataset['i'] = String(i);

      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = row.kind === 'note'
        ? String(i + 1).padStart(2, '0')
        : dec ? '决' : '·';

      const n = document.createElement('span');
      n.className = 'n';
      const b = document.createElement('b');
      b.textContent = row.label;
      n.appendChild(b);
      if (row.kind !== 'cmd' && row.snippet) {
        const small = document.createElement('small');
        small.textContent = row.snippet;
        n.appendChild(small);
      }

      const t = document.createElement('span');
      t.className = 't';
      t.textContent = row.meta;

      el.append(k, n, t);
      el.addEventListener('mouseenter', () => { this.sel = i; this.syncSel(); });
      el.addEventListener('mousedown', ev => { ev.preventDefault(); this.choose(row); });
      list.appendChild(el);
    });

    if (!this.rows.length) {
      const empty = document.createElement('div');
      empty.className = 'p-empty';
      empty.textContent = '没有匹配的笔记';
      list.appendChild(empty);
    }

  }

  /** 标签条常驻在滚动区之外：它是「整理」的入口，不该被列表滚走 */
  private drawTags(tags: { tag: string; count: number }[]): void {
    const bar = this.tagsEl;
    if (!bar) return;
    bar.textContent = '';
    bar.classList.toggle('on', tags.length > 0);
    for (const t of tags) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = `#${t.tag}`;
      chip.title = `${t.count} 篇`;
      chip.addEventListener('mousedown', ev => {
        ev.preventDefault();
        if (this.input) {
          this.input.value = `#${t.tag}`;
          this.input.focus();
        }
        this.sel = 0;
        this.filter();
      });
      bar.appendChild(chip);
    }
  }

  private syncSel(): void {
    this.listEl?.querySelectorAll<HTMLElement>('.p-row').forEach(el => {
      el.classList.toggle('sel', Number(el.dataset['i']) === this.sel);
    });
  }

  private move(d: number): void {
    if (!this.rows.length) return;
    this.sel = (this.sel + d + this.rows.length) % this.rows.length;
    this.syncSel();
    const cur = this.listEl?.querySelector<HTMLElement>('.p-row.sel');
    cur?.scrollIntoView({ block: 'nearest' });
  }

  private choose(row: Row): void {
    this.close();
    if (row.kind === 'note') this.hooks.openNote(row.id, { write: false });
    else if (row.kind === 'dec') this.hooks.openDecision(row.noteId, row.id);
    else row.run();
  }
}
