/**
 * 键盘：焦点域隔离是硬规则。
 *
 * 三层优先级，顺序不能动：
 *   1. Escape —— 永远有效，谁在顶层谁先收（面板 → 站体 → 星系）；
 *   2. 组合键 —— Cmd+K / Cmd+S 这类在编辑器里也该生效的；
 *   3. 单键 —— 只在「不在编辑器里、也没有面板开着」时才放行。
 *
 * 单键一旦漏进输入框，就会出现「写了半句按 n，页面新建了一篇笔记」。
 */
export interface KeyActions {
  esc(): void;
  enter(): void;
  toggleWrite(): void;
  search(): void;
  command(): void;
  /** 记一条决策。和 Cmd+K 一样，在编辑器里也该生效 */
  decision(): void;
  /** 开 / 跑沙盒。Cmd+Enter 在编辑器里必须生效，否则「跑一段代码」永远差点意思 */
  run(): void;
  /** 面板等浮层开着时，单键全部让位 */
  blocked?(): boolean;
}

export function bindKeys(actions: KeyActions): void {
  window.addEventListener('keydown', (ev: KeyboardEvent) => {
    const el = document.activeElement as HTMLElement | null;
    // 必须用 closest：CodeMirror 的焦点落在它内部的 .cm-content 上，
    // 那个元素自己没有 data-editor，只有外层容器有。
    // 直接读 el.dataset 会让 Enter 被全局抢走 —— 正文里就再也敲不出换行。
    const inEditor = !!el?.closest?.('[data-editor]');
    const mod = ev.metaKey || ev.ctrlKey;
    const key = ev.key;

    if (key === 'Escape') { ev.preventDefault(); actions.esc(); return; }

    if (mod && (key === 'k' || key === 'K')) {
      ev.preventDefault();
      actions.command();
      return;
    }
    if (mod && !ev.shiftKey && (key === 'd' || key === 'D')) {
      ev.preventDefault();
      actions.decision();
      return;
    }
    if (mod && key === 'Enter') { ev.preventDefault(); actions.run(); return; }

    if (actions.blocked?.()) return;
    if (inEditor) return;

    if (key === '/') { ev.preventDefault(); actions.search(); return; }
    if (key === 'Enter') { ev.preventDefault(); actions.enter(); return; }
    if (key === 'Tab') { ev.preventDefault(); actions.toggleWrite(); return; }
  });
}
