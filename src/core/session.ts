/**
 * 会话记忆（验收 A5：关掉再开，回到上次位置 + 上次工位）。
 *
 * 只记四件事：在哪一层、开着哪颗星、在哪个工位、什么时候记的。
 * 刻意不记焦距/缩放/视差 —— 那些是「此刻的手感」，不是「上次的位置」，
 * 存下来只会在下次打开时让人怀疑自己是不是点错了。
 */
import { getState, type SceneName, type StationMode } from './state';
import { metaGet, metaSet } from '../storage/db';

export interface SessionView {
  scene: SceneName;
  station: string | null;
  mode: StationMode;
  at: number;
}

const KEY = 'view';
const DELAY = 400;

let timer = 0;
let lastSig = '';

const isScene = (v: unknown): v is SceneName => v === 'galaxy' || v === 'study' || v === 'code';

/**
 * 状态一变就排一次写入。同一段停留只写一次（按 场景|站|工位 判重），
 * 否则任意状态变更（hover 改 focus、提示改状态等）都会变成持续的写盘。
 */
export function rememberView(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    // 延迟取状态：连点两下时写的是最后一次
    void snapshot();
  }, DELAY);
}

async function snapshot(): Promise<void> {
  const s = getState();
  const sig = `${s.scene}|${s.station ?? ''}|${s.mode}`;
  if (sig === lastSig) return;
  lastSig = sig;
  try {
    await metaSet(KEY, { scene: s.scene, station: s.station, mode: s.mode, at: Date.now() } satisfies SessionView);
  } catch {
    // 存储不可用不该影响任何交互
  }
}

export async function loadView(): Promise<SessionView | null> {
  try {
    const v = await metaGet(KEY) as Partial<SessionView> | undefined;
    if (!v || typeof v !== 'object' || !isScene(v.scene)) return null;
    return {
      scene: v.scene,
      station: typeof v.station === 'string' && v.station ? v.station : null,
      mode: v.mode === 'write' ? 'write' : 'view',
      at: typeof v.at === 'number' ? v.at : 0
    };
  } catch {
    return null;
  }
}
