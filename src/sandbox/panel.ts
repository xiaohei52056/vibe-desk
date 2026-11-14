/**
 * 编译实验室：书写态里的一块临时面板（只跑 Python / Java）。
 *
 * 三条克制：
 *   · 它不是一个独立页面，也不是常驻侧栏 —— `Cmd+Enter` 来，`Esc` 或「收」走；
 *   · 它不往笔记里写任何东西：输出只留在面板里。要留下什么，自己复制过去；
 *   · 它默认跑「光标所在的那个代码块」。语言按围栏标记认，
 *     没标记就从代码内容猜；面板里也随时可以点芯片切换。
 *
 * 便捷性：`Cmd+Enter` 开面板即自动运行；没有类壳的 Java 代码自动包进 Main；
 * 运行中按钮变「停止」；错误行点回正文。
 */
import { runCode, normalizeLang, sniffLang, type DoneReason, type Lang, type RunHandle, type SinkLine } from './runner';

const LS_CODE = 'vibe-runner-code';
const LS_LANG = 'vibe-runner-lang';
const LS_STDIN = 'vibe-runner-stdin';

/** 一键示例：Java 故意不给类壳 —— 正好演示自动包裹 */
const SNIPPETS: Record<Lang, string> = {
  python:
    'def fib(n):\n' +
    '    a, b = 0, 1\n' +
    '    for _ in range(n):\n' +
    '        a, b = b, a + b\n' +
    '    return a\n' +
    '\n' +
    'for i in range(10):\n' +
    '    print(f"fib({i}) = {fib(i)}")',
  java:
    'for (int i = 1; i <= 5; i++) {\n' +
    '    System.out.println("第 " + i + " 行 · Hello, VIBE");\n' +
    '}'
};

export interface RunnerHooks {
  /** 点错误行跳回编辑器；line 是笔记里的绝对行号（1 起） */
  onGoto(line: number): void;
  /** 光标所在的代码块；没有就返回 null */
  codeAtCursor(): { code: string; lang: string; fromLine: number } | null;
  /** 收面板后把焦点还给正文 */
  onFocusBack(): void;
  /** 把面板里的输出插回正文（text 代码块） */
  onInsert(text: string): void;
}

export class RunnerPanel {
  /** 正在跑的那一个 */
  private handle: RunHandle | null = null;
  /** 最近一次运行的句柄：可能已报「完成」，但晚到的输出还要进面板，下次运行才清场 */
  private frame: RunHandle | null = null;
  private fromLine = 0;
  private opened = false;
  private lang: Lang | null = null;

  constructor(private readonly hooks: RunnerHooks) {
    this.el('rn-run')?.addEventListener('click', () => this.run());
    this.el('rn-close')?.addEventListener('click', () => this.hide());
    this.el('rn-snip')?.addEventListener('click', () => this.snippet());
    this.el('rn-to-note')?.addEventListener('click', () => this.insertOutput());
    this.el('rn-in-btn')?.addEventListener('click', () => this.toggleStdin());
    for (const id of ['rn-py', 'rn-java'] as const) {
      this.el(id)?.addEventListener('click', () => {
        this.setLang(id === 'rn-py' ? 'python' : 'java');
        this.state('已选 ' + (id === 'rn-py' ? 'Python' : 'Java') + ' · Ctrl+Enter 或点运行');
      });
    }
  }

  private el<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  get isOpen(): boolean { return this.opened; }

  /** `Cmd+Enter`：没开就开（抓代码块并直接跑），开着就跑 */
  toggle(): void {
    if (!this.opened) { this.open(); return; }
    this.run();
  }

  open(): void {
    const box = this.el('runner');
    if (!box) return;
    const block = this.hooks.codeAtCursor();
    const code = this.el<HTMLTextAreaElement>('rn-code');
    if (block && code) {
      code.value = block.code;
      this.fromLine = block.fromLine;
    } else if (code && !code.value) {
      code.value = localStorage.getItem(LS_CODE) ?? '';
      this.fromLine = 0;
    }

    // 语言：围栏标记 > 内容特征 > 上次用的
    const fenced = normalizeLang(block?.lang);
    const picked = fenced ?? sniffLang(code?.value ?? '') ?? normalizeLang(localStorage.getItem(LS_LANG));
    this.setLang(picked);

    box.dataset['open'] = '1';
    this.opened = true;
    this.clearOut();
    if (block?.lang && !fenced && normalizeLang(block.lang) === null) {
      this.state(`这个块标的是 ${block.lang} · 这里只跑 Python / Java，芯片可切换`);
    } else {
      this.state('待运行 · Ctrl+Enter 或点运行');
    }
    if (code) {
      code.focus();
      code.setSelectionRange(code.value.length, code.value.length);
    }
    // 标准输入：上次写的留在面板里；有内容就把输入行展开
    const stdinEl = this.el<HTMLTextAreaElement>('rn-in');
    if (stdinEl && !stdinEl.value) stdinEl.value = localStorage.getItem(LS_STDIN) ?? '';
    if (stdinEl?.value) this.toggleStdin(true);
    this.syncInBtn();
    // 带 Ctrl+Enter 进来就是为了跑：有代码就别让用户再点一次
    if (block?.code.trim()) this.run();
  }

  hide(): void {
    this.stop();
    const box = this.el('runner');
    if (box) box.dataset['open'] = '0';
    this.opened = false;
    this.hooks.onFocusBack();
  }

