/**
 * 动效验收（附录 A5）：用真实鼠标键盘跑一遍三段转场，量时间，量抖动。
 *
 * 为什么不用截图判断：转场的问题几乎都是「时间不对」和「中途被打断之后状态脏了」，
 * 这两件事在静态图上都看不出来。这里改成记录 data-anim / data-frame 的变更时刻。
 *
 * 用法：node tools/verify-motion.mjs <url>
 *   前置：一个开着 --remote-debugging-port 的 Chrome（CDP_PORT 默认 9222）
 */
const url = process.argv[2];
if (!url) {
  console.error('usage: node tools/verify-motion.mjs <url>');
  process.exit(1);
}
const PORT = process.env.CDP_PORT ?? '9222';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP endpoint not ready');
}

const ws = new WebSocket(await endpoint());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression);
  return r.result?.value;
};
const centerOf = async sel => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
  if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
const waitFor = async (sel, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evaluate(`!!document.querySelector(${JSON.stringify(sel)})`)) return true;
    await sleep(120);
  }
  return false;
};
const click = async sel => {
  if (!(await waitFor(sel))) throw new Error('not found: ' + sel);
  const p = await centerOf(sel);
  if (!p) throw new Error('not found: ' + sel);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
};
const KEY = { Tab: 9, Escape: 27, Enter: 13 };
const key = async name => {
  const code = KEY[name];
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    text: name === 'Tab' ? '\t' : name === 'Enter' ? '\r' : ''
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
};

const INSTRUMENT = `
window.__motion = [];
(() => {
  const el = document.getElementById('station');
  const push = (a, v) => window.__motion.push({ t: performance.now(), a, v, on: el.classList.contains('on') });
  new MutationObserver(list => {
    for (const m of list) {
      if (m.attributeName === 'class') push('on', el.classList.contains('on') ? '1' : '0');
      const n = m.attributeName || '';
      if (n === 'data-anim') push('anim', el.dataset.anim || '');
      if (n === 'data-frame') push('frame', el.dataset.frame || '');
      if (n === 'data-mode') push('mode', el.dataset.mode || '');
    }
  }).observe(el, { attributes: true, attributeFilter: ['class', 'data-anim', 'data-frame', 'data-mode'] });
})();
'set';
`;

/** 取一段动效的耗时：从 anim=名字 到 frame=3 */
function segment(marks, name) {
  const start = marks.find(m => m.a === 'anim' && m.v === name);
  if (!start) return null;
  const endMark = marks.find(m => m.a === 'frame' && m.v === '3' && m.t > start.t);
  if (!endMark) return null;
  return Math.round(endMark.t - start.t);
}

const results = [];
const record = (name, got, want, tol, extra = '') => {
  const ok = typeof got === 'number' && Math.abs(got - want) <= tol;
  results.push({ name, got, want, tol, ok, extra });
};

async function reset() {
  await send('Page.navigate', { url });
  await sleep(2000);
  await waitFor('.entity[data-id="n1"]');
  await evaluate(INSTRUMENT);
}

