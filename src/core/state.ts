/**
 * 唯一状态源。
 * 刻意不引状态库：这棵状态树很浅，而动画状态必须与 DOM 直接耦合，
 * 任何「异步批处理 + 派发」的中间层都会让可中断动效变得更难推理。
 */

export type SceneName = 'galaxy' | 'study' | 'code';
export type StationMode = 'view' | 'write';
export type EntityKind =
  | 'galaxy' | 'note' | 'project' | 'core' | 'gate' | 'spider' | 'phantom';
export type TransitionKind = 'grow' | 'expand' | 'collapseToView' | 'close';

export interface EntityDef {
  readonly id: string;
  readonly kind: EntityKind;
  readonly tone: string;
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly sub: string;
  readonly scene?: SceneName;
  readonly main?: boolean;
}

export interface Transition { readonly kind: TransitionKind; readonly t0: number; }

/** 刚刚走过的一条关联：星图据此让它短暂亮一下，过期自动失效 */
export interface Walked { readonly key: string; readonly until: number; }

export interface AppState {
  scene: SceneName;
  station: string | null;
  mode: StationMode;
  focus: string | null;
  /** 锁定 = 背景零运动。开站即锁，收站即解 */
  locked: boolean;
  reduce: boolean;
  transition: Transition | null;
  walked: Walked | null;
}

const prefersReduced = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let current: AppState = {
  scene: 'galaxy',
  station: null,
  mode: 'view',
  focus: null,
  locked: false,
  reduce: prefersReduced(),
  transition: null,
  walked: null
};

type Listener = (s: AppState) => void;
const listeners = new Set<Listener>();

export const getState = (): AppState => current;

export function setState(patch: Partial<AppState>): void {
  current = { ...current, ...patch };
  for (const fn of listeners) fn(current);
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
