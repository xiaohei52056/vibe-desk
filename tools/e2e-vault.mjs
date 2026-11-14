/**
 * 临时 E2E：星云蛛 → 学习资料库
 *   1. 银河层点击星云蛛 → 面板打开；缺省仓库（study-vault）时显示友好引导
 *   2. ⚙ 设置里切到公开的 xiaohei52056/vibe-desk → 文件树加载（96 blobs）
 *   3. 目录导航 / 全库搜索 / md 预览渲染 / Esc 关闭 / 面板点击不算空白
 * 用法：先起 CDP Chrome（9222），node tools/e2e-vault.mjs
 */
const PORT = process.env.CDP_PORT ?? '9222';
const URL = 'http://localhost:5173/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push(d.text + ' ' + (d.exception?.description ?? ''));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console.error: ' + (m.params.args || []).map(x => x.value ?? x.description ?? '').join(' '));
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
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mousePressed' ? 1 : 0
});
const center = async (selector) => {
  const p = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return null; const r=el.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  if (!p) throw new Error('not found: ' + selector);
  return p;
};
const click = async (selector) => {
  const p = await center(selector);
  await mouse('mouseMoved', p.x, p.y);
  await mouse('mousePressed', p.x, p.y);
  await mouse('mouseReleased', p.x, p.y);
};
const key = async (name, code, kc) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' · ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: URL });
await sleep(2600);

// 上次会话可能停在学习星系里：先一路 Esc 退回银河层
for (let i = 0; i < 6; i++) {
  const atGalaxy = await evaluate(`!!document.querySelector('.entity[data-id="study"]')`);
  if (atGalaxy) break;
  await key('Escape', 'Escape', 27);
  await sleep(900);
}
await sleep(600);

// ---- 1. 点击星云蛛 → 面板打开 + 缺省仓库引导 ----
await click('.entity[data-id="spider"]');
await sleep(2500);
let s = await evaluate(`({
  open: !document.getElementById('vault-panel')?.hidden,
  title: document.querySelector('.vp-title')?.textContent ?? '',
  guide: document.querySelector('.vp-empty')?.textContent?.slice(0, 60) ?? '',
  foot: document.querySelector('.vp-foot')?.textContent ?? ''
})`);
check('V1 点击星云蛛打开资料库面板', s.open && s.title === '学习资料库', `title=${s.title}`);
check('V2 仓库不存在时给出三步引导', s.guide.includes('三步接上'), s.guide.slice(0, 30));
check('V3 底栏显示缺省仓库名', s.foot.includes('study-vault'), s.foot.slice(0, 50));

// ---- 2. 设置切到公开的 vibe-desk 仓库 ----
await click('.vp-tools button[title="关联到别的仓库"]');
await sleep(400);
s = await evaluate(`({
  form: !!document.querySelector('.vp-form'),
  repoVal: document.querySelector('.vp-field input')?.value ?? ''
})`);
check('V4 打开设置表单且预填当前仓库', s.form && s.repoVal.includes('study-vault'), s.repoVal);
await evaluate(`(()=>{
  const [repoIn, brIn] = document.querySelectorAll('.vp-field input');
  repoIn.value = 'xiaohei52056/vibe-desk';
  brIn.value = 'main';
  document.querySelector('.vp-save').click();
})()`);
await sleep(3500);
s = await evaluate(`({
  rows: document.querySelectorAll('.vp-row').length,
  foot: document.querySelector('.vp-foot')?.textContent ?? '',
  crumb: document.querySelector('.vp-crumb')?.textContent ?? ''
})`);
check('V5 文件树拉取成功并列出根目录', s.rows > 5, `rows=${s.rows} foot=${s.foot.slice(0, 44)}`);
s = await evaluate(`document.querySelector('.entity[data-id="spider"] .cap small')?.textContent ?? ''`);
check('V6 星云蛛副标更新为文件数', /96 个文件/.test(s), s);

// ---- 3. 目录导航 ----
const srcDir = await evaluate(`(()=>{
  const row = [...document.querySelectorAll('.vp-row')].find(r => r.querySelector('.vp-name')?.textContent === 'src/');
  if (!row) return null;
  row.click();
  return row.querySelector('.vp-meta')?.textContent ?? '';
})()`);
await sleep(500);
s = await evaluate(`({
  crumb: document.querySelector('.vp-crumb')?.textContent ?? '',
  rows: document.querySelectorAll('.vp-row').length
})`);
check('V7 进入 src/ 子目录', s.crumb.includes('src') && s.rows > 0, `crumb=${s.crumb} rows=${s.rows}`);

// ---- 回到根目录，再做全库搜索与 md 预览 ----
await click('.vp-crumb-item');
await sleep(500);

// ---- 4. 全库搜索 ----
await evaluate(`(()=>{
  const input = document.querySelector('.vp-search');
  input.value = 'vault';
  input.dispatchEvent(new Event('input'));
})()`);
await sleep(500);
s = await evaluate(`document.querySelectorAll('.vp-row').length`);
check('V8 搜索 vault 命中本文件', s >= 1, `rows=${s}`);
await evaluate(`(()=>{
  const input = document.querySelector('.vp-search');
  input.value = '';
  input.dispatchEvent(new Event('input'));
})()`);
await sleep(400);

// ---- 5. md 预览（根目录的 README.md）----
const mdOpened = await evaluate(`(async()=>{
  const row = [...document.querySelectorAll('.vp-row')].find(r => /\.md$/.test(r.querySelector('.vp-name')?.textContent ?? ''));
  if (!row) return { found: false };
  row.click();
  await new Promise(r => setTimeout(r, 2200));
  const art = document.querySelector('.vp-md');
  return { found: true, has: !!art, h: art?.querySelector('h1,h2,h3,h4,h5')?.textContent ?? '',
           p: art?.querySelectorAll('p').length ?? 0 };
})()`);
check('V9 md 文件应用内渲染成文章', mdOpened.found && mdOpened.has && (mdOpened.p > 0 || mdOpened.h),
  mdOpened.found ? `p=${mdOpened.p} h=${mdOpened.h?.slice(0, 20) ?? ''}` : 'no .md in root');

// 返回浏览态（点击面包屑「学习资料」）
await click('.vp-crumb-item');
await sleep(400);
s = await evaluate(`document.querySelectorAll('.vp-row').length`);
check('V10 面包屑回到浏览态', s > 0, `rows=${s}`);

// ---- 6. 面板点击不算点空白 + Esc 关闭 ----
await click('.vp-search');
await sleep(300);
s = await evaluate(`!document.getElementById('vault-panel')?.hidden`);
check('V11 点面板内部不触发收起', s === true);
await key('Escape', 'Escape', 27);
await sleep(400);
s = await evaluate(`document.getElementById('vault-panel')?.hidden ?? true`);
check('V12 Esc 关闭面板', s === true);

// ---- 7. 恢复缺省仓库配置，避免把测试仓库留在 meta 表 ----
await evaluate(`(async()=>{
  await fetch('http://localhost:8080/api/meta/vault.cfg', {
    method: 'PUT', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ v: JSON.stringify({ repo: 'xiaohei52056/study-vault', branch: 'main' }) })
  });
  localStorage.setItem('vibedesk.vault.cfg', JSON.stringify({ repo: 'xiaohei52056/study-vault', branch: 'main' }));
  return true;
})()`);

check('全程零页面错误', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(results.join('\n'));
if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
ws.close();
