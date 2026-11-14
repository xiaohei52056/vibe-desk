/**
 * 「这颗星的线」浮层：剪线的统一入口。
 *
 * 笔记之间的光丝是 WebGL 画的，没有可点的 DOM 线；项目线虽然是 SVG，
 * 但为了两处操作一致，删除都收拢到这张贴着源星的小浮层里：
 * 一行一条线，行尾一个 ✕。没有数字、没有统计、没有「共几条」。
 */
import { TIE_EVENT } from '../notes/ties';

export interface TieTrayHooks {
  tiesOf(id: string): string[];
  labelOf(id: string): string;
  onCut(from: string, to: string, la: string, lb: string): Promise<void>;
  /** 悬停某一行时点亮对端那颗星；null = 清掉高亮 */
  onHighlight(id: string | null): void;
}

export interface TieTray {
  show(from: string, x: number, y: number): void;
  refresh(): void;
  hide(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function mountTieTray(hooks: TieTrayHooks): TieTray {
  const el = document.createElement('div');
  el.id = 'tie-tray';
  el.hidden = true;

  const head = document.createElement('div');
  head.className = 'tt-head';
  head.textContent = '这颗星的线';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tt-close';
  close.textContent = '×';
  close.title = '收起';
  head.appendChild(close);

  const list = document.createElement('div');
  list.className = 'tt-list';
  const empty = document.createElement('div');
  empty.className = 'tt-empty';
  empty.textContent = '还没有连线 · 拖到另一颗星就能连';

  el.append(head, list, empty);
  document.body.appendChild(el);

  let from = '';
  let open = false;

  const build = (): void => {
    // 列表重建后旧行已不在，mouseleave 不会再触发：先清掉可能残留的高亮
    hooks.onHighlight(null);
    list.textContent = '';
    const ids = hooks.tiesOf(from).sort((a, b) =>
      hooks.labelOf(a).localeCompare(hooks.labelOf(b), 'zh-CN'));
    empty.hidden = ids.length > 0;
    for (const id of ids) {
      const row = document.createElement('div');
      row.className = 'tt-row';
      const name = document.createElement('span');
      name.className = 'tt-name';
      name.textContent = hooks.labelOf(id);
      name.title = name.textContent;
      const cut = document.createElement('button');
      cut.type = 'button';
      cut.className = 'tt-cut';
      cut.textContent = '✕';
      cut.title = `断开与「${name.textContent}」的连线`;
      // 悬停一行 = 在星图里点亮线的另一端，看准了再剪
      row.addEventListener('mouseenter', () => hooks.onHighlight(id));
      row.addEventListener('mouseleave', () => hooks.onHighlight(null));
      cut.addEventListener('click', ev => {
        ev.stopPropagation();
        void hooks.onCut(from, id, hooks.labelOf(from), name.textContent ?? id)
          .then(() => { if (open) build(); });
      });
      row.append(name, cut);
      list.appendChild(row);
    }
  };

  const place = (x: number, y: number): void => {
    const w = 236;
    const h = Math.min(280, el.offsetHeight || 200);
    const GAP = 26;
    // 源星的光晕圈：浮层不许盖住正在操作的星，盖住就挪到它的上/下方
    const PAD = 38;
    const coversStar = (left: number, top: number): boolean =>
      left < x + PAD && left + w > x - PAD && top < y + PAD && top + h > y - PAD;
    const fitsRight = x + GAP + w <= window.innerWidth - 12;
    const left = Math.max(12, fitsRight ? x + GAP : x - GAP - w);
    let top = Math.min(Math.max(12, y - 16), Math.max(12, window.innerHeight - h - 12));
    if (coversStar(left, top)) {
      const below = y + PAD;
      const above = y - PAD - h;
      top = below + h <= window.innerHeight - 12 ? below
        : above >= 12 ? above
        : Math.max(12, window.innerHeight - h - 12);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };

  close.addEventListener('click', ev => { ev.stopPropagation(); hide(); });

  // 剪断和撤销都会广播 TIE_EVENT：浮层开着就跟着刷新，不显示已经不在的线
  const onTieChange = (): void => { if (open) build(); };
  document.addEventListener(TIE_EVENT, onTieChange);

  function hide(): void {
    open = false;
    el.hidden = true;
    hooks.onHighlight(null);
  }

  return {
    show(id, x, y) {
      from = id;
      open = true;
      build();
      el.hidden = false;
      place(x, y);
    },
    refresh() { if (open) build(); },
    hide,
    isOpen: () => open,
    destroy() { document.removeEventListener(TIE_EVENT, onTieChange); hide(); el.remove(); }
  };
}
