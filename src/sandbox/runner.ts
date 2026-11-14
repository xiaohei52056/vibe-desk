/**
 * 沙盒引擎（契约：只跑 Python 与 Java）。
 *
 * 两种语言、两条执行路径，形态刻意不同：
 *   · Python —— Pyodide（WASM CPython）跑在 Web Worker 里，完全本地：
 *     print 逐行回传，超时看门狗到点直接 terminate Worker（杀 Worker = 杀脚本，
 *     这是死循环唯一可靠的终止方式）。运行时文件在 public/pyodide/
 *     （npm run setup:py 从 node_modules 复制），首选取本地、完全离线；
 *     丢失时按 npmmirror → jsDelivr 逐级回退。
 *   · Java —— 浏览器里没有能用的 JVM，公共在线执行器也不可靠
 *     （Piston 公共 API 2026-02 起白名单制、paiza.io 不带 CORS 头）。
 *     所以 Java 走 dev server 上的本地执行器（vite.config.ts 的 javaExec 插件）：
 *     本机 javac + java，真实工具链、零网络。静态部署（vite preview / dist）
 *     下执行器不存在，会明确报错并提示用 npm run dev 启动。
 *     代码没有 public class Main 时自动包一层；编译错误 / 异常栈里的
 *     Main.java:N 行号换算回用户代码的行号，可点回正文。
 *
 * 对面板暴露的接口形态与旧 JS 引擎一致：SinkLine / DoneReason / RunHandle / runCode，
 * 只是 runCode 多了一个 lang 参数。
 */

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error';

export interface SinkLine {
  kind: 'out' | 'error' | 'meta';
  level?: ConsoleLevel;
  text: string;
  /** 用户代码里的行号（1 起）；缺省表示定位不到 */
  line?: number;
}

export type DoneReason = 'ok' | 'error' | 'timeout' | 'killed';

export interface RunOptions {
  onLine(line: SinkLine): void;
  /** 只回调一次。Python 的 worker 在 ok 之后仍活着，晚到的输出还会流进来 */
  onDone(reason: DoneReason, ms: number): void;
  /** 标准输入：Java 写入子进程 stdin，Python 喂给 input()。每行一条 */
  stdin?: string;
}

export interface RunHandle {
  kill(): void;
}

export type Lang = 'python' | 'java';

/** 围栏标记 → 引擎语言。js / ts 等一律不认 —— 这里只跑这两种 */
export function normalizeLang(raw: string | null | undefined): Lang | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'py' || s === 'python' || s === 'python3') return 'python';
  if (s === 'java') return 'java';
  return null;
}

