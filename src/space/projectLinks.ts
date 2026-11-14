/**
 * 项目星座：把项目星系里手动连起来的星画成一张会呼吸的网。
 *
 * 线的唯一来源是 links 表里的显式关系（和笔记光丝同一张表），
 * 不再由 tags 自动派生。tags 现在只做一件事：给一条已经连好的线写个说明，
 * 比如「#Web」解释这两个项目为什么被你放在一起。
 *
 * 坐标仍由 coords.ts 冻结；这里只按 DOM 实体的实时屏幕位置画线，
 * 所以 3D 锚定（每帧 transform）下光丝也焊得住在星云上。
 */
import { links } from '../notes/store';
import { linkWeight } from '../notes/links';
import { entityRows, entityTags } from '../storage/entityData';

const NS = 'http://www.w3.org/2000/svg';

export interface ProjectRelation {
  a: string;
  b: string;
  /** 共享标签只作说明；没有共享标签就不显示字，只留线 */
  label: string;
  /** 线的强度（走得多就粗一点） */
  weight: number;
}

const projectIds = (): ReadonlySet<string> =>
  new Set(entityRows().filter(r => r.kind === 'project').map(r => r.id));

/** 两端都是项目的显式关系 */
export function projectRelations(): ProjectRelation[] {
  const ids = projectIds();
  const out: ProjectRelation[] = [];
  for (const l of links.values()) {
    if (!ids.has(l.a) || !ids.has(l.b)) continue;
    const ta = new Set(entityTags(l.a));
    const shared = entityTags(l.b).filter(t => ta.has(t));
    out.push({
      a: l.a,
      b: l.b,
      label: shared.find(t => t !== '个人项目') ?? shared[0] ?? '',
      weight: linkWeight(l.a, l.b)
    });
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
  lab: SVGTextElement;
  phase: number;
}

/**
 * 挂一层 SVG 覆盖层。端点每帧跟随实体 rect（3D 锚定会移动 DOM），
 * 一颗光点沿丝缓行 —— 手动连出来的关系因此是一张活网，而不是静态线段。
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
      lab.textContent = rel.label ? `#${rel.label}` : '';
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
      w.lab.style.display = w.rel.label ? '' : 'none';
      const x1 = ra.left + ra.width / 2 - base.left;
      const y1 = ra.top + ra.height / 2 - base.top;
      const x2 = rb.left + rb.width / 2 - base.left;
      const y2 = rb.top + rb.height / 2 - base.top;
      w.line.setAttribute('x1', x1.toFixed(1));
      w.line.setAttribute('y1', y1.toFixed(1));
      w.line.setAttribute('x2', x2.toFixed(1));
      w.line.setAttribute('y2', y2.toFixed(1));
      w.line.style.strokeWidth = String(0.9 + Math.min(2.4, w.rel.weight) * 0.4);

      // 标签沿法线挪开一点：不压线身，也躲开流动的光点
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