async function main() {
  await send('Page.enable');
  await send('Runtime.enable');

  // ── 1. 生长 600ms（跑三次取中位数：软件渲染下单次抖动能到 80ms） ──
  await reset();
  const grows = [];
  for (let i = 0; i < 3; i++) {
    await evaluate('window.__motion = []');
    await click('.entity[data-id="n1"]');
    await sleep(1000);
    const mk = JSON.parse(await evaluate('JSON.stringify(window.__motion)'));
    const d = segment(mk, 'grow');
    if (d !== null) grows.push(d);
    await key('Escape');
    await sleep(650);
  }
  grows.sort((a, b) => a - b);
  const median = grows.length ? grows[Math.floor(grows.length / 2)] : null;
  record('生长 GROW', median, 600, 45, '三次：' + grows.join(' / ') + ' ms');
  let marks = JSON.parse(await evaluate('JSON.stringify(window.__motion)'));
  // 上面每轮结束时都收了站，这里重新开一颗，供后面几项用
  await click('.entity[data-id="n1"]');
  await sleep(800);
  // transform-origin 算出来是 px：判断它是否偏向了恒星那一侧（n1 在框左侧）
  const og = await evaluate(`(()=>{const el=document.getElementById('station');const r=el.getBoundingClientRect();
    const o=getComputedStyle(el).transformOrigin.split(' ').map(parseFloat);
    return { ox:o[0], oy:o[1], w:r.width, h:r.height };})()`);
  const offCenter = Math.abs(og.ox - og.w / 2) > 24 || Math.abs(og.oy - og.h / 2) > 24;
  results.push({
    name: '生长原点', got: `${Math.round(og.ox)}px,${Math.round(og.oy)}px`, want: '偏向恒星一侧', tol: 0,
    ok: offCenter, extra: `框 ${Math.round(og.w)}×${Math.round(og.h)}，中心在 ${Math.round(og.w / 2)}px`
  });

  // ── 2/4. 切换与收回：各跑三次取中位数 ────────────────────────
  // 软件渲染下单次能抖 ±70ms，这不是代码问题，是测法问题；中位数才可判。
  const expands = [];
  const collapses = [];
  for (let i = 0; i < 3; i++) {
    await evaluate('window.__motion = []');
    await key('Tab');
    await sleep(760);
    let mk = JSON.parse(await evaluate('JSON.stringify(window.__motion)'));
    const e = segment(mk, 'expand');
    if (e !== null) expands.push(e);

    await evaluate('window.__motion = []');
    await key('Escape');
    await sleep(760);
    mk = JSON.parse(await evaluate('JSON.stringify(window.__motion)'));
    const c = segment(mk, 'collapse');
    if (c !== null) collapses.push(c);
  }
  const mid = a => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  record('切换 EXPAND', mid(expands), 400, 45, '三次：' + expands.join(' / ') + ' ms');
  record('收回 COLLAPSE', mid(collapses), 400, 45, '三次：' + collapses.join(' / ') + ' ms');

  // ── 3. 书写态：背景零运动 + 无亚像素抖动 ──────────────────────
  await key('Tab');
  await sleep(700);
  const still = await evaluate(`new Promise(res => {
    const el = document.getElementById('station');
    let mut = 0;
    const mo = new MutationObserver(list => { mut += list.length; });
    mo.observe(el, { attributes: true });
    const r0 = el.getBoundingClientRect();
    const tops = [];
    const iv = setInterval(() => tops.push(el.getBoundingClientRect().top), 70);
    setTimeout(() => {
      clearInterval(iv); mo.disconnect();
      res({ mut, jitter: Math.max(...tops) - Math.min(...tops), w: r0.width, h: r0.height });
    }, 780);
  })`);
  results.push({
    name: '书写态零抖动', got: `${still.jitter}px / ${still.mut} 次属性变更`, want: '0px', tol: 0,
    ok: still.jitter === 0 && still.mut === 0, extra: `${Math.round(still.w)}×${Math.round(still.h)}`
  });

  // ── 5. 逐层退出：书写 → 观看 → 星图 ─────────────────────────
  await evaluate('window.__motion = []');
  await key('Escape');
  await sleep(700);
  await key('Escape');
  await sleep(800);
  const afterClose = await evaluate(`({
    on: document.getElementById('station').classList.contains('on'),
    station: document.getElementById('hud-mode').textContent,
    cls: document.getElementById('stage').className
  })`);
  results.push({
    name: '收站回到星图', got: afterClose.station, want: '漂浮模式', tol: 0,
    ok: !afterClose.on && afterClose.station === '漂浮模式' && !afterClose.cls.includes('locked')
  });

  // ── 6. 中途打断：生长到一半按 Esc，反向时长应按「已走进度」缩短 ──
  await evaluate('window.__motion = []');
  await click('.entity[data-id="n1"]');
  await sleep(230);
  // 记下按键那一刻的页面时间：CDP 往返本身可能就有几十毫秒，
  // 用「我以为的 250ms」算进度会算错，得用页面自己的钟。
  const escAt = await evaluate('window.__escAt = performance.now(), window.__escAt');
  await key('Escape');
  await sleep(700);
  marks = JSON.parse(await evaluate('JSON.stringify(window.__motion)'));
  const growStart = marks.find(m => m.a === 'anim' && m.v === 'grow');
  const closeAnim = marks.filter(m => m.a === 'anim' && m.v === 'collapse');
  const wentOut = marks.find(m => m.a === 'on' && m.v === '0');
  const interruptMs = closeAnim.length && wentOut ? Math.round(wentOut.t - closeAnim[0].t) : null;
  const chosen = Number(await evaluate(`document.getElementById('station').dataset.reverse`));
  const realProgress = growStart ? Math.min(1, (escAt - growStart.t) / 600) : 1;
  const want = Math.max(140, Math.round(400 * realProgress));
  results.push({
    name: '中途打断反向', got: interruptMs === null ? 'null' : `${interruptMs}ms`, want: `≈${want}ms`, tol: 0,
    ok: interruptMs !== null && Math.abs(chosen - want) <= 40 && chosen < 400,
    extra: `按键时已生长 ${Math.round(realProgress * 100)}%，调度 ${chosen}ms（满程 400ms）`
  });

  // ── 7. Reduced Motion：直接落终帧 ───────────────────────────
  await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'reduce=1' });
  await sleep(2000);
  await waitFor('.entity[data-id="n1"]');
  await click('.entity[data-id="n1"]');
  await sleep(320);
  const rm = await evaluate(`({
    frame: document.getElementById('station').dataset.frame,
    view: document.getElementById('station').dataset.view,
    op: getComputedStyle(document.getElementById('station')).opacity,
    tr: document.getElementById('station').style.transition
  })`);
  results.push({
    name: 'Reduced Motion', got: `frame=${rm.frame} view=${rm.view}`, want: 'frame=3 view=1', tol: 0,
    ok: rm.frame === '3' && rm.view === '1' && Number(rm.op) > 0.95, extra: '320ms 内已到终帧'
  });

  // ── 8. 回到上次工位 ─────────────────────────────────────────
  await reset();
  await click('.entity[data-id="n1"]');
  await sleep(900);
  await key('Tab');
  await sleep(700);
  await key('Escape');          // 回观看态
  await sleep(600);
  await key('Escape');          // 收站
  await sleep(700);
  await click('.entity[data-id="n1"]');
  await sleep(1500);
  const resumed = await evaluate(`document.getElementById('station').dataset.mode`);
  results.push({
    name: '重开回到上次工位', got: resumed, want: 'write', tol: 0, ok: resumed === 'write',
    extra: '在书写态收站后重开同一颗，应回到书写态'
  });
}

try {
  await main();
} catch (e) {
  results.push({ name: '运行异常', got: String(e.message ?? e), want: '-', tol: 0, ok: false });
}

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log('');
console.log(pad('项目', 20) + pad('实测', 24) + pad('目标', 14) + '结果');
console.log('-'.repeat(72));
for (const r of results) {
  console.log(pad(r.name, 20) + pad(r.got, 24) + pad(r.want, 14) + (r.ok ? 'PASS' : 'FAIL'));
  if (r.extra) console.log(pad('', 20) + '  ' + r.extra);
}
const failed = results.filter(r => !r.ok).length;
console.log('-'.repeat(72));
console.log(failed ? `${failed} 项未通过` : '全部通过');
ws.close();
process.exit(failed ? 1 : 0);
