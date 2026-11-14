/**
 * 长按连线：星图上唯一「新增关系」的入口。
 *
 * 两种完成方式都支持：
 *   1. 按住一颗星约 0.5 秒 → 拖出一条虚线 → 落到目标星上松开，立刻连上；
 *   2. 按住后原地松手 → 进入连线态 → 再点一下目标星完成。
 * 连到已经连着的星 = 断开；Esc / 点空白处 / 再点源星 = 取消。
 *
 * 站体开着的时候不启动（书写态里改正文会和这里的自动落笔打架）。
 * 线本身由 notes/ties.ts 落库，这里只管手势与那条预览虚线。
 */
import { getState } from '../core/state';
import { toast } from '../ui/toast';
import { hasTie, connectTie, disconnectTie } from '../notes/ties';

const NS = 'http://www.w3.org/2000/svg';
const HOLD_MS = 500;
const MOVE_TOL = 9;
const CLICK_GUARD_MS = 400;

export interface LinkGestureHooks {
  rectOf(id: string): DOMRect | null;
  setVisual(from: string | null, target: string | null, candidates: ReadonlySet<string>): void;
}

export interface LinkGesture {
  /** 普通激活入口先问这里；返回 true 表示这次点击已被连线逻辑消费 */
  handleActivate(id: string): boolean;
  cancel(): void;
  isActive(): boolean;
  destroy(): void;
}

type Phase = 'idle' | 'press' | 'drag' | 'armed';

