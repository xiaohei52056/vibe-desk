import { getState, subscribe } from '../core/state';
import { SCENE_NAME } from '../space/coords';

export function mountHud(): void {
  const place = document.getElementById('hud-place');
  const mode = document.getElementById('hud-mode');
  const hint = document.getElementById('hud-hint');
  const date = document.getElementById('hud-date');
  if (!place || !mode || !hint || !date) return;

  const paint = (): void => {
    const s = getState();
    place.textContent = `回到上次位置 · ${SCENE_NAME[s.scene]}`;
    mode.textContent = s.station
      ? (s.mode === 'write' ? '空间站 · 书写态' : '空间站 · 观看态')
      : '漂浮模式';
    hint.textContent = s.station
      ? 'ViewportLock · 相机与氛围层双锁'
      : '坐标冻结 · 实体不公转';
    date.textContent = new Date().toLocaleDateString('zh-CN',
      { year: 'numeric', month: '2-digit', day: '2-digit' });
  };

  paint();
  subscribe(paint);
}
