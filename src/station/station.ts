/**
 * 空间站：三段动效（生长 600 / 切换 400 / 收回 400）。
 *
 * 这一层是整个应用最容易写错的地方，几条经验直接写进代码：
 *   1. 用 CSS transition + 明确 inline 终态，不用 WAAPI fill:forwards ——
 *      后者在低性能设备 / 切后台时可能不落终态，停在中间帧；
 *   2. 任何时刻都能被 Esc 中断，且从中途反向播放：反向时长按已走进度等比缩放，
 *      既不跳帧，也不至于「刚点开就按 Esc」还要等满 400ms；
 *   3. 布局正确性不押在过渡插值上：到点强制落终态（force）。
 *
 * 时长与帧点全部来自 ./motion（附录 A 的唯一定义处），这里不写魔法数字。
 */
import { getState, setState, type EntityDef, type StationMode } from '../core/state';
import { findEntity } from '../space/coords';
import { begin, elapsed, end, growInFlight } from '../core/machine';
import type { Entities } from '../space/entities';
import { toast } from '../ui/toast';
import { noteOf } from '../notes/store';
import { countWords, excerpt, parseTags, relTime } from '../notes/parse';
import { answerRecall, dueList, recallQuestion, type RecallAnswer } from '../notes/review';
import { latestOf } from '../notes/decisions';
import { assetUrl, imagesOf } from '../notes/images';
import type { Note } from '../storage/db';
import { entityDetail, entityOf } from '../storage/entityData';
import { EASE_OUT, MOTION, growthOrigin, reverseMs, type Segment } from './motion';
import { mdLite } from '../ui/mdLite';

/* ---------------- 项目卡 README：从仓库直读 ---------------- */

/** 仓库地址 → owner/repo。项目卡的「仓库」字段是唯一入口 */
function repoOf(url?: string): string | null {
  const m = url ? /github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(url) : null;
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
}

const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README.markdown'];
/** 同一颗星反复进出不要每次重拉：一次会话内记住结果（null = 确认没有） */
const readmeCache = new Map<string, string | null>();

/**
 * 取 README 原文，两条通道：
 *   1. raw 直链 —— 不占 API 配额，但国内网络常被劫持 / 连上不返回；
 *   2. Contents API（base64）—— raw 不可达时唯一能走的路。
 * 结果按仓库缓存在内存 + sessionStorage，来回点星不会反复打接口。
 */
async function fetchReadme(repo: string): Promise<string | null> {
  if (readmeCache.has(repo)) return readmeCache.get(repo) ?? null;
  const key = `vibedesk.readme.${repo}`;
  try {
    const hit = sessionStorage.getItem(key);
    if (hit !== null) { readmeCache.set(repo, hit); return hit; }
  } catch { /* 隐私模式：只用内存缓存 */ }

  const keep = (text: string | null): string | null => {
    readmeCache.set(repo, text);
    if (text) { try { sessionStorage.setItem(key, text); } catch { /* 超配额就算了 */ } }
    return text;
  };

  for (const name of README_NAMES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${name}`,
        { signal: ctrl.signal });
      if (res.ok) return keep(await res.text());
    } catch { /* 换下一个名字 */ } finally { clearTimeout(timer); }
  }

  for (const name of README_NAMES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/contents/${name}`,
        { headers: { Accept: 'application/vnd.github+json' }, signal: ctrl.signal });
      if (res.ok) {
        const data = await res.json() as { content?: string; encoding?: string };
        if (data.encoding === 'base64' && data.content) {
          const bin = atob(data.content.replace(/\n/g, ''));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return keep(new TextDecoder('utf-8').decode(bytes));
        }
      }
    } catch { /* 换下一个名字 */ } finally { clearTimeout(timer); }
  }
  return keep(null);
}