/** 没有围栏标记时从代码内容猜。Java 特征先看 —— import 关键字两种语言都有 */
export function sniffLang(code: string): Lang | null {
  if (/System\.out\.print|public\s+(static\s+)?(void|class|\w)|\bclass\s+\w+\s*[{]|String\[\]\s*\w*args/.test(code)) return 'java';
  if (/\bdef\s+\w+\s*\(|\bprint\s*\(|^\s*import\s|\bif\s+__name__|f['"]/.test(code)) return 'python';
  return null;
}

export function runCode(code: string, lang: Lang, opts: RunOptions): RunHandle {
  return lang === 'python' ? runPython(code, opts) : runJava(code, opts);
}

/* ============================================================
   Python：Pyodide in Worker
   ============================================================ */

/**
 * Python 运行时源，按序尝试。
 * 首选 dev/build 自带的 public/pyodide（npm run setup:py 复制，完全离线）；
 * 远端源仅作文件丢失时的兜底 —— npmmirror 的文件服务缺 stdlib（451），
 * jsDelivr 在国内网络不可达，两者都不可依赖，只当备胎。
 */
function pyodideBases(): string[] {
  const local = new URL('pyodide/', document.baseURI).href;
  return [
    local,
    'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
    'https://registry.npmmirror.com/pyodide/0.26.4/files/'
  ];
}

/** 代码执行上限（不含引擎加载）：到点 terminate，死循环不留活口 */
const PYTHON_TIMEOUT = 5000;
/** 引擎加载上限（本地文件秒级就绪；远端兜底时覆盖弱网） */
const BOOT_TIMEOUT = 60000;

/**
 * Worker 源码。__TOKEN__ / __BASES__ 由父页面在创建时替换 ——
 * 引擎源码保持纯 JS，不依赖任何编译产物，也不用模板插值拼内容。
 */
const PY_WORKER_SRC = `
'use strict';
var TOKEN = __TOKEN__;
var BASES = __BASES__;
function send(kind, extra){
  var m = { __vd: TOKEN, kind: kind };
  if (extra) for (var k in extra) m[k] = extra[k];
  // Worker 里没有 parent（那是 iframe 的全局）；dedicated worker 的收件人固定是宿主。
  // 这里不能 try/catch 吞错 —— 发送失败必须可见，否则父页面只能等到看门狗超时。
  self.postMessage(m);
}
var pyodide = null;
var booting = null;
function boot(){
  if (booting) return booting;
  booting = new Promise(function(resolve, reject){
    var i = 0;
    function attempt(){
      if (i >= BASES.length) { reject(new Error('所有 Python 运行时源都不可达')); return; }
      var base = BASES[i++];
      try {
        importScripts(base + 'pyodide.js');
        loadPyodide({ indexURL: base }).then(function(p){
          pyodide = p;
          p.setStdout({ batched: function(s){ send('out', { level: 'log', text: s }); } });
          p.setStderr({ batched: function(s){ send('out', { level: 'error', text: s }); } });
          resolve();
        }).catch(function(e){
          send('out', { level: 'log', text: '[引擎] 初始化失败 #' + i + ': ' + e });
          if (i < BASES.length) attempt();
          else reject(new Error('Python 运行时初始化失败：' + e));
        });
      } catch (e) {
        send('out', { level: 'log', text: '[引擎] 脚本加载失败 #' + i + ': ' + e });
        if (i < BASES.length) attempt();
        else reject(new Error('Python 运行时脚本加载失败（所有源）'));
      }
    }
    attempt();
  });
  return booting;
}
self.onmessage = function(ev){
  var data = ev.data;
  if (!data || data.type !== 'run') return;
  var t0 = Date.now();
  var src = data.stdin == null ? '' : String(data.stdin).replace(/\\r\\n/g, '\\n');
  var lines = src.length ? src.split('\\n') : [];
  var idx = 0;
  boot().then(function(){
    // 每次运行重挂 stdin：返回 null = EOF，input() 会正常抛 EOFError 而不是卡死
    pyodide.setStdin({ stdin: function(){
      return idx < lines.length ? lines[idx++] + '\\n' : null;
    } });
    send('ready', { ms: Date.now() - t0 });
    return pyodide.runPythonAsync(data.code);
  }).then(function(){
    send('done', { reason: 'ok', ms: Date.now() - t0 });
  }).catch(function(e){
    var msg = (e && e.message) ? String(e.message) : String(e);
    send('pyerror', { text: msg, ms: Date.now() - t0 });
  });
};
`;

function runPython(code: string, opts: RunOptions): RunHandle {
  const token = 'vd' + Math.random().toString(36).slice(2);
  const src = PY_WORKER_SRC
    .replace('__TOKEN__', JSON.stringify(token))
    .replace('__BASES__', JSON.stringify(pyodideBases()));
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const worker = new Worker(url);
  let done = false;
  let bootTimer = 0;
  let execTimer = 0;

  const finish = (reason: DoneReason, ms: number): void => {
    if (done) return;
    done = true;
    clearTimeout(bootTimer);
    clearTimeout(execTimer);
    opts.onDone(reason, ms);
  };
  const kill = (): void => {
    clearTimeout(bootTimer);
    clearTimeout(execTimer);
    worker.terminate();
    URL.revokeObjectURL(url);
  };

  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data as Record<string, unknown> | null;
    if (!m || m['__vd'] !== token) return;
    switch (m['kind']) {
      case 'out':
        opts.onLine({ kind: 'out', level: (m['level'] as ConsoleLevel) ?? 'log', text: String(m['text'] ?? '') });
        break;
      case 'ready': {
        // 引擎加载完成才开始计时：首次下载不占 5s 执行配额
        clearTimeout(bootTimer);
        const bootMs = Number(m['ms']) || 0;
        if (bootMs > 800) opts.onLine({ kind: 'meta', text: `Python 引擎就绪 · ${(bootMs / 1000).toFixed(1)}s（首次较慢，之后有缓存）` });
        const t0 = Date.now();
        execTimer = window.setTimeout(() => finish('timeout', Date.now() - t0), PYTHON_TIMEOUT);
        break;
      }
      case 'pyerror': {
        for (const l of pythonErrorLines(String(m['text'] ?? ''))) opts.onLine(l);
        finish('error', Number(m['ms']) || 0);
        break;
      }
      case 'done':
        finish('ok', Number(m['ms']) || 0);
        break;
    }
  };
  worker.onerror = () => {
    opts.onLine({ kind: 'error', text: 'Python 引擎加载失败 · 首次使用需要联网下载运行时（约 10MB）' });
    finish('error', 0);
  };
  bootTimer = window.setTimeout(() => {
    opts.onLine({ kind: 'error', text: 'Python 引擎加载超时 · 检查网络后重试' });
    finish('error', 0);
  }, BOOT_TIMEOUT);

  worker.postMessage({ type: 'run', code, stdin: opts.stdin ?? '' });
  return { kill: () => { finish('killed', 0); kill(); } };
}

/** 拆 traceback：中间行不可点，最后一行带上行号可点回正文 */
function pythonErrorLines(text: string): SinkLine[] {
  const lines = text.replace(/\s+$/, '').split('\n');
  const out: SinkLine[] = lines.map(l => ({ kind: 'error', text: l }));
  let at = 0;
  for (const l of lines) {
    const m = /File "(?:<exec>|<string>)", line (\d+)/.exec(l) ?? /\bat\s+line\s+(\d+)/.exec(l) ?? /line (\d+)/.exec(l);
    if (m?.[1]) at = Number(m[1]);
  }
  if (at > 0 && out.length) {
    const last = out[out.length - 1]!;
    out[out.length - 1] = { ...last, line: at };
  }
  return out;
}

/* ============================================================
   Java：dev server 上的本地 JDK 执行器
   ============================================================ */

const EXEC_PING = '/api/exec/ping';
const EXEC_JAVA = '/api/exec/java';
/** 编译 + 运行，留足余量；看门狗到点 abort */
const JAVA_TIMEOUT = 20000;

interface ExecJavaResult {
  error?: string;
  compileStderr?: string;
  compileExit?: number | null;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  killed?: boolean;
}

/** 探测本地执行器：结果按会话缓存，不在每次运行前重复探 */
let helperOk: boolean | null = null;
async function pingHelper(): Promise<boolean> {
  if (helperOk !== null) return helperOk;
  const ac = new AbortController();
  const t = window.setTimeout(() => ac.abort(), 3000);
  try {
    const r = await fetch(EXEC_PING, { signal: ac.signal });
    const d = await r.json() as { ok?: boolean };
    helperOk = !!d.ok;
  } catch {
    helperOk = false;
  } finally {
    clearTimeout(t);
  }
  return helperOk;
}

/**
 * Java 快跑形态：粘贴一段语句就能跑。
 * 没有任何 class/interface/enum/record 时自动包进 Main.main，
 * 且把顶部连续的 import 行留在类外 —— 否则 `import x;` 落进方法体，
 * javac 会报 illegal start of expression（学生最常见的写法就是这个）。
 * 有类但类名不是 Main 时改名为 Main（执行器固定跑 java Main）。
 * offset = 包裹层在源文件里占用的行数，错误行号按它换算回用户代码。
 */
function wrapJava(code: string): { source: string; offset: number; note: string } {
  const trimmed = code.trim();
  if (!/\b(?:class|interface|enum|record)\s+\w+/.test(trimmed)) {
    // 顶部连续的 import / 空行作为「文件头」原样留在类外，其余进 main
    const lines = code.split('\n');
    let head = 0;
    while (head < lines.length) {
      const t = lines[head]!.trim();
      if (t === '' || /^import\s/.test(t)) { head++; continue; }
      break;
    }
    // 行尾不能丢掉最后一个 import 之后的空行归属；header 保持原行号，body 顺延 +2
    const header = lines.slice(0, head).join('\n');
    const body = lines.slice(head).join('\n');
    const indented = body.split('\n').map(l => '    ' + l).join('\n');
    const source =
      (header ? header + '\n' : '') +
      'public class Main {\n' +
      '    public static void main(String[] args) throws Exception {\n' +
      indented + '\n' +
      '    }\n' +
      '}';
    return { source, offset: 2, note: '已自动包进 public class Main · main 方法执行' };
  }
  const cls = /\b(?:public\s+)?class\s+(\w+)/.exec(trimmed)?.[1];
  if (cls && cls !== 'Main') {
    const source = trimmed.replace(/\bclass\s+(\w+)/, 'class Main');
    return { source, offset: 0, note: `类名 ${cls} 已改为 Main（执行器固定跑 java Main）` };
  }
  return { source: trimmed, offset: 0, note: '' };
}

/** javac 错误 / JVM 异常栈里的 Main.java:N 换算回用户行号 */
function javaErrorLines(text: string, offset: number): SinkLine[] {
  return text.replace(/\s+$/, '').split('\n').map(l => {
    const m = /Main\.java:(\d+)/.exec(l);
    if (!m?.[1]) return { kind: 'error', text: l };
    const n = Number(m[1]) - offset;
    return { kind: 'error', text: l, line: n >= 1 ? n : undefined };
  });
}

function runJava(code: string, opts: RunOptions): RunHandle {
  const ac = new AbortController();
  let done = false;
  let timer = 0;

  const finish = (reason: DoneReason, ms: number): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    opts.onDone(reason, ms);
  };
  timer = window.setTimeout(() => {
    ac.abort();
    opts.onLine({ kind: 'error', text: `执行超时（${JAVA_TIMEOUT / 1000}s）· 已终止` });
    finish('timeout', JAVA_TIMEOUT);
  }, JAVA_TIMEOUT);

  const { source, offset, note } = wrapJava(code);
  if (note) opts.onLine({ kind: 'meta', text: note });
  const t0 = Date.now();

  void (async () => {
    try {
      // 执行器只存在于 dev server：静态部署下这里会给出明确指引，而不是静默失败
      if (!(await pingHelper())) {
        opts.onLine({ kind: 'error', text: 'Java 走本机 JDK（javac + java）· 请用 npm run dev 启动应用，并确认 PATH 里有 JDK' });
        finish('error', Date.now() - t0);
        return;
      }
      const res = await fetch(EXEC_JAVA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: source, stdin: opts.stdin ?? '' }),
        signal: ac.signal
      });
      if (!res.ok) throw new Error(`本地执行器返回 ${res.status}`);
      const d = await res.json() as ExecJavaResult;
      const ms = Date.now() - t0;
      if (d.error) throw new Error(d.error === 'no-jdk' ? '本机没找到 JDK（javac）' : d.error);
      // 编译失败：javac 的 stderr 就是全部答案
      const cerr = (d.compileStderr ?? '').trim();
      if (cerr) {
        for (const l of javaErrorLines(cerr, offset)) opts.onLine(l);
        finish('error', ms);
        return;
      }
      const stdout = (d.stdout ?? '').replace(/\s+$/, '');
      if (stdout) for (const l of stdout.split('\n')) opts.onLine({ kind: 'out', level: 'log', text: l });
      const rerr = (d.stderr ?? '').trim();
      if (rerr) for (const l of javaErrorLines(rerr, offset)) opts.onLine(l);
      finish((d.exitCode ?? 1) === 0 && !rerr ? 'ok' : 'error', ms);
    } catch (err: unknown) {
      if (ac.signal.aborted) { finish('killed', Date.now() - t0); return; }
      opts.onLine({ kind: 'error', text: `Java 本地执行失败：${err instanceof Error ? err.message : String(err)}` });
      finish('error', Date.now() - t0);
    }
  })();

  return { kill: () => { ac.abort(); finish('killed', 0); } };
}
