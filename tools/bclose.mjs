/**
 * 优雅关闭调试实例：走 CDP 的 Browser.close，让 Chrome 正常收尾。
 * 用途：验证「关掉浏览器再打开，笔记还在」——用 kill 打断进程会把
 * 还没落盘的 LevelDB 写批次一起带走，那是测法的问题，不是应用的问题。
 */
const PORT = process.env.CDP_PORT ?? '9222';
const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
await new Promise(r => setTimeout(r, 1200));
process.exit(0);
