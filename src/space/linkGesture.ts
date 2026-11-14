/**
 * 长按连线：星图上「建线 / 剪线」的唯一入口。
 *
 * 两种完成方式都支持：
 *   1. 按住一颗星约 0.5 秒 → 拖出一条虚线 → 落到目标星上松开；
 *      拖出去了却没落到任何目标星（松在空白处）→ 直接取消，不留悬空的线；
 *   2. 按住后原地松手 → 进入连线态 → 再点一下目标星。
 * 目标没连过 = 连接，已经连着 = 剪断（预览线会先变成琥珀色说明）。
 * 连线态还会浮出「这颗星的线」，逐条 ✕ 剪断；剪完 4 秒内可撤销。
 * 悬停浮层里的某一行，3D 里对应的星与光丝会单独亮起来，剪错不了。
 *
 * 站体开着的时候不启动（书写态里改正文会和这里的自动落笔打架）。
 * 关系的落库在 notes/ties.ts，动作与撤销在 tieActions.ts。
 */
import { getState } from '../core/state';
import { toast } from '../ui/toast';
import { hasTie, tiesOf } from '../notes/ties';
import { toggleTie, cutTie } from './tieActions';
import { mountTieTray } from './tieTray';

const NS = 'http://www.w3.org/2000/svg';
const HOLD_MS = 500;
const MOVE_TOL = 9;
const DRAG_TRAY_TOL = 14;
const CLICK_GUARD_MS = 400;

/** 3D 光丝渲染层要读：连线态下把源星已有的线点亮，方便看清要剪哪条 */
let activeLinkSource: string | null = null;
export const linkSource = (): string | null => activeLinkSource;

/** 剪线浮层 hover 某一行时记录对端 id：3D 里把「这一条」单独点亮 */
let activeHighlight: string | null = null;
export const linkHighlight = (): string | null => activeHighlight;

export interface LinkGestureHooks {
  rectOf(id: string): DOMRect | null;
  setVisual(
    from: string | null,
    target: string | null,
    candidates: ReadonlySet<string>,
    cut?: boolean
  ): void;
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
  const hint = document.createElementNS(NS, 'text');
  hint.setAttribute('class', 'pv-hint');
  svg.append(line, dot, hint);
  host.appendChild(svg);

  let phase: Phase = 'idle';
  let from = '';
  let kind = '';
  let candidates: ReadonlySet<string> = new Set();
  let target: string | null = null;
  let cutMode = false;
  let sx = 0, sy = 0, cx = 0, cy = 0;
  let hold = 0;
  let guard = 0;
  let ignoreClick = false;
  let trayHidden = false;
  let raf = 0;

  const labelOf = (id: string): string =>
    root.querySelector<HTMLElement>(`.entity[data-id="${id}"] .cap b`)?.textContent?.trim() || id;

  const kindOf = (id: string): string =>
    root.querySelector<HTMLElement>(`.entity[data-id="${id}"]`)?.dataset['kind'] ?? '';

  const anchor = (): { x: number; y: number } => {
    const r = hooks.rectOf(from);
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: sx, y: sy };
  };

  const tray = mountTieTray({
    tiesOf,
    labelOf,
    onCut: async (a, b, la, lb) => {
      const ok = await cutTie(a, b, la, lb);
      if (!ok) toast('这条线已经不在了');
    },
    onHighlight: (id) => {
      activeHighlight = id;
      // 只有连线态里浮层在台上：hover 一行就点亮那颗星，其余压暗
      if (phase === 'armed') hooks.setVisual(from, id, candidates, false);
    }
  });

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
    cutMode = !!target && hasTie(from, target);
    const shown = phase !== 'idle' && phase !== 'press';
    hooks.setVisual(shown ? from : null, target, candidates, cutMode);
    svg.classList.toggle('will-cut', cutMode);
  };

  const clear = (): void => {
    clearTimeout(hold);
    phase = 'idle';
    activeLinkSource = null;
    activeHighlight = null;
    from = '';
    kind = '';
    target = null;
    cutMode = false;
    candidates = new Set();
    trayHidden = false;
    tray.hide();
    svg.style.display = 'none';
    svg.classList.remove('will-cut');
    hint.style.display = 'none';
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
    void toggleTie(a, b, la, lb).then(ok => {
      if (!ok) toast('这两颗星连不上 · 只能同层互连');
    });
    clear();
    armGuard();
  };

  const startLinking = (): void => {
    if (phase !== 'press') return;
    phase = 'drag';
    activeLinkSource = from;
    candidates = peers();
    paintVisual();
    const p = anchor();
    trayHidden = false;
    tray.show(from, p.x, p.y);
    toast('拖到目标星松开 · 已连的会断开 · 浮层里可剪线');
  };

  const frame = (): void => {
    raf = requestAnimationFrame(frame);
    // 只有真正拖拽才画预览线；连线态（点选）不画 —— 否则会有一条
    // 指向松手位置的悬空虚线挂在屏幕上，看着像断掉的线
    if (phase !== 'drag') { svg.style.display = 'none'; return; }
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
    if (target) {
      hint.textContent = cutMode ? '松手断开' : '松手连接';
      hint.setAttribute('x', (x2 + 14).toFixed(1));
      hint.setAttribute('y', (y2 - 12).toFixed(1));
      hint.style.display = '';
    } else {
      hint.style.display = 'none';
    }
    svg.style.display = '';
  };
  raf = requestAnimationFrame(frame);

  /* ---------------- 事件 ---------------- */

  const onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    // 剪线浮层、资料库面板与带「撤销」的提示都不算点空白：点撤销时保持连线态，浮层好跟着刷新
    if (ev.target instanceof Element && ev.target.closest('#tie-tray,#toast,#vault-panel')) return;
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
    // 真开始拖了就把浮层收起来，免得挡住目标星
    if (phase === 'drag' && !trayHidden && Math.hypot(cx - sx, cy - sy) > DRAG_TRAY_TOL) {
      trayHidden = true;
      tray.hide();
    }
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
    // 拖出去了（线真的拉出来过）却没落到目标星：这就是「取消」，
    // 不留连线态、不留悬空虚线 —— 想剪线用原地松手或浮层
    if (Math.hypot(cx - sx, cy - sy) > DRAG_TRAY_TOL) {
      clear();
      toast('已取消连线');
      armGuard();
      return;
    }
    // 原地松手 → 进入连线态，浮层列出这颗星的所有线，可逐条剪断
    phase = 'armed';
    target = null;
    paintVisual();
    const p = anchor();
    trayHidden = false;
    tray.show(from, p.x, p.y);
    toast(`「${labelOf(from)}」· 点另一颗星连接/断开 · 浮层里可剪线`);
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
      tray.destroy();
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      svg.remove();
    }
  };
}
