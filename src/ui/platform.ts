/**
 * 平台修饰键的显示名。
 *
 * 键位绑定本身是 metaKey || ctrlKey（mac 的 ⌘ 与 Windows 的 Ctrl 都吃），
 * 所以这里只负责「**说给用户听的是哪个键**」——在 Windows 上说 Cmd 是错的。
 */
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** ⌘ 或 Ctrl（含加号由调用方决定：有的地方写 ⌘+Enter，有的只写 ⌘） */
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** 组合键的完整写法：⌘+Enter / Ctrl+Enter */
export const MOD_KEY = (key: string): string => `${MOD}+${key}`;