/** README 里的相对图片/链接换成 raw 直链，否则卡片里全是碎图 */
function absolutize(md: string, repo: string): string {
  const base = `https://raw.githubusercontent.com/${repo}/HEAD/`;
  return md.replace(/(!?\[[^\]]*\]\()(?!https?:\/\/|#|\/)([^)\s]+)(\))/g,
    (_m, head: string, path: string, tail: string) =>
      `${head}${base}${path.replace(/^\.\//, '')}${tail}`);
}

/**
 * 顶部徽章（图片套链接，如 ![Tests](…badge.svg) 外面再包一层链接）在卡片里只是噪音：
 * 图片挂了就剩一串空 alt 和一个 (LICENSE)。整行丢掉，正文从第一段话开始。
 */
function stripBadges(md: string): string {
  return md
    .replace(/^[ \t]*(?:\[!\[[^\]\n]*\]\([^)\n]*\)\]\([^)\n]*\)|!\[[^\]\n]*\]\([^)\n]*\))[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimStart();
}

interface Box { left: number; top: number; width: number; height: number }

/** 字段里可点的一小段：跳到另一颗星，或按标签搜。点它不要误触「点正文进书写态」 */
function chip(text: string, act: () => void): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'chip-link';
  a.href = '#';
  a.textContent = text;
  a.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    act();
  });
  return a;
}

type FieldCell = string | HTMLElement;
/** [字段名, 内容, 外链?] —— 内容可以是文字，也可以是一排可点的小标签 */
type FieldRow = [string, FieldCell, string?];

const REST =
  `left 400ms ${EASE_OUT},top 400ms ${EASE_OUT},` +
  `width 400ms ${EASE_OUT},height 400ms ${EASE_OUT},` +
  'background 400ms ease,border-color 400ms ease,box-shadow 400ms ease';

const SEGMENT: Record<string, Segment> = {
  grow: 'grow',
  expand: 'expand',
  collapseToView: 'collapse',
  close: 'collapse'
};

export class Station {
  private readonly timers: number[] = [];
  /** 上次离开时的工位：同一颗恒星重开，回到上次的位置 */
  private last: { id: string; mode: StationMode } | null = null;
  /** 删除请求：数据、实体、提示都由 main.ts 接（这层不碰存储） */
  onDelete: ((id: string) => void) | null = null;

  private readonly delBtn: HTMLButtonElement | null;
  private delTimer = 0;
  /** 连点两颗星时，晚到的 README 不许盖掉后开的那颗 */
  private readmeToken = 0;

