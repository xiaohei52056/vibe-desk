/**
 * 编辑器：CodeMirror 6，对外只暴露四个方法。
 *
 * 这层包装的存在意义是隔离 —— CM 的 View/State/Transaction 类型一律不外泄，
 * 业务层只认识 getText / setText / focus / destroy。将来换编辑器不会波及面板。
 *
 * 两个刻意的取舍：
 *   · 不装 indentWithTab —— Tab 在这个应用里是「切换工位」，不能被编辑器吃掉；
 *   · 不装自动补全与 lint —— 它们是给代码用的，笔记里只会变成打扰。
 *     双链补全留到 P5.4 单独做，那时才需要它。
 */
import { EditorState, Compartment, Range } from '@codemirror/state';
import {
  EditorView, keymap, drawSelection, highlightActiveLine, placeholder as cmPlaceholder,
  Decoration, WidgetType, ViewPlugin, type DecorationSet, type ViewUpdate
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { IMG_RE, assetUrl } from './images';

const paperTheme = EditorView.theme({
  '&': {
    height: '100%',
    // 字号走 CSS 变量：大屏上随视口放大（write.css 里用 clamp 定义 --doc-size），
    // 固定 14px 在 4K / 宽屏上面板一大就显得又小又糊
    fontSize: 'var(--doc-size, 15.5px)',
    color: '#1F2A38',
    backgroundColor: 'transparent',
    '-webkit-font-smoothing': 'subpixel-antialiased'
  },
  '.cm-scroller': {
    fontFamily: 'var(--serif)',
    lineHeight: '1.92',
    overflow: 'auto',
    padding: '4px 0 40px'
  },
  '.cm-content': { padding: '0', caretColor: '#A9813F' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: '#A9813F', borderLeftWidth: '1.5px' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(201,160,99,.24)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(201,160,99,.28)' },
  '.cm-activeLine': { backgroundColor: 'rgba(201,160,99,.06)' },
  '.cm-placeholder': { color: '#B6AD9B' },
  // 代码块 token：暖墨五色，够读就行。由 codeHi 插件打标记，不依赖嵌套解析
  '.tok-kw': { color: '#9A5B2E' },
  '.tok-str': { color: '#5F7A52' },
  '.tok-num': { color: '#8A6D3B' },
  '.tok-com': { color: '#A39A88', fontStyle: 'italic' },
  '.tok-type': { color: '#4F6A85' },
  // 粘贴进来的截图：以内联缩略图显示，点击看原图
  '.cm-img': { display: 'inline-block', verticalAlign: 'middle', padding: '4px 0' },
  '.cm-img img': {
    display: 'block', maxWidth: '100%', maxHeight: '260px',
    borderRadius: '4px', border: '1px solid rgba(90,106,130,.28)', cursor: 'zoom-in'
  },
  '.cm-img-loading': { fontFamily: 'var(--mono)', fontSize: '.78em', color: '#9A907C' }
}, { dark: false });

/** 暖墨高亮：标题略重、链接偏金、代码偏灰，不用任何亮色 */
const inkHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.5em', fontWeight: '500', color: '#1E2836' },
  { tag: tags.heading2, fontSize: '1.26em', fontWeight: '500', color: '#1E2836' },
  { tag: tags.heading3, fontSize: '1.1em', fontWeight: '500', color: '#28323F' },
  { tag: tags.strong, fontWeight: '600', color: '#1B2532' },
  { tag: tags.emphasis, fontStyle: 'italic', color: '#3A4655' },
  { tag: tags.link, color: '#A9813F' },
  { tag: tags.url, color: '#A9813F' },
  { tag: tags.monospace, fontFamily: 'var(--mono)', fontSize: '.92em', color: '#6B6252' },
  { tag: tags.quote, color: '#6E6656', fontStyle: 'italic' },
  { tag: tags.list, color: '#7A6B52' },
  { tag: tags.comment, color: '#8A8272' },
  { tag: tags.meta, color: '#9A907C' }
]);

export interface EditorHandle {
  getText(): string;
  setText(text: string): void;
  focus(): void;
  /** 布局变化后强制重测（站体展开时容器宽度会变） */
  measure(): void;
  /** 光标移到文末；select=false 表示不选中 */
  toEnd(select?: boolean): void;
  /** 跳到第 n 行（1 起），并滚动到可见处 */
  gotoLine(line: number): void;
  /** 在光标处插入一段文本（沙盒输出回写用） */
  insertAtCursor(text: string): void;
  /** 光标所在的 ``` 代码块；不在块里就是 null */
  codeAtCursor(): { code: string; lang: string; fromLine: number } | null;
  /** 完整编辑器状态（含撤销历史）：拆编辑器前存起来，重挂时接上 */
  getState(): EditorState;
  destroy(): void;
}