export function mountLinkGesture(
  root: HTMLElement,
  host: HTMLElement,
  hooks: LinkGestureHooks
): LinkGesture {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'link-preview');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(NS, 'line');
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('r', '3.2');
  svg.append(line, dot);
  host.appendChild(svg);

  let phase: Phase = 'idle';
  let from = '';
  let kind = '';
  let candidates: ReadonlySet<string> = new Set();
  let target: string | null = null;
  let sx = 0, sy = 0, cx = 0, cy = 0;
  let hold = 0;
  let guard = 0;
  let ignoreClick = false;
  let raf = 0;

  const labelOf = (id: string): string =>
    root.querySelector<HTMLElement>(`.entity[data-id="${id}"] .cap b`)?.textContent?.trim() || id;

  const kindOf = (id: string): string =>
    root.querySelector<HTMLElement>(`.entity[data-id="${id}"]`)?.dataset['kind'] ?? '';

  const hit = (x: number, y: number): { id: string; kind: string } | null => {
    const el = document.elementFromPoint(x, y);
    const n = el instanceof Element ? el.closest<HTMLElement>('.entity') : null;
    if (!n || !root.contains(n)) return null;
    return { id: n.dataset['id'] ?? '', kind: n.dataset['kind'] ?? '' };
  };

  const valid = (h: { id: string; kind: string } | null): boolean =>
    !!h && !!h.id && h.id !== from && h.kind === kind && (kind === 'note' || kind === 'project');

  const peers = (): ReadonlySet<string> => {
    const out = new Set<string>();
    root.querySelectorAll<HTMLElement>('.entity').forEach(n => {
      const id = n.dataset['id'] ?? '';
      if (id && id !== from && n.dataset['kind'] === kind) out.add(id);
    });
    return out;
  };

  const paintVisual = (): void => {
    hooks.setVisual(phase === 'idle' || phase === 'press' ? null : from, target, candidates);
  };

  const clear = (): void => {
    clearTimeout(hold);
    phase = 'idle';
    from = '';
    kind = '';
    target = null;
    candidates = new Set();
    svg.style.display = 'none';
    paintVisual();
  };

  /** 松手后紧跟的那一次 click 不该把站体打开 */
  const armGuard = (): void => {
    ignoreClick = true;
    clearTimeout(guard);
    guard = window.setTimeout(() => { ignoreClick = false; }, CLICK_GUARD_MS);
  };

  const complete = (to: string): void => {
    const a = from;
    const b = to;
    const la = labelOf(a);
    const lb = labelOf(b);
    const existed = hasTie(a, b);
    const job = existed ? disconnectTie(a, b) : connectTie(a, b);
    void job.then(ok => {
      if (!ok) { toast('这两颗星连不上 · 只能同层互连'); return; }
      toast(existed ? `已断开 ${la} ↔ ${lb}` : `已连接 ${la} ↔ ${lb}`);
    });
    clear();
    armGuard();
  };

  const startLinking = (): void => {
    if (phase !== 'press') return;
    phase = 'drag';
    candidates = peers();
    paintVisual();
    toast('拖到目标星松开，或松手后再点一颗 · Esc 取消');
  };

  const frame = (): void => {
    raf = requestAnimationFrame(frame);
    if (phase !== 'drag' && phase !== 'armed') { svg.style.display = 'none'; return; }
    const base = host.getBoundingClientRect();
    const r = hooks.rectOf(from);
    if (!r) { svg.style.display = 'none'; return; }
    const x1 = r.left + r.width / 2 - base.left;
    const y1 = r.top + r.height / 2 - base.top;
    // 指着某个目标时，虚线端点吸到那颗星的中心，确认感更强
    const tr = target ? hooks.rectOf(target) : null;
    const x2 = tr ? tr.left + tr.width / 2 - base.left : cx - base.left;
    const y2 = tr ? tr.top + tr.height / 2 - base.top : cy - base.top;
    line.setAttribute('x1', x1.toFixed(1));
    line.setAttribute('y1', y1.toFixed(1));
    line.setAttribute('x2', x2.toFixed(1));
    line.setAttribute('y2', y2.toFixed(1));
    dot.setAttribute('cx', x2.toFixed(1));
    dot.setAttribute('cy', y2.toFixed(1));
    svg.style.display = '';
  };
  raf = requestAnimationFrame(frame);

  /* ---------------- 事件 ---------------- */

  const onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    const n = ev.target instanceof Element
      ? ev.target.closest<HTMLElement>('.entity') : null;
    const onEntity = !!n && root.contains(n);

    // 连线态下点空白 = 取消；点别的星留给 click 去完成
    if (phase === 'armed') {
      if (!onEntity) clear();
      else if (n?.dataset['id'] !== from) ignoreClick = false;
      return;
    }
    if (!onEntity || getState().station) return;
    const k = n!.dataset['kind'] ?? '';
    if (k !== 'note' && k !== 'project') return;

    clear();
    phase = 'press';
    from = n!.dataset['id'] ?? '';
    kind = k;
    sx = cx = ev.clientX;
    sy = cy = ev.clientY;
    hold = window.setTimeout(startLinking, HOLD_MS);
  };

  const onMove = (ev: PointerEvent): void => {
    cx = ev.clientX;
    cy = ev.clientY;
    if (phase === 'press') {
      // 长按之前就移动：视作普通悬停 / 拖镜，不进入连线
      if (Math.hypot(cx - sx, cy - sy) > MOVE_TOL) clear();
      return;
    }
    if (phase !== 'drag' && phase !== 'armed') return;
    const h = hit(cx, cy);
    const next = valid(h) ? h!.id : null;
    if (next !== target) { target = next; paintVisual(); }
  };

  const onUp = (ev: PointerEvent): void => {
    if (phase === 'press') {
      // 没按够时长就是一次普通点击：别挡，让它照常打开站体
      clear();
      return;
    }
    if (phase !== 'drag') return;
    cx = ev.clientX;
    cy = ev.clientY;
    const h = hit(cx, cy);
    if (valid(h)) { complete(h!.id); return; }
    // 原地松手 → 进入连线态，等下一次点选
    phase = 'armed';
    target = null;
    paintVisual();
    toast(`从「${labelOf(from)}」连出去 · 点另一颗星完成，Esc 取消`);
    armGuard();
  };

  const onCancel = (): void => { if (phase === 'drag' || phase === 'press') clear(); };

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || phase === 'idle') return;
    // 捕获阶段先吃掉这一下 Esc，别让全局 Esc 顺手把星系也退了
    ev.stopImmediatePropagation();
    clear();
    toast('已取消连线');
  };

  // 挂在 window：#entities 是 pointer-events:none，点空白处的事件不会经过它，
  // 而「点空白取消连线」恰恰要靠这一下
  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);

  return {
    handleActivate(id: string): boolean {
      if (ignoreClick) { ignoreClick = false; return true; }
      if (phase !== 'armed') return false;
      if (id === from) { clear(); toast('已取消连线'); return true; }
      const k = kindOf(id);
      if (k !== kind || (kind !== 'note' && kind !== 'project')) {
        clear();
        toast('只能连接同层的笔记或项目');
        return true;
      }
      complete(id);
      return true;
    },
    cancel: clear,
    isActive: () => phase !== 'idle',
    destroy() {
      clear();
      clearTimeout(guard);
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      svg.remove();
    }
  };
}
