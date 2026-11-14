/**
 * 实体层：DOM 而非 canvas。
 * 理由：文字标签要能被选中、放大、被屏幕阅读器读到；
 * 圆点用 CSS 画，比 canvas 重绘便宜，也不会因为 DPR 变化发虚。
 */
import type { EntityDef, SceneName } from '../core/state';
import { entitiesOf } from './coords';

export interface EntityHooks {
  activate(id: string): void;
  focus(id: string | null): void;
}

export class Entities {
  private readonly gaze: HTMLDivElement;
  private focusTimer = 0;
  private scene: SceneName = 'galaxy';

  constructor(
    private readonly root: HTMLElement,
    private readonly labels: HTMLElement,
    private readonly hooks: EntityHooks
  ) {
    this.gaze = document.createElement('div');
    this.gaze.className = 'gaze';
  }

  render(scene: SceneName): void {
    this.scene = scene;
    this.root.textContent = '';
    this.labels.textContent = '';
    // DOM 全部重建：锚定缓存里的元素引用已失效，必须作废
    this.anchors.clear();

    for (const e of entitiesOf(scene)) {
      this.root.appendChild(this.build(e));
    }
    this.labels.appendChild(this.gaze);
  }

  /** 笔记改名后只换标签文字，不重建 DOM（重建会打断 hover 与呼吸动画） */
  refreshLabels(resolve: (id: string, fallback: string) => string): void {
    this.root.querySelectorAll<HTMLElement>('.entity').forEach(el => {
      const id = el.dataset['id'];
      const b = el.querySelector<HTMLElement>('.cap b');
      const def = entitiesOf(this.scene).find(x => x.id === id);
      if (!id || !b || !def) return;
      b.textContent = resolve(id, def.label);
    });
  }

  private build(e: EntityDef): HTMLElement {
    const el = document.createElement('div');
    el.className = 'entity';
    el.dataset['id'] = e.id;
    el.dataset['kind'] = e.kind;
    el.dataset['tone'] = e.tone;
    // 靠近右边缘的星把标签放到左侧，避免长标题一律向右伸、糊成一团
    el.dataset['side'] = e.x > 0.60 ? 'left' : 'right';
    if (e.main) el.dataset['main'] = '1';
    el.style.left = `${e.x * 100}%`;
    el.style.top = `${e.y * 100}%`;

    const dot = document.createElement('span');
    dot.className = 'dot';
    const cap = document.createElement('span');
    cap.className = 'cap';
    const b = document.createElement('b');
    b.textContent = e.label;
    b.title = e.label;   // 过长被省略时，悬停仍能看到全名
    const small = document.createElement('small');
    small.textContent = e.sub;
    cap.append(b, small);
    el.append(dot, cap);
    // 该回看的刻度：只在笔记上挂，且由 applyDue 决定亮不亮。
    // 它是一道极细的弧，不是红点、不挂数字 —— 说的是「这颗星有点暗了」。
    if (e.kind === 'note') {
      const recall = document.createElement('span');
      recall.className = 'recall';
      el.appendChild(recall);
    }
    // 星系门户的扩围命中区：点在星云外观范围内即可进入，不必精确点中那颗光核。
    // 只挂在门户上 —— 笔记恒星保持原有小命中区，相邻实体不会互相吃点击。
    if (e.kind === 'galaxy') {
      const hit = document.createElement('span');
      hit.className = 'hit';
      el.appendChild(hit);
    }

    el.addEventListener('mouseenter', () => this.hooks.focus(e.id));
    el.addEventListener('mouseleave', () => this.hooks.focus(null));
    el.addEventListener('click', () => this.hooks.activate(e.id));
    return el;
  }

  rect(id: string): DOMRect | null {
    const el = this.root.querySelector<HTMLElement>(`.entity[data-id="${id}"]`);
    return el ? el.getBoundingClientRect() : null;
  }

  /**
   * 3D 锚定：把实体（点 + 标签 + 入口）钉到对应星云的屏幕投影上。
   * 星云在世界空间里，镜头转到哪实体就跟到哪 —— 标签永远焊在云上。
   * x 为 null 表示那团云转到了镜头后方，实体暂时隐藏。
   *
   * 性能关键：这里每帧都会被调用。位置必须走 transform（合成器路径），
   * 绝不能写 left/top —— 那是布局属性，每帧写等于强制整层 reflow。
   * 元素引用与上次的值都缓存：DOM 查询和冗余 style 写入都省掉。
   */
  private readonly anchors = new Map<string, {
    el: HTMLElement; hidden: boolean; x: number; y: number;
  }>();

  setAnchor(id: string, x: number | null, y: number | null): void {
    let a = this.anchors.get(id);
    if (!a) {
      const el = this.root.querySelector<HTMLElement>(`.entity[data-id="${id}"]`);
      if (!el) return;
      a = { el, hidden: false, x: NaN, y: NaN };
      this.anchors.set(id, a);
    }
    if (x == null || y == null) {
      if (!a.hidden) { a.el.style.visibility = 'hidden'; a.hidden = true; }
      return;
    }
    if (a.hidden) { a.el.style.visibility = 'visible'; a.hidden = false; }
    // 首次锚定：把 % 定位清零，此后位置全由 transform 承担
    if (Number.isNaN(a.x)) { a.el.style.left = '0px'; a.el.style.top = '0px'; }
    // 阈值过滤：投影抖动小于 0.05px 不值得动 DOM
    if (Math.abs(a.x - x) < 0.00004 && Math.abs(a.y - y) < 0.00004) return;
    a.x = x;
    a.y = y;
    const px = (x * Math.max(1, innerWidth)).toFixed(1);
    const py = (y * Math.max(1, innerHeight)).toFixed(1);
    a.el.style.transform = `translate3d(${px}px,${py}px,0) translate(-50%,-50%)`;
  }

  /**
   * 点亮「该回看」的刻度。
   * 只改 class，不重建 DOM —— 重建会打断呼吸动画，也会让正在淡出的刻度闪一下。
   */
  applyDue(ids: ReadonlySet<string>): void {
    this.root.querySelectorAll<HTMLElement>('.entity').forEach(el => {
      const id = el.dataset['id'];
      el.classList.toggle('due', !!id && ids.has(id));
    });
  }

  setFocus(id: string | null, entity?: EntityDef): void {
    this.root.querySelectorAll<HTMLElement>('.entity').forEach(n => {
      n.classList.toggle('focused', n.dataset['id'] === id);
    });
    if (!entity) { this.gaze.classList.remove('show'); return; }
    const r = this.rect(entity.id);
    if (!r) return;
    this.gaze.style.left = `${r.left + 30}px`;
    this.gaze.style.top = `${r.bottom + 14}px`;
    this.gaze.textContent = `${entity.label}\n${entity.sub}`;
    this.gaze.style.whiteSpace = 'pre-line';
    this.gaze.classList.add('show');
    clearTimeout(this.focusTimer);
    this.focusTimer = window.setTimeout(() => this.gaze.classList.remove('show'), 3000);
  }

  /** 项目星座：悬停一颗星时，与它共享标签的项目一起亮，其余压暗 */
  setRelated(ids: ReadonlySet<string>): void {
    this.root.classList.toggle('has-rel', ids.size > 0);
    this.root.querySelectorAll<HTMLElement>('.entity').forEach(n => {
      const id = n.dataset['id'];
      n.classList.toggle('related', !!id && ids.has(id));
    });
  }
}
