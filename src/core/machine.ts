/**
 * 状态迁移规则集中在这里。
 * 原型阶段最贵的债是把「能不能进下一个态」散在十几个 if 里——
 * 换脚手架时这笔债会直接变成要重写的分支。
 */
import { getState, setState, type AppState, type TransitionKind } from './state';

export const begin = (kind: TransitionKind): void =>
  setState({ transition: { kind, t0: performance.now() } });

export const end = (kind?: TransitionKind): void => {
  const t = getState().transition;
  if (kind && t && t.kind !== kind) return;   // 已被别的迁移接管，不要覆盖
  setState({ transition: null });
};

export const elapsed = (): number => {
  const t = getState().transition;
  return t ? performance.now() - t.t0 : Infinity;
};

/** 生长动画真正进行中（<700ms）才值得等待；否则会因 onfinish 未触发而永久挂起 */
export const growInFlight = (s: AppState = getState()): boolean =>
  !!s.transition && s.transition.kind === 'grow' && performance.now() - s.transition.t0 < 700;

export const isBusyClosing = (s: AppState = getState()): boolean =>
  !!s.transition && s.transition.kind === 'close';

/** 站体已开：同 id 重复打开是幂等的，不同 id 必须先收回再开 */
export const canOpenDirectly = (id: string, s: AppState = getState()): boolean =>
  !s.station || s.station === id;