export interface EditorOptions {
  onChange(text: string): void;
  onSave(): void;
  /** 粘贴图片：交给面板存进 assets 表，返回资源 id；不给就按纯文本粘贴 */
  onImage?(blob: Blob): Promise<string>;
}

/* ---------------- 图片：asset 引用渲染成内联缩略图 ---------------- */

class ImageWidget extends WidgetType {
  constructor(private readonly id: string, private readonly alt: string) { super(); }

  override eq(other: ImageWidget): boolean { return other.id === this.id && other.alt === this.alt; }

  override toDOM(): HTMLElement {
    const box = document.createElement('span');
    box.className = 'cm-img';
    box.title = this.alt || '图片';
    const ph = document.createElement('span');
    ph.className = 'cm-img-loading';
    ph.textContent = '载入图片…';
    box.appendChild(ph);
    void assetUrl(this.id).then(url => {
      if (!url) { ph.textContent = '图片缺失'; return; }
      const img = document.createElement('img');
      img.src = url;
      img.alt = this.alt;
      img.addEventListener('load', () => ph.remove());
      img.addEventListener('click', () => window.open(url, '_blank'));
      box.appendChild(img);
    });
    return box;
  }

  /** 点击是「看原图」，不该让编辑器把它当成选中文本 */
  override ignoreEvent(): boolean { return true; }
}

function buildImageDeco(view: EditorView): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const sel = view.state.selection.main;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    IMG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMG_RE.exec(text)) !== null) {
      const start = from + m.index;
      const end = start + m[0].length;
      // 光标落在语法里时不替换 —— 否则正在改这行的人看不见自己在打什么
      if (start <= sel.to && end >= sel.from) continue;
      marks.push(Decoration.replace({ widget: new ImageWidget(m[2]!, m[1]!) }).range(start, end));
    }
  }
  return Decoration.set(marks, true);
}

const imageDeco = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildImageDeco(view); }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = buildImageDeco(u.view);
  }
}, { decorations: v => v.decorations });

/** 代码块按围栏语言染色：沙盒只跑这两种，正文里也该认得出它们 */
const JAVA_KW = new Set(('abstract assert boolean break byte case catch char class const continue default do double else ' +
  'enum extends final finally float for if implements import instanceof int interface long new package private protected ' +
  'public return short static super switch synchronized this throw throws try void volatile while var record sealed ' +
  'permits yield true false null').split(' '));
const PY_KW = new Set(('and as assert async await break class continue def del elif else except finally for from global ' +
  'if import in is lambda nonlocal not or pass raise return try while with yield match case True False None self').split(' '));

const fenceLang = (info: string): 'java' | 'python' | null => {
  const l = info.trim().toLowerCase();
  if (l === 'java') return 'java';
  if (l === 'py' || l === 'python' || l === 'python3') return 'python';
  return null;
};

/**
 * 围栏代码块的轻量高亮。
 *
 * 为什么不用 markdown 的 codeLanguages 嵌套解析：实测当前
 * @lezer/markdown + @lezer/common 组合里 overlay 挂载失效
 * （官方 JS 示例都不出高亮），与其被上游 bug 绑住，
 * 不如自己扫一遍围栏 —— 只要关键字/字符串/数字/注释/类型五类，
 * 一百行以内，颜色还能跟「暖墨」配色一致。
 */
const TOKEN_RE = /(\/\/[^\n]*|#[^\n]*|\/\*[^\n]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)/g;

function markCodeLine(out: Range<Decoration>[], text: string, base: number, lang: 'java' | 'python'): void {
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const from = base + m.index;
    const to = from + m[0].length;
    if (m[1]) {
      // `#` 只有 Python 是注释；Java 里那是非法字符，不染
      if (m[1].startsWith('#') && lang !== 'python') continue;
      out.push(Decoration.mark({ class: 'tok-com' }).range(from, to));
    } else if (m[2]) {
      out.push(Decoration.mark({ class: 'tok-str' }).range(from, to));
    } else if (m[3]) {
      out.push(Decoration.mark({ class: 'tok-num' }).range(from, to));
    } else if (m[4]) {
      const w = m[4];
      if ((lang === 'java' ? JAVA_KW : PY_KW).has(w)) out.push(Decoration.mark({ class: 'tok-kw' }).range(from, to));
      else if (/^[A-Z]/.test(w)) out.push(Decoration.mark({ class: 'tok-type' }).range(from, to));
    }
  }
}