  constructor(
    private readonly el: HTMLElement,
    private readonly entities: Entities
  ) {
    this.delBtn = el.querySelector<HTMLButtonElement>('#vc-del');
    this.delBtn?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.askDelete();
    });

    // 点击观看态正文直接进书写态 —— 读到一半想改，不用先找 Tab。
    // 自动保存本来就开着；回看区与删除按钮自己有交互，点它们不算「想写」。
    el.addEventListener('click', (ev: Event) => {
      const s = getState();
      if (!s.station || s.mode !== 'view') return;
      const t = ev.target;
      if (!(t instanceof Element) || t.closest('#vc-del,#vc-recall')) return;
      const found = findEntity(s.station);
      if (!found) return;
      const k = found.e.kind;
      if (k !== 'note' && k !== 'phantom') return;   // 项目卡 / 光门没有正文
      this.toWrite();
    });

    // 项目说明：点一下展开/收起 README 全文。链接自己跳，不拦它
    el.addEventListener('click', (ev: Event) => {
      const t = ev.target;
      if (!(t instanceof Element) || t.closest('a,#vc-del')) return;
      const box = t.closest<HTMLElement>('#vc-readme');
      if (!box || !box.classList.contains('can-open')) return;
      ev.stopPropagation();
      this.setReadmeOpen(box, !box.classList.contains('open'));
    });
  }

  /**
   * 两步删除：第一次点变「确认删除？」，3 秒内再点才真删。
   * 不做 confirm 弹窗 —— 它打断视线；这里只是把决定放慢一拍。
   */
  private askDelete(): void {
    const s = getState();
    const btn = this.delBtn;
    if (!btn || !s.station || s.mode !== 'view') return;
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = '确认删除？';
      clearTimeout(this.delTimer);
      this.delTimer = window.setTimeout(() => this.disarmDelete(), 3200);
      return;
    }
    clearTimeout(this.delTimer);
    const id = s.station;
    this.disarmDelete();
    this.onDelete?.(id);
  }

  private disarmDelete(): void {
    clearTimeout(this.delTimer);
    if (!this.delBtn) return;
    this.delBtn.classList.remove('armed');
    this.delBtn.textContent = '删除';
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.length = 0;
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  /** 已经走过当前这段动效的百分之多少；没在动就是 0 */
  private progress(): number {
    const t = getState().transition;
    if (!t) return 0;
    const seg = SEGMENT[t.kind];
    if (!seg) return 0;
    return Math.min(1, elapsed() / MOTION[seg].ms);
  }

  private frame(n: number, anim: Segment | '' = ''): void {
    this.el.dataset['frame'] = String(n);
    if (anim) this.el.dataset['anim'] = anim;
  }

  /** 内容层开关：显隐与过渡都交给 CSS，JS 只翻一个属性 */
  private content(which: 'view' | 'write', on: boolean): void {
    this.el.dataset[which] = on ? '1' : '0';
  }

  /** 站体尺寸：书写态铺满，观看态居中（落位不跟星体走，见下方注释） */
  private box(_e: EntityDef, mode: StationMode): Box {
    const W = innerWidth;
    const H = innerHeight;
    if (mode === 'write') {
      // 书写态基本铺满；runner 打开时要分左右两半，四周留白再收一档
      return {
        left: Math.max(14, W * .018),
        top: Math.max(14, H * .028),
        width: W - Math.max(28, W * .036),
        height: H - Math.max(28, H * .056)
      };
    }
    const narrow = W < 720;
    // 自适应：窄屏（手机 / 分屏）不再按比例缩成一条缝，直接贴边铺开；
    // 大屏给到七成宽、接近全高 —— 看正文不必再委屈
    const w = narrow ? W - 24 : Math.min(940, W * .72);
    const h = narrow ? Math.min(H - 96, 520) : Math.min(640, H * .78);
    if (narrow) {
      return {
        left: Math.max(12, W * .03),
        top: Math.max(56, H * .08),
        width: w,
        height: h
      };
    }
    // 观看态一律居中：项目卡和笔记都是拿来读的，贴着星体靠边站就得偏头看，
    // 大屏上还会一半顶到屏幕边缘。生长动画的朝向由 transformOrigin 单独算，
    // 站体照样是「从这颗星长出来的」，只是落位在屏幕中间。
    const left = Math.round((W - w) / 2);
    const top = Math.round(Math.max(56, Math.min((H - h) / 2, H - h - 20)));
    return { left, top, width: w, height: h };
  }

  private place(b: Box): void {
    this.el.style.left = `${b.left}px`;
    this.el.style.top = `${b.top}px`;
    this.el.style.width = `${b.width}px`;
    this.el.style.height = `${b.height}px`;
  }

  /** 动画照常播，但布局不押在插值上：关掉过渡、写死终态、再强制回流 */
  private force(box?: Box): void {
    const prev = this.el.style.transition;
    const grid = this.el.querySelector<HTMLElement>('.station-grid');
    const tg = grid?.style.transition ?? '';
    this.el.style.transition = 'none';
    if (box) this.place(box);
    this.el.style.opacity = '1';
    this.el.style.transform = 'scale(1)';
    if (grid) {
      grid.style.transition = 'none';
      grid.style.opacity = this.el.dataset['mode'] === 'write' ? '0' : '0.13';
    }
    void this.el.offsetWidth;
    if (grid) grid.style.transition = tg;
    this.el.style.transition = prev;
  }

  open(id: string): void {
    const found = findEntity(id);
    if (!found) return;
    const { e, scene } = found;
    const s = getState();

    if (s.scene !== scene) {
      setState({ scene, focus: null });
      this.after(210, () => this.open(id));
      return;
    }
    if (s.station === id && this.el.classList.contains('on')) return;
    if (s.station && s.station !== id) {
      this.close();
      this.after(430, () => this.open(id));
      return;
    }

    // 同一颗星重开，回到上次工位（附录 A5 最后一条）
    const resume: StationMode = this.last && this.last.id === id ? this.last.mode : 'view';

    setState({ station: id, mode: 'view', focus: id, locked: true });
    this.clearTimers();
    this.disarmDelete();
    this.fill(e);

    const star = this.entities.rect(id);
    const box = this.box(e, 'view');
    // 生长原点：站体中心 + 指向恒星的矢量（投影到框边），不是屏幕绝对像素
    this.el.style.transformOrigin = growthOrigin(box, star);
    this.place(box);
    this.el.dataset['mode'] = 'view';
    this.content('view', false);
    this.content('write', false);
    this.el.classList.add('on');

    const g = MOTION.grow;
    const goWrite = (): void => { this.last = { id, mode: resume }; if (resume === 'write') this.toWrite(); };

    if (getState().reduce) {
      this.el.style.transition = 'none';
      this.el.style.opacity = '1';
      this.el.style.transform = 'scale(1)';
      this.frame(3);
      this.content('view', true);
      this.force(box);
      this.after(0, () => { this.el.style.transition = REST; this.el.dataset['anim'] = ''; });
      end();
      goWrite();
      return;
    }

    this.frame(0, 'grow');
    this.el.style.transition = 'none';
    this.el.style.opacity = '0';
    this.el.style.transform = 'scale(.6)';
    void this.el.offsetWidth;                    // 锁住起始帧，别让浏览器合并成「无动画」
    this.el.style.transition =
      `opacity ${g.ms}ms ease-out,transform ${g.ms}ms var(--ease-grow),` + REST;
    this.el.style.opacity = '1';
    this.el.style.transform = 'scale(1)';
    begin('grow');

    this.after(g.frames[0]!, () => this.frame(1, 'grow'));
    // 帧 3：网格填充 → 观看态 UI 在同一帧开始浮现，600ms 时正好就绪
    this.after(g.frames[1]!, () => { this.frame(2, 'grow'); this.content('view', true); });
    this.after(g.frames[2]!, () => {
      this.frame(3);
      this.el.dataset['anim'] = '';
      this.el.style.transition = REST;
      if (getState().station === id) this.force(box);
      end('grow');
      goWrite();
    });
  }

  /** 笔记内容变了：重填观看态（不重播动效） */
  refresh(): void {
    const s = getState();
    if (!s.station || s.mode !== 'view') return;
    const found = findEntity(s.station);
    if (!found) return;
    this.fill(found.e);
  }

  /** 窗口尺寸变了：只重算盒子，不重播动效 */
  relayout(): void {
    const s = getState();
    if (!s.station) return;
    const found = findEntity(s.station);
    if (!found) return;
    this.place(this.box(found.e, s.mode));
  }

  toWrite(): void {
    const s = getState();
    if (!s.station || s.mode === 'write') return;
    if (growInFlight(s)) {
      // 只在真的还在长的时候等；等剩下的时间，不是等满 600ms
      const wait = Math.max(0, MOTION.grow.ms - elapsed()) + 20;
      this.after(wait, () => this.toWrite());
      return;
    }
    const found = findEntity(s.station);
    if (!found) return;

    const x = MOTION.expand;
    // 工位记忆以「到过书写态」为准：Esc 会先退回观看态，
    // 若等收站那一刻再记，就永远记成观看态，「回到上次工位」等于没做。
    this.last = { id: s.station, mode: 'write' };
    this.disarmDelete();
    setState({ mode: 'write' });
    this.el.dataset['mode'] = 'write';
    this.place(this.box(found.e, 'write'));
    begin('expand');
    this.frame(0, 'expand');
    this.content('view', false);                 // 观看态 UI 先溶解

    this.after(x.frames[0]!, () => this.frame(1, 'expand'));
    // 帧 3：双栏初现（260ms），到 400ms 正好就绪
    this.after(x.frames[1]!, () => { this.frame(2, 'expand'); this.content('write', true); });
    this.after(x.frames[2]!, () => {
      if (getState().mode !== 'write') return;
      this.frame(3);
      this.el.dataset['anim'] = '';
      const cur = findEntity(getState().station ?? '');
      if (cur) this.force(this.box(cur.e, 'write'));
      end('expand');
    });
  }

  toView(): void {
    const s = getState();
    if (!s.station || s.mode === 'view') return;
    const found = findEntity(s.station);
    if (!found) return;

    const c = MOTION.collapse;
    setState({ mode: 'view' });
    this.el.dataset['mode'] = 'view';
    this.place(this.box(found.e, 'view'));
    begin('collapseToView');
    this.frame(0, 'collapse');
    this.content('write', false);                // 书写 UI 先溶解

    this.after(c.frames[0]!, () => { this.frame(1, 'collapse'); this.content('view', true); });
    this.after(c.frames[1]!, () => this.frame(2, 'collapse'));
    this.after(c.frames[2]!, () => {
      const cs = getState();
      if (cs.mode !== 'view' || !cs.station) return;
      this.frame(3);
      this.el.dataset['anim'] = '';
      const cur = findEntity(cs.station);
      if (cur) this.force(this.box(cur.e, 'view'));
      end('collapseToView');
    });
  }

  close(): void {
    const s = getState();
    if (!s.station) return;
    if (s.transition && s.transition.kind === 'close') return;   // 已在收，别叠加

    const id = s.station;
    const fromMode = s.mode;
    this.clearTimers();

    const found = findEntity(id);
    const star = found ? this.entities.rect(found.e.id) : null;

    // 从中途按 Esc：按已走进度缩短反向时长，不跳帧也不拖沓
    const ms = getState().reduce ? 0 : reverseMs(this.progress(), MOTION.collapse.ms);
    this.el.dataset['reverse'] = String(ms);
    // 只有没记录过这颗星时才写入；到过书写态的记忆不能被「从观看态退出」覆盖
    if (!this.last || this.last.id !== id) this.last = { id, mode: fromMode };

    // 顺序严格：内部 UI 先溶解 → 粒子飞回 → 方框收缩
    this.content('view', false);
    this.content('write', false);
    this.frame(0, 'collapse');

    const finish = (): void => {
      this.el.classList.remove('on');
      this.el.dataset['anim'] = '';
      this.frame(0);
      this.el.dataset['mode'] = 'view';
      this.el.style.opacity = '0';
      this.el.style.transform = 'scale(.6)';
      setState({ station: null, mode: 'view', locked: false, transition: null });
    };

    if (ms === 0) { finish(); return; }

    begin('close');
    this.after(60, () => this.spawnParticles(star));
    this.after(Math.round(ms * .3), () => this.frame(1, 'collapse'));
    this.after(Math.round(ms * .65), () => this.frame(2, 'collapse'));

    this.el.style.transition =
      `opacity ${ms}ms ease-in,transform ${ms}ms ease-in-out,` +
      `left ${ms}ms ${EASE_OUT},top ${ms}ms ${EASE_OUT},` +
      `width ${ms}ms ${EASE_OUT},height ${ms}ms ${EASE_OUT}`;
    this.el.style.opacity = '0';
    this.el.style.transform = 'scale(.6)';
    this.after(ms, finish);
  }

  /** 收回时粒子飞回恒星：确认「它是从这颗星长出来的」。≤24 颗，200ms 内淡到 0 */
  private spawnParticles(target: DOMRect | null): void {
    const layer = document.getElementById('particles');
    if (!layer) return;
    layer.textContent = '';
    if (getState().reduce || !target) return;
    const box = this.el.getBoundingClientRect();
    const n = Math.min(24, Math.max(6, Math.round(box.width * box.height / 26000)));
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i');
      p.className = 'pt';
      const sx = box.left + Math.random() * box.width;
      const sy = box.top + Math.random() * 24;          // 从顶缘一带起飞，像被吸走
      p.style.left = `${sx}px`;
      p.style.top = `${sy}px`;
      layer.appendChild(p);
      p.animate(
        [{ transform: 'translate(0,0)', opacity: .8 },
         { transform: `translate(${target.left - sx}px,${target.top - sy}px)`, opacity: 0 }],
        { duration: 200, easing: 'ease-out', fill: 'forwards' }
      );
    }
    this.after(220, () => { layer.textContent = ''; });
  }

  private fill(e: EntityDef): void {
    const set = (id: string, text: string): void => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    // 笔记类实体：真实数据优先，实体定义只作兜底。
    // 这样星表上的名字来自笔记本身，而不是写在坐标表里。
    const note = e.kind === 'note' ? noteOf(e.id) : undefined;
    const body = note?.body ?? '';
    set('vc-top', e.kind === 'project'
      ? '工作站 · 项目星系 / 行星 · 观看态 VIEW'
      : e.kind === 'gate'
        ? '工作站 · 纪念光门 / 站外入口 · 观看态 VIEW'
        : '工作站 · 学习星系 / 恒星 · 观看态 VIEW');
    set('vc-title', note?.title ?? e.label);
    set('vc-sub', note
      ? `${relTime(note.updatedAt)} · ${countWords(body)} 字`
      : e.sub);

    const fields = document.getElementById('vc-fields');
    if (!fields) return;
    fields.textContent = '';

    // 观看态字段只放「一眼能懂、且点了有用」的东西。
    //   关联不在这里列：关系交给星图上的线，建立方式是在星图上长按一颗星拖到另一颗。
    //   「生长 / 幼苗」这类黑话和「按 Tab 改」这类操作提示也都不放进来。
    const ent = entityOf(e.id);
    const detail = entityDetail(e.id);

    const tagBox = document.createElement('span');
    const tags = parseTags(body);
    if (tags.length) {
      tags.slice(0, 5).forEach(t => tagBox.appendChild(chip('#' + t, () => {
        document.dispatchEvent(new CustomEvent('vibe:search-tag', { detail: t }));
      })));
    } else {
      tagBox.textContent = '—';
    }

    const rows: FieldRow[] = e.kind === 'project'
      ? [['简介', detail['summary'] || '—'],
         ['技术栈', detail['stack'] || '—'],
         ['仓库', ent?.url || '未配置', ent?.url || undefined]]
      : e.kind === 'gate'
        ? [['性质', '站外网站入口，非台内纪念内容'],
           ['URL', ent?.url || '未配置 · 待提供', ent?.url || undefined],
           ['打开', ent?.url ? '点击光门 · 新标签页' : 'URL 未配置']]
        : [['标签', tagBox],
           // 副标题已给了「3 天前」这种相对时间，这里补一个确切日期才不重复
           ['改动', note ? new Date(note.updatedAt).toLocaleString('zh-CN', {
             year: 'numeric', month: '2-digit', day: '2-digit',
             hour: '2-digit', minute: '2-digit', hour12: false
           }) : '—']];

    rows.forEach(([k, v, href]) => {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = k;
      const span = document.createElement('span');
      if (href) {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = String(v);
        a.title = href;
        span.appendChild(a);
      } else if (typeof v === 'string') {
        span.textContent = v;
      } else {
        span.appendChild(v);
      }
      d.append(b, span);
      fields.appendChild(d);
    });

    // 决策只露最近一条：问题 → 选择，理由挂在 title 上（要读理由就进书写态）。
    // 这里绝不出现「共几条」—— 那会立刻变成一张统计卡（C7 / C9）。
    const dec = latestOf(e.id);
    if (dec) {
      const row = document.createElement('div');
      row.className = 'dec';
      const b = document.createElement('b');
      b.textContent = '决策';
      const span = document.createElement('span');
      span.textContent = `${dec.q} → `;
      const em = document.createElement('em');
      em.textContent = dec.pick;
      span.appendChild(em);
      row.append(b, span);
      if (dec.why) row.title = dec.why;
      fields.appendChild(row);
    }

    this.fillRecall(e, note);

    // 换星就作废上一颗的 README 请求，并把折叠态清干净
    this.readmeToken++;
    const rmBox = document.getElementById('vc-readme');
    rmBox?.classList.remove('can-open', 'open');
    rmBox?.classList.toggle('flow', e.kind === 'project');
    const rmTools = document.getElementById('vc-readme-tools');
    if (rmTools) rmTools.textContent = '';

    set('vc-readme-h', e.kind === 'gate'
      ? '边界说明 / SCOPE'
      : e.kind === 'project' ? '项目说明 / README' : '正文 · 摘录');

    if (e.kind === 'project') {
      void this.fillProjectReadme(ent?.url, detail['summary'] || '', e.label);
    } else {
      set('vc-readme-p', e.kind === 'gate'
        ? (detail['note'] || '纪念册只是站外入口：台内只保留一颗恒定亮度的深空天体与站外链接，不存在第二份纪念内容。')
        : note
          ? (body.trim() ? excerpt(body, 140) : '还没有正文。点正文或按 Tab 写第一句 —— 不用先想标题。')
          : '笔记以恒星呈现，关联以光丝呈现；坐标一经分配即固定，亮度只在 ±15% 内波动，旧笔记永不降到不可见。');
    }
    set('vc-foot-hint', e.kind === 'project'
      ? '点项目说明展开 README　　Esc 收站'
      : e.kind === 'gate' ? '点光门打开站外页面　　Esc 收站'
        : '点正文或 Tab 进入书写　　Esc 收站');
    // 大标题已经写了篇名，顶栏别再重复一次；这里放「我在哪」
    set('wc-name', e.kind === 'note' ? '学习星系 / 恒星' : e.label);

    this.fillImages(note);
  }

  /**
   * 项目卡：把仓库里的 README.md 直读进来。
   * 字段只有「简介 / 技术栈 / 仓库」三行，下面一大片空白 —— 那本来该是 README。
   * 取不到就退回简介，并给一个 GitHub 链接，绝不留一句「加载失败」了事。
   */
  private async fillProjectReadme(url: string | undefined, summary: string, title: string): Promise<void> {
    const box = document.getElementById('vc-readme');
    const host = document.getElementById('vc-readme-p');
    const tools = document.getElementById('vc-readme-tools');
    if (!box || !host || !tools) return;
    const token = ++this.readmeToken;
    host.className = 'vc-readme-body';
    box.classList.remove('can-open', 'open');

    const repo = repoOf(url);
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'GitHub 仓库 ↗';
      a.title = url;
      tools.appendChild(a);
    }
    if (!repo) {
      host.textContent = summary || '仓库地址不是 GitHub · 在这里只看简介';
      return;
    }

    host.textContent = '读取 README…';
    const md = await fetchReadme(repo);
    if (token !== this.readmeToken) return;       // 已经切到别的星

    if (!md) {
      host.textContent = summary
        ? `${summary}（README 暂不可达 · 点右上「GitHub 仓库」看原文）`
        : 'README 暂不可达 · 点右上「GitHub 仓库」看原文';
      return;
    }

    // 一级标题和页面大标题重复：README 自己那句「# 项目名」去掉
    const clean = stripBadges(md).replace(/^#\s+([^\n]+)\n?/, (m, t: string) =>
      t.trim().toLowerCase() === title.trim().toLowerCase() ? '' : m);
    host.innerHTML = mdLite(absolutize(clean, repo));
    if (clean.length < 400) return;                // 一屏放得下，不用折叠

    const hint = document.createElement('span');
    hint.className = 'vc-rm-hint';
    hint.textContent = '点击展开全文';
    tools.prepend(hint);
    box.classList.add('can-open');
  }

  /** 展开 / 收起 README 全文 */
  private setReadmeOpen(box: HTMLElement, open: boolean): void {
    box.classList.toggle('open', open);
    const hint = box.querySelector<HTMLElement>('.vc-rm-hint');
    if (hint) hint.textContent = open ? '点击收起' : '点击展开全文';
    // 收起时内容一下缩短，滚动位置会落在半空：拉回说明区顶部
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Esc 逐层退：README 展开了先收起，别一下子把站收掉 */
  collapseReadme(): boolean {
    const box = document.getElementById('vc-readme');
    if (!box?.classList.contains('open')) return false;
    this.setReadmeOpen(box, false);
    return true;
  }

  /**
   * 观看态：正文引用的前几张图。
   * 截图是学习笔记的一等公民 —— 只给文字摘要等于把图丢了。
   */
  private fillImages(note: Note | undefined): void {
    this.el.querySelector('.vc-imgs')?.remove();
    if (!note || !note.body) return;
    const ids = imagesOf(note.body).slice(0, 3);
    if (!ids.length) return;
    const host = document.getElementById('vc-readme-p');
    if (!host) return;
    const box = document.createElement('div');
    box.className = 'vc-imgs';
    for (const id of ids) {
      const img = document.createElement('img');
      img.alt = '笔记图片';
      img.loading = 'lazy';
      void assetUrl(id).then(url => { if (url) img.src = url; });
      box.appendChild(img);
    }
    host.after(box);
  }

  /**
   * 该回看 · 站内那一道题。
   * 一行你自己的话，挖掉一个小句，三个词作答；答完即散。
   * 没有「已记录」、没有 +1、没有今日进度 —— 它不是你今天的任务。
   */
  private fillRecall(e: EntityDef, note: Note | undefined): void {
    const box = document.getElementById('vc-recall');
    if (!box) return;
    box.className = 'vc-recall';
    box.textContent = '';
    if (!note || e.kind !== 'note') return;
    if (!dueList().includes(e.id)) return;
    const q = recallQuestion(e.id);
    if (!q) return;

    const lb = document.createElement('div');
    lb.className = 'rc-lb';
    lb.textContent = '回看 · 这里原本写着什么';

    const qq = document.createElement('div');
    qq.className = 'rc-q';
    if (q.lead) qq.appendChild(document.createTextNode('…' + q.lead));
    const blank = document.createElement('span');
    blank.className = 'rc-blank';
    blank.textContent = '　';
    qq.appendChild(blank);
    const cut = document.createElement('span');
    cut.className = 'rc-cut';
    cut.textContent = q.post ?? '　…';
    // 后半句以标点起头时收紧一点，让「空白 + 逗号」读起来是一句话
    if (q.post && /^[，、；：]/.test(q.post)) cut.style.marginLeft = '-3px';
    qq.appendChild(cut);

    const opts = document.createElement('div');
    opts.className = 'rc-opts';
    const labels: readonly (readonly [RecallAnswer, string])[] = [
      ['ok', '还记得'], ['fuzzy', '有点模糊'], ['lost', '忘了']
    ];
    for (const [kind, text] of labels) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.addEventListener('click', () => this.answer(e.id, kind, btn, box));
      opts.appendChild(btn);
    }

    box.append(lb, qq, opts);
    box.classList.add('on');
  }

  private answer(id: string, kind: RecallAnswer, btn: HTMLElement, box: HTMLElement): void {
    btn.classList.add('picked');
    box.classList.add('gone');
    window.setTimeout(() => {
      box.className = 'vc-recall';
      box.textContent = '';
    }, 400);
    void answerRecall(id, kind).then(() => {
      // 星表上那道刻度跟着退掉：只改 class，不重建实体
      this.entities.applyDue(new Set(dueList()));
    }).catch(err => console.warn('[review] 记录失败', err));
  }

  /** 给键盘层用：Enter/Esc 的语义按当前状态决定 */
  activate(id: string): void {
    const found = findEntity(id);
    if (!found) return;
    const { e } = found;
    if (e.kind === 'galaxy' && e.scene) {
      setState({ scene: e.scene, focus: null });
      toast(`推近到 ${e.label}`);
      return;
    }
    if (e.kind === 'gate') {
      const url = entityOf(e.id)?.url;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      else toast('纪念册 · 站外入口占位：URL 未配置');
      return;
    }
    if (e.kind === 'core') { toast('AI 星核为预留位'); return; }
    if (e.kind === 'spider') { window.dispatchEvent(new CustomEvent('vibe:vault-open')); return; }
    if (e.kind === 'phantom') { toast('虚影恒星 · 待写笔记'); this.open(id); return; }
    this.open(id);
  }
}
