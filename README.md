# VIBE-DESK · 星系式个人知识工作台

笔记不是列表和看板，而是漂浮在银河里的恒星。

**前端**：Vite + TypeScript + Three.js（星图氛围层）+ CodeMirror 6（编辑器），纯前端、数据存浏览器 IndexedDB。
**后端**：Spring Boot 3 + MyBatis-Plus + MySQL 8（`backend/`），提供全量同步接口，数据不再只活在浏览器里。

## 功能

- **3D 星图**：银河层 / 学习星系 / 代码星系三层；恒星 = 笔记，光丝 = 双链，金色弧 = 待回看
- **书写**：`[[双链]]`、`#标签`、代码块、截图直接粘贴；停笔自动保存，撤销历史跨会话
- **回看**：从你的句子里挖空出题，间隔重复（1→3→7→×2，上限 45 天），无任何数字
- **决策日志**：`Ctrl+D` 记录「问题 / 选项 / 选了谁 / 理由」，只做脚注不做列表页
- **代码沙盒**：只跑 Python / Java。Python 走 Pyodide（本地运行时，离线可用）；Java 走本机 JDK（dev server 内置执行器）；死循环 5 秒强杀；支持标准输入
- **搜索**：`/` 命令面板，标题 / 正文 / 标签 / 决策全索引
- **数据**：一份 JSON 导出 / 导入（含图片）；云端拉取 / 推送（走后端）

## 启动

### 前端

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # 构建到 dist/
npm run setup:py     # （可选）重新复制 Pyodide 运行时到 public/pyodide/
```

### 后端（Spring Boot + MySQL 8）

```bash
# 1. 建库（一次性）
mysql -uroot -p < backend/src/main/resources/init-db.sql

# 2. 改 backend/src/main/resources/application.yml 里的数据库密码

# 3. 启动（空库会自动落 18 篇种子笔记 + 链接 + 决策 + 图片）
cd backend
mvn spring-boot:run          # http://localhost:8080
```

前端 dev server 已配置 `/api` 代理到 `http://localhost:8080`；命令面板（`Ctrl+K` 或 `/`）里
「云端拉取 / 云端推送」即可完成同步。同步与「导出全部数据」是同一份数据格式：

```text
GET  /api/sync/bundle   全量数据（拉）
POST /api/sync/bundle   全量替换（推）
```

### 完整接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PUT/DELETE | `/api/notes` | 笔记 CRUD |
| GET/PUT/DELETE | `/api/links` | 双链（无向图，key = a~b） |
| GET/PUT/DELETE | `/api/review` | 回看卡（一篇一张） |
| GET/POST/PUT/DELETE | `/api/decisions` | 决策日志（支持 by-note 查询） |
| GET/POST/DELETE | `/api/assets` | 图片资源（列表不含 base64，取单张给全量） |
| GET/PUT/DELETE | `/api/meta/{k}` | 内部状态 KV |
| GET/POST | `/api/sync/bundle` | 全量同步（拉 / 替换式推） |
| GET | `/api/health` | 健康检查 + 数据量 |

## 设计原则

1. **反看板** —— 首页不出现指标数字、完成率；默认态是文字与代码，不是状态块
2. **坐标冻结** —— 笔记 id 与空间位置一经分配永不变，检索靠空间记忆而非排序
3. **3D 只做氛围** —— 正文对比度 ≥ 7:1，书写态背景零运动

## 已知边界

- Java 沙盒需要 `npm run dev`（执行器挂在 dev server 上），静态构建版里 Python 照常可用
- 云端同步是**替换式**（与文件导入一致）：拉取覆盖本地、推送覆盖云端，覆盖前建议先导出留档
