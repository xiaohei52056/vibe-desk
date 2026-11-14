/**
 * 逐帧动效规格的唯一出处（对应设计文档附录 A）。
 *
 * 为什么单独一个文件：动效是这个应用里最容易被「顺手改一下」的东西。
 * 把时长、帧点、缓动、生长原点全部收在这里，改的时候只有一处可改，
 * 也才有可能写自动验收 —— 否则「600ms」会散落在 CSS、JS、和注释里各说一套。
 */

export type Segment = 'grow' | 'expand' | 'collapse';

export const MOTION: Record<Segment, { ms: number; frames: readonly number[] }> = {
  // 生长：0 / 120 / 300 / 600 —— 恒星表面光点 → 虚线轮廓 → 网格填充 → 观看态就绪
  grow: { ms: 600, frames: [120, 300, 600] },
  // 切换：0 / 120 / 260 / 400 —— 网格淡出 → 接近铺满 → 双栏就绪
  expand: { ms: 400, frames: [120, 260, 400] },
  // 收回：0 / 120 / 260 / 400 —— UI 溶解 → 粒子飞回 → 方框收缩
  collapse: { ms: 400, frames: [120, 260, 400] }
};

/** 附录 A2：生长用带回弹的曲线，切换与收回用纯出曲线 */
export const EASE_GROW = 'cubic-bezier(.34,1.56,.64,1)';
export const EASE_OUT = 'cubic-bezier(.22,1,.36,1)';

interface Box { left: number; top: number; width: number; height: number }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 生长原点：站体中心 + 指向恒星的生长矢量，落在框内靠恒星那一侧。
 *
 * 不用星的屏幕绝对坐标 —— 那个点在框外，缩放会「从屏幕角落长出来」，
 * 框看起来像被拉变形。这里把矢量射线投影到边框上取 85% 处：
 * 视觉上是「从恒星那一侧长出来」，几何上原点始终在框内。
 */
export function growthOrigin(box: Box, star: DOMRect | null): string {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const sx = star ? star.left + star.width / 2 : cx;
  const sy = star ? star.top + star.height / 2 : cy;
  const dx = sx - cx;
  const dy = sy - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1) return '50% 50%';

  // 射线与框边相交的参数（取两轴里先到的那个）
  const kx = Math.abs(dx) > 1e-6 ? (box.width / 2) / Math.abs(dx) : Infinity;
  const ky = Math.abs(dy) > 1e-6 ? (box.height / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(kx, ky) * 0.85;

  const ox = clamp(50 + ((dx * t) / box.width) * 100, 6, 94);
  const oy = clamp(50 + ((dy * t) / box.height) * 100, 6, 94);
  return `${ox.toFixed(1)}% ${oy.toFixed(1)}%`;
}

/**
 * 中断反向播放的时长：从中途按 Esc，不应该用完整 400ms 再收一次
 * （那会让「刚点开就按 Esc」感觉像卡了一下），也不应该瞬间消失（那是跳帧）。
 * 按当前进度等比缩放，并给一个下限，保证肉眼能看见「收回去」。
 */
export function reverseMs(progress: number, full: number = MOTION.collapse.ms, min = 140): number {
  return Math.max(min, Math.round(full * clamp(progress, 0, 1)));
}
