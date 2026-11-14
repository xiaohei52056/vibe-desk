const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const p = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && p.has(m.id)) { const { resolve } = p.get(m.id); p.delete(m.id); resolve(m.result); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const a = (m.params.args || []).map(x => x.value ?? x.description ?? x.type).join(' ');
    logs.push(m.params.type + ': ' + a);
  }
};
const send = (method, params = {}) => new Promise(resolve => { const mid = ++id; p.set(mid, { resolve }); ws.send(JSON.stringify({ id: mid, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.value ?? r.exceptionDetails; };

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:5173/' });
await sleep(4000);

const out = await ev(`(async()=>{
  const db = await new Promise(r=>{const q=indexedDB.open('vibedesk');q.onsuccess=()=>r(q.result)});
  const store = (name) => new Promise(r=>{const req=db.transaction(name).objectStore(name).getAll();req.onsuccess=()=>r(req.result)});
  const links = await store('links');
  const meta = await store('meta');
  const keys = links.map(l=>l.key ?? (l.a+'~'+l.b));
  return {
    count: keys.length,
    revived: ['n1~n3','n1~n5','n1~n6','n3~n4','n1~n17'].filter(k=>keys.includes(k)),
    metaFlag: meta.find(m=>m.k==='vibedesk.tiesMigrated')?.v ?? null,
    metaTombs: meta.find(m=>m.k==='vibedesk.tieTombstones')?.v ?? null
  };
})()`);
console.log('STATE:', JSON.stringify(out, null, 1));
console.log('LOGS:');
for (const l of logs) if (!l.startsWith('debug')) console.log('  ' + l.slice(0, 120));
ws.close();
process.exit(0);