function buildCodeDeco(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  // 先整体扫一遍围栏边界（行级扫描，千行量级可以忽略）
  interface Blk { lang: 'java' | 'python' | null; from: number; to: number }
  const blocks: Blk[] = [];
  let open: { lang: 'java' | 'python' | null; line: number } | null = null;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (!/^\s*```/.test(line.text)) continue;
    if (!open) {
      open = { lang: fenceLang(line.text.trim().replace(/^```/, '')), line: i };
    } else {
      blocks.push({ lang: open.lang, from: doc.line(open.line).to + 1, to: line.from });
      open = null;
    }
  }

  const out: Range<Decoration>[] = [];
  if (!blocks.length) return Decoration.none;
  for (const { from, to } of view.visibleRanges) {
    for (const b of blocks) {
      if (!b.lang) continue;
      const start = Math.max(from, b.from);
      const end = Math.min(to, b.to);
      if (start >= end) continue;
      const first = doc.lineAt(start).number;
      const last = doc.lineAt(end).number;
      for (let i = first; i <= last; i++) {
        const line = doc.line(i);
        markCodeLine(out, line.text, line.from, b.lang);
      }
    }
  }
  return Decoration.set(out, true);
}

const codeHi = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildCodeDeco(view); }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.viewportChanged) this.decorations = buildCodeDeco(u.view);
  }
}, { decorations: v => v.decorations });

/**
 * 挂编辑器。saved 传入上一次的完整状态时直接续用 ——
 * 撤销历史跟着笔记走，Ctrl+Z 能撤回到上一次书写会话之前的内容。
 * 调用方必须保证 saved 的正文与笔记当前内容一致（不一致会在状态里携带旧内容）。
 */
export function mountEditor(parent: HTMLElement, initial: string, opts: EditorOptions, saved?: EditorState): EditorHandle {
  const ph = new Compartment();

  const view = new EditorView({
    parent,
    state: saved ?? EditorState.create({
      doc: initial,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        markdown(),
        syntaxHighlighting(inkHighlight),
        paperTheme,
        imageDeco,
        codeHi,
        EditorView.domEventHandlers({
          paste(ev, view) {
            if (!opts.onImage) return false;
            const items = ev.clipboardData?.items;
            if (!items) return false;
            let file: File | null = null;
            for (const it of items) {
              if (!it.type.startsWith('image/')) continue;
              file = it.getAsFile();
              if (file) break;
            }
            if (!file) return false;
            ev.preventDefault();
            const at = view.state.selection.main;
            const blob = file;
            void opts.onImage(blob).then(id => {
              if (!id) return;
              // 独立成行：夹在段中间会把一行字劈开
              const md = `\n![图片](asset:${id})\n`;
              view.dispatch({
                changes: { from: at.from, to: at.to, insert: md },
                selection: { anchor: at.from + md.length },
                scrollIntoView: true
              });
            }).catch(err => console.warn('[image] 粘贴失败', err));
            return true;
          }
        }),
        ph.of(cmPlaceholder('写点什么。用 [[双链]] 连到别的笔记，用 #标签 归类。')),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => { opts.onSave(); return true; }
          },
          ...historyKeymap,
          ...defaultKeymap
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged) opts.onChange(update.state.doc.toString());
        })
      ]
    })
  });

  return {
    getText: () => view.state.doc.toString(),
    setText: (text: string) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text }
      });
    },
    focus: () => view.focus(),
    measure: () => view.requestMeasure(),
    toEnd: (select = false) => {
      const len = view.state.doc.length;
      view.dispatch({ selection: { anchor: select ? 0 : len, head: len } });
      view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    },
    gotoLine: (line: number) => {
      const doc = view.state.doc;
      const n = Math.max(1, Math.min(doc.lines, Math.floor(line) || 1));
      const l = doc.line(n);
      view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
      view.focus();
    },
    codeAtCursor: () => {
      const doc = view.state.doc;
      const pos = view.state.selection.main.head;
      let openIdx = -1;
      let lang = '';
      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        if (!line.text.trimStart().startsWith('```')) continue;
        if (openIdx < 0) {
          openIdx = i;
          lang = line.text.trim().slice(3).trim();
          continue;
        }
        // 光标落在「开围栏之后、闭围栏之前」才算在这个块里
        const from = doc.line(openIdx).to + 1;
        if (pos >= from && pos <= line.from) {
          const to = Math.max(from, line.from - 1);
          return { code: doc.sliceString(from, to), lang, fromLine: openIdx + 1 };
        }
        openIdx = -1;
      }
      return null;
    },
    insertAtCursor: (text: string) => {
      const at = view.state.selection.main;
      view.dispatch({
        changes: { from: at.from, to: at.to, insert: text },
        selection: { anchor: at.from + text.length },
        scrollIntoView: true
      });
      view.focus();
    },
    getState: () => view.state,
    destroy: () => {
      view.destroy();
      parent.textContent = '';
      void ph;
    }
  };
}