  run(): void {
    // 还在跑：这一下是「停止」
    if (this.handle) { this.stop(); return; }

    const code = this.el<HTMLTextAreaElement>('rn-code')?.value ?? '';
    if (!code.trim()) { this.state('没有可运行的代码'); return; }
    const lang = this.lang ?? sniffLang(code);
    if (!lang) { this.state('先选一种语言：点上面的 Python 或 Java'); return; }
    this.setLang(lang);
    const stdin = this.el<HTMLTextAreaElement>('rn-in')?.value ?? '';
    this.syncInBtn();
    localStorage.setItem(LS_CODE, code);
    localStorage.setItem(LS_LANG, lang);
    localStorage.setItem(LS_STDIN, stdin);

    // 上一次的句柄可能还活着（Python 晚到的输出），先清掉再起新的
    this.frame?.kill();
    this.frame = null;

    this.clearOut();
    this.state(lang === 'python' ? '运行中 · Python（本地）' : '运行中 · Java（本机 JDK）');
    this.setRunBtn(true);
    const handle = runCode(code, lang, {
      stdin,
      onLine: line => this.print(line),
      onDone: (reason, ms) => {
        this.handle = null;
        this.setRunBtn(false);
        const label = this.label(reason, ms);
        this.state(label);
        this.print({ kind: 'meta', text: `· ${label}` });
      }
    });
    this.handle = handle;
    this.frame = handle;
  }

  stop(): void {
    this.handle?.kill();
    this.frame?.kill();
    this.handle = null;
    this.frame = null;
    this.setRunBtn(false);
  }

  /** 站体收起时调用：杀掉还在跑的脚本，别让死循环留在页面背后 */
  dispose(): void {
    this.stop();
    this.opened = false;
    const box = this.el('runner');
    if (box) box.dataset['open'] = '0';
  }

  /* ------------------------------------------------------------------ */

  private label(reason: DoneReason, ms: number): string {
    if (reason === 'timeout') return `超时 · 已终止`;
    if (reason === 'killed') return '已停止';
    if (reason === 'error') return `出错 · ${ms}ms`;
    return `完成 · ${ms}ms`;
  }

  /** 语言芯片：选中态 + 记忆 */
  private setLang(lang: Lang | null): void {
    this.lang = lang;
    this.el('rn-py')?.classList.toggle('on', lang === 'python');
    this.el('rn-java')?.classList.toggle('on', lang === 'java');
    if (lang) localStorage.setItem(LS_LANG, lang);
  }

  private setRunBtn(running: boolean): void {
    const btn = this.el('rn-run');
    if (btn) btn.textContent = running ? '停止' : '运行';
  }

  private snippet(): void {
    const lang: Lang = this.lang ?? 'python';
    this.setLang(lang);
    const code = this.el<HTMLTextAreaElement>('rn-code');
    if (!code) return;
    code.value = SNIPPETS[lang];
    this.fromLine = 0;
    this.clearOut();
    this.state('示例已就位 · Ctrl+Enter 或点运行');
    code.focus();
    code.setSelectionRange(code.value.length, code.value.length);
  }

  /** 展开 / 收起标准输入行。Scanner 和 input() 没有它就没法跑真实练习题 */
  private toggleStdin(force?: boolean): void {
    const box = this.el('runner');
    if (!box) return;
    const open = force ?? box.dataset['in'] !== '1';
    box.dataset['in'] = open ? '1' : '0';
    if (open) this.el<HTMLTextAreaElement>('rn-in')?.focus();
  }

  /** 输入行有内容时芯片亮着：收起状态下也能看出「这段代码带输入」 */
  private syncInBtn(): void {
    const has = !!(this.el<HTMLTextAreaElement>('rn-in')?.value ?? '').trim();
    this.el('rn-in-btn')?.classList.toggle('on', has);
  }

  /** 把输出原样插回正文：学习笔记要的是「我跑过、结果是这个」的证据 */
  private insertOutput(): void {
    const out = this.el('rn-out');
    if (!out) return;
    const lines = [...out.children]
      .filter(el => !el.classList.contains('meta'))
      .map(el => el.textContent ?? '')
      .filter(l => l.trim());
    if (!lines.length) { this.state('还没有输出 · 先跑一次'); return; }
    this.hooks.onInsert(lines.join('\n'));
  }

  private state(text: string): void {
    const el = this.el('rn-state');
    if (el) el.textContent = text;
  }

  private clearOut(): void {
    const out = this.el('rn-out');
    if (out) out.textContent = '';
  }

  private print(line: SinkLine): void {
    const out = this.el('rn-out');
    if (!out) return;
    const row = document.createElement('div');
    row.className = line.kind === 'error' ? 'rn-line err'
      : line.kind === 'meta' ? 'rn-line meta'
        : `rn-line ${line.level ?? 'log'}`;

    if (line.kind === 'error') {
      const at = document.createElement('b');
      at.textContent = line.line ? `第 ${line.line} 行` : '错误';
      const msg = document.createElement('span');
      msg.textContent = line.text;
      row.append(at, msg);
      if (line.line) {
        row.title = '跳到这一行';
        row.addEventListener('click', () => {
          // 代码块里的行号要换算成笔记里的绝对行号
          this.hooks.onGoto(this.fromLine ? this.fromLine + line.line! - 1 : line.line!);
        });
      }
    } else {
      row.textContent = line.kind === 'meta' ? line.text : `› ${line.text}`;
    }
    out.appendChild(row);
    out.scrollTop = out.scrollHeight;
  }
}
