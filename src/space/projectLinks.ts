/**
 * 项目星座：把项目星系里的几颗星连成一张会呼吸的网。
 *
 * 关系不写死在代码里 —— 每个项目在 detail.tags 里带几个主题标签，
 * 两个项目共享标签就自动连一条光丝，共享越多线越粗。
 * 以后新增项目只要填 tags，就自然长进这张网里，不用改渲染代码。
 *
 * 坐标仍由 coords.ts 冻结；这里只按 DOM 实体的实时屏幕位置画线，
 * 所以 3D 锚定（每帧 transform）下光丝也焊得住在星云上。
 */
import { entityRows, entityTags } from '../storage/entityData';

const NS = 'http://www.w3.org/2000/svg';

export interface ProjectRelation {
  a: string;
  b: string;
  /** 共享标签里最有区分度的一个 */
  label: string;
  /** 共享标签数量 → 线宽 */
  weight: number;
}

/** 两两求标签交集；「个人项目」这种通用标签只作保底，不拿来做主标签 */
export function projectRelations(): ProjectRelation[] {
  const rows = entityRows().filter(r => r.kind === 'project');
  const out: ProjectRelation[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const ta = new Set(entityTags(rows[i]!.id));
      const shared = entityTags(rows[j]!.id).filter(t => ta.has(t));
      if (!shared.length) continue;
      out.push({
        a: rows[i]!.id,
        b: rows[j]!.id,
        label: shared.find(t => t !== '个人项目') ?? shared[0]!,
        weight: shared.length
      });
    }
  }
  return out;
}

/** 悬停某颗星时要一起点亮的项目 */
export function relatedProjectIds(id: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const r of projectRelations()) {
    if (r.a === id) out.add(r.b);
    else if (r.b === id) out.add(r.a);
  }
  return out;
}

export interface ProjectLinksLayer {
  setFocus(id: string | null): void;
  refresh(): void;
  destroy(): void;
}

interface Wire {
  rel: ProjectRelation;
  line: SVGLineElement;
  mote: SVGCircleElement;
  /** 线中点的共享标签：让「为什么连在一起」一眼看得见，而不只是三条线 */
  lab: SVGTextElement;
  phase: number;
}

/**
 * 挂一层 SVG 覆盖层。端点每帧跟随实体 rect（3D 锚定会移动 DOM），
 * 一颗光点沿丝缓行 —— 三个项目因此不再是三座孤岛。
 */
export function mountProjectLinks(
  host: HTMLElement,
  rectOf: (id: string) => DOMRect | null,
  isVisible: () => boolean
): ProjectLinksLayer {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'proj-links');
  svg.setAttribute('aria-hidden', 'true');
  host.insertBefore(svg, host.firstChild);

  let wires: Wire[] = [];
  let focus: string | null = null;
  let raf = 0;

  const rebuild = (): void => {
    svg.textContent = '';
    wires = projectRelations().map((rel, i) => {
      const line = document.createElementNS(NS, 'line');
      const mote = document.createElementNS(NS, 'circle');
      mote.setAttribute('r', '2.2');
      const lab = document.createElementNS(NS, 'text');
      lab.setAttribute('class', 'lab');
      lab.textContent = `#${rel.label}`;
      svg.append(line, mote, lab);
      return { rel, line, mote, lab, phase: i * 0.31 };
    });
  };

  const paintHot = (): void => {
    for (const w of wires) {
      const on = !!focus && (w.rel.a === focus || w.rel.b === focus);
      w.line.classList.toggle('hot', on);
      w.mote.classList.toggle('hot', on);
      w.lab.classList.toggle('hot', on);
      w.line.classList.toggle('cold', !!focus && !on);
      w.lab.classList.toggle('cold', !!focus && !on);
    }
  };

  const frame = (): void => {
    raf = requestAnimationFrame(frame);
    const shown = isVisible();
    svg.style.display = shown ? '' : 'none';
    if (!shown || !wires.length) return;

    const base = host.getBoundingClientRect();
    const now = performance.now();
    for (const w of wires) {
      const ra = rectOf(w.rel.a);
      const rb = rectOf(w.rel.b);
      if (!ra || !rb) {
        w.line.style.display = 'none';
        w.mote.style.display = 'none';
        w.lab.style.display = 'none';
        continue;
      }
      w.line.style.display = '';
      w.mote.style.display = '';
      w.lab.style.display = '';
      const x1 = ra.left + ra.width / 2 - base.left;
      const y1 = ra.top + ra.height / 2 - base.top;
      const x2 = rb.left + rb.width / 2 - base.left;
      const y2 = rb.top + rb.height / 2 - base.top;
      w.line.setAttribute('x1', x1.toFixed(1));
      w.line.setAttribute('y1', y1.toFixed(1));
      w.line.setAttribute('x2', x2.toFixed(1));
      w.line.setAttribute('y2', y2.toFixed(1));
      // 线宽按共享标签数；悬停时由 CSS 接管高亮
      w.line.style.strokeWidth = String(0.8 + Math.min(3, w.rel.weight) * 0.45);
      // 标签沿线的法线方向挪开一点：既不压线身，也躲开流动的光点，
      // 还不至于和另一条边的标签挤在同一个位置
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const off = 16;
      w.lab.setAttribute('x', ((x1 + x2) / 2 - dy / len * off).toFixed(1));
      w.lab.setAttribute('y', ((y1 + y2) / 2 + dx / len * off).toFixed(1));

      const t = (now / 2600 + w.phase) % 1;
      w.mote.setAttribute('cx', (x1 + (x2 - x1) * t).toFixed(1));
      w.mote.setAttribute('cy', (y1 + (y2 - y1) * t).toFixed(1));
    }
  };

  rebuild();
  raf = requestAnimationFrame(frame);

  return {
    setFocus(id) { focus = id; paintHot(); },
    refresh() { rebuild(); paintHot(); },
    destroy() { cancelAnimationFrame(raf); svg.remove(); }
  };
}
