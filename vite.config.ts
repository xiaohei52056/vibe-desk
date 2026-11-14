import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * 本地 Java 执行器（仅 dev server）。
 *
 * 为什么存在：浏览器里没有能用的 JVM；公共在线执行器也不可靠 ——
 * Piston 公共 API 2026-02 起改为白名单制，paiza.io 不带 CORS 头。
 * 而 javaWeb 机器上本来就有 JDK，所以直接把 javac/java 挂在 dev server
 * 后面：真实工具链、零网络、零第三方，报错就是本机 JDK 的原生报错。
 *
 * 契约：
 *   GET  /api/exec/ping  → { ok, javac }（javac 是否可用 + 版本串）
 *   POST /api/exec/java  ← { code }（完整 Java 源码，含 Main 类）
 *                        → { compileStderr?, compileExit? }
 *                          | { stdout, stderr, exitCode, killed }
 *
 * 诊断信息强制英文（-J-Duser.language=en），避免中文 Windows 的 GBK 乱码；
 * 输出强制 UTF-8。每次请求一个独立临时目录，跑完即删。
 */
function javaExec(): Plugin {
  const run = (cmd: string, args: string[], cwd: string, timeout: number, stdin?: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean }>(res => {
      const p = spawn(cmd, args, { cwd, timeout, windowsHide: true });
      let out = '';
      let err = '';
      p.stdout?.on('data', d => { out += String(d); });
      p.stderr?.on('data', d => { err += String(d); });
      // stdin 必须显式关闭：开着的话 Scanner 会一直等下去，直到超时被杀
      if (p.stdin) {
        if (stdin) p.stdin.write(stdin.endsWith('\n') ? stdin : stdin + '\n');
        p.stdin.end();
      }
      p.on('error', () => res({ code: null, stdout: out, stderr: err, killed: true }));
      p.on('close', (code, signal) => res({ code, stdout: out, stderr: err, killed: signal === 'SIGTERM' }));
    });

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((res, rej) => {
      let s = '';
      req.on('data', d => { s += String(d); if (s.length > 512 * 1024) { rej(new Error('body too large')); req.destroy(); } });
      req.on('end', () => res(s));
      req.on('error', rej);
    });

  const json = (res: ServerResponse, v: unknown): void => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(v));
  };

  return {
    name: 'vibe-java-exec',
    apply: 'serve',
    configureServer(server) {
      let javacOk: boolean | null = null;
      const probe = async (): Promise<boolean> => {
        if (javacOk !== null) return javacOk;
        const r = await run('javac', ['-version'], tmpdir(), 5000);
        javacOk = r.code === 0;
        return javacOk;
      };

      server.middlewares.use('/api/exec/ping', (_req, res) => {
        void probe().then(ok => {
          void run('javac', ['-version'], tmpdir(), 5000).then(r => {
            json(res, { ok, javac: ((r.stdout || r.stderr) || '').trim() });
          });
        });
      });

      server.middlewares.use('/api/exec/java', (req, res) => {
        void readBody(req).then(async body => {
          let code = '';
          let stdin = '';
          try {
            const d = JSON.parse(body) as { code?: string; stdin?: string };
            code = d.code ?? '';
            stdin = d.stdin ?? '';
          } catch { /* 坏请求按空处理 */ }
          if (!code.trim()) { json(res, { error: 'empty' }); return; }
          if (!(await probe())) { json(res, { error: 'no-jdk' }); return; }

          const dir = mkdtempSync(join(tmpdir(), 'vibe-java-'));
          try {
            writeFileSync(join(dir, 'Main.java'), code, 'utf8');
            const comp = await run('javac', ['-J-Duser.language=en', '-encoding', 'UTF-8', 'Main.java'], dir, 10000);
            if (comp.code !== 0) {
              json(res, { compileStderr: comp.stderr || comp.stdout || '编译失败', compileExit: comp.code });
              return;
            }
            const r = await run('java', ['-Duser.language=en', '-Dfile.encoding=UTF-8',
              '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-cp', '.', 'Main'], dir, 8000, stdin);
            json(res, { stdout: r.stdout, stderr: r.stderr, exitCode: r.code, killed: r.killed });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }).catch(() => { json(res, { error: 'bad-request' }); });
      });
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [javaExec()],
  server: {
    proxy: {
      // 后端业务接口 → Spring Boot（backend/，默认 8080）。
      // /api/exec/* 不会走到这里：javaExec 中间件在内部中间件（含代理）之前注册。
      '/api': { target: 'http://localhost:8080', changeOrigin: true }
    }
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        // 主应用：零 three 依赖，保持 11.8 KB
        main: resolve(__dirname, 'index.html'),
        // 实验台独立入口：three 只进这个 chunk，不会污染主包
        lab: resolve(__dirname, 'core3d-lab.html')
      }
    }
  }
});
