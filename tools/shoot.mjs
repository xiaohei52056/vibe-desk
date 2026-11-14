/**
 * 极简无头驱动：Chrome DevTools Protocol，零依赖（Node 22 内置 WebSocket）。
 * 用途：P5 视觉回归——用真实鼠标/键盘走一遍交互，而不是调内部函数，
 * 这样实体点击区域、坐标换算、键盘语义都一起被验到。
 *
 * 步骤语法：
 *   js:<expression>        在页面里求值
 *   hover:<selector>       鼠标移到元素中心
 *   click:<selector>       点击元素中心
 *   key:<Enter|Tab|Escape> 发送按键
 *   type:<文本>            向焦点插入文本
 *   focus:<selector>       聚焦元素
 *   wait:<ms>
 *
 * 用法：node tools/shoot.mjs <url> <out.png> [step ...]
 */
const [url, out, ...steps] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/shoot.mjs <url> <out.png> [step ...]');
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = process.env.CDP_PORT ?? '9222';

async function endpoint() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* chrome 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP endpoint not ready');
}

const ws = new WebSocket(await endpoint());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const errors = [];
const logs = [];
const traced = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const a = (m.params.args || []).map(x => x.value ?? x.description ?? x.type);
    logs.push(m.params.type + ': ' + a.join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push(d.text + ' ' + (d.exception?.description ?? ''));
  }
};

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression);
  return r.result?.value;
};

const center = async (selector) => {
  const pos = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return null; const r=el.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  if (!pos) throw new Error('selector not found: ' + selector);
  return pos;
};

const mouse = async (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mousePressed' ? 1 : 0
});

const KEY = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38 };
/** 可打印字符必须带 text，否则页面只收到一个 keyCode=0 的空键，`/` 之类的单键会失效 */
const key = async (name) => {
  if (name.length === 1) {
    const code = name.toUpperCase().charCodeAt(0);
    const codeName = name === '/' ? 'Slash' : /[a-zA-Z]/.test(name) ? 'Key' + name.toUpperCase() : name;
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: name, code: codeName, text: name, unmodifiedText: name,
      windowsVirtualKeyCode: code, nativeVirtualKeyCode: code
    });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: codeName });
    return;
  }
  const code = KEY[name] ?? 0;
  const text = name === 'Enter' ? '\r' : name === 'Tab' ? '\t' : '';
  const codeName = name === 'Escape' ? 'Escape' : name;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: codeName, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: codeName, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
};

await send('Page.enable');
await send('Runtime.enable');
// 需要验「导出」时给一个下载目录：headless 默认把下载丢掉
if (process.env.DOWNLOADS) {
  const dir = process.env.DOWNLOADS;
  try { await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }); }
  catch {
    try { await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }); } catch { /* 老版本才需要 */ }
  }
}
await send('Page.navigate', { url });
await sleep(1600);

for (const step of steps) {
  // 每步先打一行：长任务被中断时，至少能看到停在哪一步
  process.stderr.write('  · ' + step.slice(0, 70) + '\n');
  const [verb, ...rest] = step.split(':');
  const arg = rest.join(':');
  try {
    if (verb === 'js') { const v = await evaluate(arg); traced.push(['js', arg, v]); }
    else if (verb === 'hover') { const p = await center(arg); await mouse('mouseMoved', p.x, p.y); }
    else if (verb === 'click') {
      const p = await center(arg);
      await mouse('mouseMoved', p.x, p.y);
      await mouse('mousePressed', p.x, p.y);
      await mouse('mouseReleased', p.x, p.y);
    }
    else if (verb === 'key') await key(arg);
    else if (verb === 'meta') {
      // Cmd+K 这类组合键：CDP modifiers 里 Meta=4。
      // 命名键（Enter/Tab/Escape）也要支持 —— Cmd+Enter 是「运行代码」，
      // 按首字母算 charCode 会得到 E(69)，页面收到的是一个不存在的键。
      const k = arg;
      const named = KEY[k] ?? 0;
      const code = named || k.toUpperCase().charCodeAt(0);
      const codeName = named ? k : 'Key' + k.toUpperCase();
      const text = k === 'Enter' ? '\r' : '';
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: k, code: codeName, text,
        windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: 4
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: k, code: codeName,
        windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: 4
      });
    }
    else if (verb === 'file') {
      // 给 <input type=file> 塞一个本地文件：走 CDP，浏览器会自己发 input/change
      const sep = arg.indexOf('|');
      const sel = arg.slice(0, sep);
      const path = arg.slice(sep + 1);
      await send('DOM.enable');
      const { root } = await send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      if (!nodeId) throw new Error('file input not found: ' + sel);
      await send('DOM.setFileInputFiles', { nodeId, files: [path] });
    }
    else if (verb === 'type') await send('Input.insertText', { text: arg });
    else if (verb === 'focus') { await evaluate(`document.querySelector(${JSON.stringify(arg)}).focus()`); }
    else if (verb === 'wait') await sleep(Number(arg));
    else if (verb === 'reload') { await send('Page.reload', { ignoreCache: false }); await sleep(1600); }
    else if (verb === 'nav') { await send('Page.navigate', { url: arg }); await sleep(1600); }
    else if (verb === 'perf') {
      // 一段窗口内每帧的 JS 成本：TaskDuration 含主线程一切任务，ScriptDuration 只算脚本
      await send('Performance.enable');
      const pick = (m, k) => (m.metrics.find(x => x.name === k) ?? {}).value ?? 0;
      const a = await send('Performance.getMetrics');
      await sleep(Number(arg) || 2000);
      const b = await send('Performance.getMetrics');
      const frames = pick(b, 'Frames') - pick(a, 'Frames');
      const script = (pick(b, 'ScriptDuration') - pick(a, 'ScriptDuration')) * 1000;
      const task = (pick(b, 'TaskDuration') - pick(a, 'TaskDuration')) * 1000;
      traced.push(['perf', {
        frames,
        scriptMs: Math.round(script),
        taskMs: Math.round(task),
        perFrameScript: frames ? +(script / frames).toFixed(2) : null,
        perFrameTask: frames ? +(task / frames).toFixed(2) : null
      }]);
    }
    else throw new Error('unknown step: ' + step);
  } catch (e) {
    errors.push(String(e.message ?? e));
  }
  await sleep(Number(process.env.STEP_DELAY ?? 820));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(JSON.stringify({ out, errors, logs, traced }, null, 2));
ws.close();
