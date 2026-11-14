package com.vibedesk.seed;

import com.vibedesk.entity.DecisionRecord;
import com.vibedesk.entity.Note;
import com.vibedesk.entity.NoteLink;
import com.vibedesk.entity.ReviewCard;
import com.vibedesk.entity.SiteEntity;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 完整种子数据：项目设计原则 + JavaWeb / Python 学习笔记 + 真实决策。
 *
 * 前七篇与前端 IndexedDB 的种子七星一一对应（id 不变 —— 坐标契约），
 * n7 补上了正文；n8 之后是学习与工程场景的扩充。
 * 空库时由 SeedRunner 落库，已有数据永不覆盖。
 */
@Component
public class SeedData {

    private static final long DAY = 86400000L;

    public record SeedBundle(List<Note> notes, List<NoteLink> links,
                             List<ReviewCard> review, List<DecisionRecord> decisions,
                             List<SiteEntity> entities) {
    }

    public SeedBundle build() {
        long t = System.currentTimeMillis();

        /* ---------------- 笔记 18 篇 ---------------- */
        List<Note> notes = new ArrayList<>();

        // —— 设计原则七星（与前端种子同 id）——
        notes.add(note("n1", "论空间记忆与目录", t - 9 * DAY, t - 3 * DAY, """
                记忆宫殿之所以有效，靠的是 **坐标绝对稳定**。

                一个会自己重排的星系，恰好把地基拆了。所以实体坐标永久化，公转只作用于装饰粒子。

                相关：[[坐标冻结契约]]、[[双链与块引用]]、[[Hebbian 联想衰减]]

                #空间记忆 #坐标冻结"""));

        notes.add(note("n2", "坐标冻结契约", t - 14 * DAY, t - 6 * DAY, """
                实体 `spacePos` 一经分配即永久化，公转只作用于装饰粒子。

                亮度只在 ±15% 内波动，**可见度下限 0.6**；旧笔记永不降到不可见。

                > 你最需要找回的，往往正是最久没动的那一个。

                参见 [[论空间记忆与目录]]

                #坐标冻结 #检索"""));

        notes.add(note("n3", "双链与块引用", t - 21 * DAY, t - 11 * DAY, """
                `[[笔记名]]` 是基础双链，`[[笔记名#^block-id]]` 是块级引用。

                每个 Block 有稳定 `blockId`，重构笔记不会打断引用。

                #双链 #块引用"""));

        notes.add(note("n4", "Hebbian 联想衰减", t - 7 * DAY, t - 2 * DAY, """
                一条链接每次被「走过」，权重 +1；长时间不走按天衰减。

                权重**只映射到光丝粗细**，不改坐标、不改大小、不改可见度。

                参见 [[双链与块引用]]

                #联想 #光丝"""));

        notes.add(note("n5", "光学景深笔记", t - 18 * DAY, t - 8 * DAY, """
                景深靠尺度、虚化、遮挡与亮度衰减表达，不靠 Bloom 与发光描边。

                书写态背景零运动，正文对比度 ≥ 7:1。

                #视觉 #景深"""));

        notes.add(note("n6", "反看板宣言", t - 30 * DAY, t - 12 * DAY, """
                > 看板是仪表盘前的人，工作台是星系里的人。

                首页不出现指标数字、完成率、实时图表；默认态呈现文字与代码，不是状态块。

                #反看板"""));

        // —— n7：前端种子里是「待写」，这里补上完整正文 ——
        notes.add(note("n7", "从笔记到复习队列", t - 4 * DAY, t - 1 * DAY, """
                复习队列不该是另一张列表 —— 它是星系自己长出来的东西。

                从你的句子里挖空出题（最多同时 3 处金色弧），答「还记得」间隔推后（1→3→7→×2，上限 45 天），答「忘了」退回 1 天。全部状态写在回看弧上，**不出现任何数字**：星星暗了，你就知道该回去了。

                > 间隔重复的对手不是遗忘，是打断。所以答题只要一下，答完就走。

                参见 [[Hebbian 联想衰减]]、[[反看板宣言]]

                #回看 #间隔重复"""));

        // —— 学习笔记（JavaWeb / Python / MySQL）——
        notes.add(note("n8", "Java 集合框架速记", t - 20 * DAY, t - 5 * DAY, """
                一张图记不全，就先记最常被问的三个。

                **HashMap**：数组 + 链表 + 红黑树。负载因子 0.75；链表长度过 8 且数组长度 ≥ 64 才树化；扩容翻倍，JDK 8 起尾插法，避免并发成环。

                ```java
                Map<String, Integer> count = new HashMap<>(16);
                for (String w : words) {
                    count.merge(w, 1, Integer::sum);   // 不用先 get 判空
                }
                ```

                **ArrayList**：默认容量 10，扩容 1.5 倍。**LinkedList**：双向链表，get(i) 会从近的一头开始走。

                相关：[[JVM 内存模型初学]]、[[MySQL 索引为什么用 B+ 树]]

                #Java #集合"""));

        notes.add(note("n9", "JVM 内存模型初学", t - 16 * DAY, t - 4 * DAY, """
                运行时数据区五块：**堆**（对象，GC 主战场）、**虚拟机栈**（栈帧、局部变量表）、**方法区**（JDK 8 起由元空间实现，存类元数据，在本地内存）、**程序计数器**、**本地方法栈**。

                ```java
                // OOM 演示：把堆上限调小跑一次
                List<byte[]> hold = new ArrayList<>();
                while (true) hold.add(new byte[1024 * 1024]); // Exception: Java heap space
                ```

                参数：`-Xms` 初始堆、`-Xmx` 最大堆、`-Xss` 栈深。对象优先在 Eden 出生，熬过 Minor GC 进 Survivor，年龄到 15 晋升老年代。

                参见 [[Java 集合框架速记]]、[[MySQL 索引为什么用 B+ 树]]

                #JVM #Java"""));

        notes.add(note("n10", "Spring Boot 启动流程", t - 13 * DAY, t - 3 * DAY, """
                三步：**new SpringApplication**（推断应用类型、加载 Initializer 与 Listener）→ **run**（准备 Environment、创建并刷新 ApplicationContext）→ **自动装配**。

                自动装配的入口是 `@EnableAutoConfiguration`：从 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 读候选清单，再按 `@ConditionalOnClass` 等条件过滤 —— 所以依赖里有 mysql-connector-j 就能配 DataSource。

                内嵌 Tomcat 在 refresh 的 `onRefresh()` 里被创建，`start()` 时绑定端口。

                相关：[[HTTP 与 REST 设计练习]]、[[vibe-desk 后端化决策]]

                #Spring #Java"""));

        notes.add(note("n11", "MySQL 索引为什么用 B+ 树", t - 15 * DAY, t - 2 * DAY, """
                候选者逐个排除：**哈希** 等值快但范围查询全表扫；**二叉/红黑树** 太高（百万行约 20 层 = 20 次磁盘 IO）；**B 树** 数据存在每个节点，扇出变小。

                B+ 树赢在两点：数据全在叶子，非叶子只存键，扇出大 —— 3 层大约容纳 2000 万行；叶子之间双向链表，范围扫描顺链走。

                ```sql
                EXPLAIN SELECT * FROM notes WHERE updated_at > 1700000000000;
                -- type=range  rows=...  key=idx_notes_updated
                ```

                参见 [[MySQL 8 实操笔记]]、[[JVM 内存模型初学]]

                #MySQL #索引"""));

        notes.add(note("n12", "MySQL 8 实操笔记", t - 12 * DAY, t - 2 * DAY, """
                环境就三件事：**utf8mb4**（utf8 是坑，最多 3 字节）、**默认隔离级别 REPEATABLE READ**（MVCC + 间隙锁防幻读）、**慢查询日志**先开再优化。

                EXPLAIN 看三列：type（至少 range，ALL 就是全表扫）、rows（估算扫描行数）、Extra（Using index 好，Using filesort 要警惕）。

                vibe-desk 的表都用 `BIGINT` 存毫秒时间戳 —— 范围扫描比 DATETIME 直接，前端零转换。

                参见 [[MySQL 索引为什么用 B+ 树]]、[[HTTP 与 REST 设计练习]]

                #MySQL"""));

        notes.add(note("n13", "HTTP 与 REST 设计练习", t - 10 * DAY, t - 1 * DAY, """
                幂等性记一张小表：GET / PUT / DELETE 幂等，POST 不幂等。幂等 ≠ 无副作用，是**重复执行结果不变** —— 网络重试全靠它兜底。

                vibe-desk 同步接口就是照这个设计的：

                ```text
                GET  /api/sync/bundle   → 全量数据（拉）
                POST /api/sync/bundle   → 全量替换（推，与导出导入同构）
                ```

                推是替换不是合并：合并需要解决「同 id 不同内容谁赢」，替换语义可预期，出了错有导出兜底。

                参见 [[Spring Boot 启动流程]]、[[vibe-desk 后端化决策]]、[[反看板宣言]]

                #HTTP #REST"""));

        notes.add(note("n14", "Python 装饰器笔记", t - 11 * DAY, t - 3 * DAY, """
                装饰器 = 接收函数返回函数的语法糖。先理解闭包：内层函数记住了外层的变量。

                ```python
                def timed(fn):
                    @wraps(fn)                # 不加会把函数名和 doc 一起换掉
                    def inner(*a, **kw):
                        t0 = time.perf_counter()
                        try:
                            return fn(*a, **kw)
                        finally:
                            print(f'{fn.__name__}: {time.perf_counter() - t0:.3f}s')
                    return inner

                @timed
                def work(n):
                    return sum(range(n))
                ```

                带参数的装饰器是三层：外面一层收参数，里面才是真正的装饰器。

                参见 [[Pyodide 在浏览器跑 Python]]

                #Python"""));

        notes.add(note("n15", "Pyodide 在浏览器跑 Python", t - 8 * DAY, t - 2 * DAY, """
                Pyodide 是编译成 WASM 的 CPython —— 不是模拟器，是真解释器跑在浏览器里。

                vibe-desk 的沙盒把它装在 Web Worker 里：`setStdout({batched})` 逐行回传 print；`input()` 用 `setStdin` 逐行喂（EOF 返回 null，脚本不会卡死）；死循环到 5 秒直接 `terminate()` 杀掉 Worker。

                ```python
                name = input('名字: ')      # 输入区里每行一条
                print(f'你好, {name}')
                ```

                首次加载约 3 秒（14MB 运行时已本地化到 public/pyodide，离线可用）。

                参见 [[Python 装饰器笔记]]、[[沙盒安全边界]]

                #Python #沙盒"""));

        notes.add(note("n16", "沙盒安全边界", t - 6 * DAY, t - 2 * DAY, """
                原则一句话：**用户代码永远不进主页面进程。**

                - Python 跑在专用 Worker：即使 `while True` 也只是烧掉那个 Worker，5 秒看门狗 terminate，主页面毫发无损；
                - Java 走本机 JDK：每次请求独立临时目录，javac 编译 + java 运行 8 秒超时，跑完即删；
                - 都能拿到原生报错，错误行号换算回用户代码可点回正文。

                为什么不用 eval？因为 eval 拿得到页面的一切：IndexedDB、localStorage、cookie。隔离的意义不是防自己，是防「顺手把学习工具变成事故现场」。

                参见 [[Pyodide 在浏览器跑 Python]]

                #安全 #沙盒"""));

        // —— 项目与部署 ——
        notes.add(note("n17", "星河回忆相册部署记录", t - 22 * DAY, t - 6 * DAY, """
                另一个把星空当界面的项目：**星河回忆**，3D 相册，已部署在服务器 `http://8.148.6.228:8082/mem/`。

                与 vibe-desk 同一套审美：金色星核、纸面暖墨、动效可中断。区别在于它是**纯前端静态部署** —— 照片直接打进 bundle，不需要后端；vibe-desk 的数据会随使用增长，所以补了 Spring Boot + MySQL。

                ![星核](asset:img-seed-star)

                部署记录：Tomcat 8082 端口，`/mem/` 路径，静态资源带 hash 文件名，Last-Modified 命中缓存。

                参见 [[论空间记忆与目录]]、[[反看板宣言]]

                #部署 #项目"""));

        notes.add(note("n18", "vibe-desk 后端化决策", t - 3 * DAY, t, """
                为什么给一个纯前端应用补后端：**数据只活在浏览器里是最大的实用风险** —— 清一次浏览数据，半年笔记全没；换台设备就什么都没有。

                选型：**Spring Boot 3 + MyBatis-Plus + MySQL 8**。理由：javaWeb 主栈，课程与生产同一种语言；六张表与前端 IndexedDB store 一一对应，`/api/sync/bundle` 与「导出 JSON」同构 —— 同步、备份、迁移是同一份文件。

                前端的种子七星、坐标冻结、反看板原则全部不动，后端只做「更结实的口袋」。

                参见 [[反看板宣言]]、[[论空间记忆与目录]]、[[HTTP 与 REST 设计练习]]

                #后端 #架构"""));

        /* ---------------- 双链 29 条 ---------------- */
        List<NoteLink> links = new ArrayList<>();
        // 原型七星关联（与前端种子一致）
        addLink(links, t - 4 * DAY, 2.2, "n1", "n2");
        addLink(links, t - 6 * DAY, 1.6, "n1", "n3");
        addLink(links, t - 3 * DAY, 1.9, "n1", "n4");
        addLink(links, t - 8 * DAY, 1.3, "n1", "n5");
        addLink(links, t - 12 * DAY, 1.1, "n1", "n6");
        addLink(links, t - 9 * DAY, .8, "n3", "n4");
        addLink(links, t - 5 * DAY, .8, "n4", "n6");
        addLink(links, t - 7 * DAY, .8, "n2", "n5");
        addLink(links, t - 2 * DAY, .7, "n5", "n7");
        addLink(links, t - 1 * DAY, .8, "n6", "n7");
        // 学习笔记网络
        addLink(links, t - 5 * DAY, 1.8, "n8", "n9");
        addLink(links, t - 4 * DAY, 1.4, "n9", "n11");
        addLink(links, t - 2 * DAY, 2.0, "n11", "n12");
        addLink(links, t - 3 * DAY, 1.6, "n10", "n13");
        addLink(links, t - 1 * DAY, 1.1, "n10", "n18");
        addLink(links, t, 1.7, "n13", "n18");
        addLink(links, t - 3 * DAY, 1.9, "n14", "n15");
        addLink(links, t - 2 * DAY, 2.1, "n15", "n16");
        addLink(links, t - 1 * DAY, 1.2, "n16", "n18");
        addLink(links, t - 6 * DAY, 1.5, "n1", "n17");
        addLink(links, t - 6 * DAY, 1.2, "n5", "n17");
        addLink(links, t - 6 * DAY, 1.0, "n6", "n17");
        addLink(links, t, 1.4, "n6", "n18");
        addLink(links, t - 1 * DAY, 1.3, "n1", "n18");
        addLink(links, t - 1 * DAY, .9, "n12", "n13");
        addLink(links, t - 2 * DAY, 1.0, "n15", "n18");
        addLink(links, t - 1 * DAY, 1.2, "n4", "n7");
        addLink(links, t - 2 * DAY, .9, "n2", "n7");
        addLink(links, t, .8, "n3", "n18");

        // 关系只认显式记录：把正文里写过的 [[双链]] 固化成线，
        // 这样首次启动的星图和老版本一致，但此后不再由正文自动长线。
        materializeBodyLinks(notes, links, t);

        // 项目星系的三条关系（原先由共享标签推导，现在同样固化为显式记录）
        addLink(links, t, 1.2, "p1", "p2");
        addLink(links, t, 1.0, "p1", "p3");
        addLink(links, t, 1.0, "p2", "p3");

        /* ---------------- 回看卡 7 张 ---------------- */
        List<ReviewCard> review = List.of(
                card("n1", t - 7 * DAY, 7),     // 到期
                card("n4", t - 4 * DAY, 3),     // 已过期 1 天
                card("n7", t - 1 * DAY, 3),     // 到期
                card("n11", t - 1 * DAY, 1),    // 到期
                card("n14", t - 3 * DAY, 7),    // 还有 4 天
                card("n16", t - 9 * DAY, 7),    // 已过期 2 天
                card("n18", t, 1)               // 明天
        );

        /* ---------------- 决策 8 条 ---------------- */
        List<DecisionRecord> decisions = List.of(
                decision("d1", "n4", t - 3 * DAY, "光丝粗细用什么编码？",
                        List.of("线性映射", "对数映射"), "对数映射",
                        "线性会把 4.65 和 6.0 都压到最粗，高段失去区分度"),
                decision("d2", "n1", t - 7 * DAY, "单文件原型要不要上 Three.js？",
                        List.of("上 Three.js", "CSS 3D 只给背景层"), "CSS 3D 只给背景层",
                        "实体与 UI 必须永远 2D 正对，长文可读性优先；真立体留给 P5 渲染选型"),
                decision("d3", "n16", t - 5 * DAY, "用户代码跑在 iframe 还是 Web Worker？",
                        List.of("iframe sandbox", "Web Worker"), "Web Worker",
                        "Worker 能 terminate 真正杀死循环；iframe 只能事后清理 DOM，进程还活着"),
                decision("d4", "n15", t - 2 * DAY, "Pyodide 运行时从哪里加载？",
                        List.of("CDN（jsDelivr / npmmirror）", "本地化到 public/pyodide"), "本地化",
                        "实测当前网络 jsDelivr 不可达、npmmirror 缺 python_stdlib.zip（451）；14MB 换确定性"),
                decision("d5", "n16", t - 2 * DAY, "Java 执行走什么链路？",
                        List.of("公共在线执行器（Piston / paiza）", "本机 JDK 经 dev server"), "本机 JDK",
                        "Piston 2026-02 起白名单制，paiza 无 CORS 头；本机 javac 零网络、报错原生"),
                decision("d6", "n18", t - 1 * DAY, "后端选型？",
                        List.of("Spring Boot 3 + MySQL 8", "Node.js + SQLite"), "Spring Boot 3 + MySQL 8",
                        "javaWeb 主栈，课程与生产同语言；MySQL 的 utf8mb4/事务/索引生态成熟；数据安全优先于轻量"),
                decision("d7", "n3", t - 10 * DAY, "双链解析放在渲染层还是存储层？",
                        List.of("渲染时解析 [[ ]]", "存储时预写 links 表"), "存储时预写",
                        "光丝权重需要持久化的图结构；渲染层解析每次重算，图会失忆"),
                decision("d8", "n13", t - 1 * DAY, "云同步用合并还是替换？",
                        List.of("合并（按 updatedAt 新者胜）", "替换（与导出导入同构）"), "替换",
                        "合并需要版本向量与冲突界面；替换语义可预期，且有本地导出兜底")
        );

        /* ---------------- 站点实体 4 条：纪念册光门 + 3 个真实 GitHub 项目 ---------------- */
        // 坐标不在库里：前端 coords.ts 的 gate / p1 / p2 / p3 仍是冻结契约，
        // 这里只提供名字、链接与卡片内容。
        List<SiteEntity> entities = List.of(
                siteEntity("gate", "gate", t, "星河回忆", "纪念册 · 站外入口 · 点击打开",
                        "http://8.148.6.228:8082/mem/",
                        "{\"note\":\"纪念册只是站外入口：台内只保留一颗恒定亮度的深空天体与站外链接，不存在第二份纪念内容。\"}"),
                siteEntity("p1", "project", t, "sweet-memory", "Vue · 恋爱纪念册",
                        "https://github.com/xiaohei52056/sweet-memory",
                        "{\"summary\":\"把两个人的时间放进一片星河的 3D 相册\",\"stack\":\"Vue 3 · Three.js\",\"tags\":[\"Web\",\"前端\",\"3D\",\"本地优先\"],\"goal\":\"把两个人的时间放进一片星河\",\"current\":\"3D 星河相册已上线，按时间轴翻看\",\"next\":\"补一段年度回望，再加一条时间轴\"}"),
                siteEntity("p2", "project", t, "my-blog", "Java · 个人博客",
                        "https://github.com/xiaohei52056/my-blog",
                        "{\"summary\":\"记录 Java Web 与学习笔记的个人博客\",\"stack\":\"Java · Spring Boot · MySQL\",\"tags\":[\"Web\",\"后端\",\"Java\",\"写作\"],\"goal\":\"写下来的才算想清楚\",\"current\":\"Java 后端 + 文章模块在跑\",\"next\":\"把本地优先的同步实践整理成一篇\"}"),
                siteEntity("p3", "project", t, "skill-evidence-lint", "Python · Skill 证据检查",
                        "https://github.com/xiaohei52056/skill-evidence-lint",
                        "{\"summary\":\"给 AI Skill 的可量化声明做本地证据检查\",\"stack\":\"Python · 静态分析\",\"tags\":[\"工具\",\"Python\",\"写作\",\"本地优先\"],\"goal\":\"让 Skill 的可量化声明都有证据链接\",\"current\":\"纯本地静态检查，不联网、不执行 Skill\",\"next\":\"覆盖更多声明类型与路径校验\"}")
        );

        return new SeedBundle(notes, links, review, decisions, entities);
    }

    /* ---------------- 工厂 ---------------- */

    private static SiteEntity siteEntity(String id, String kind, long at,
                                         String label, String sub, String url, String detail) {
        SiteEntity e = new SiteEntity();
        e.setId(id);
        e.setKind(kind);
        e.setLabel(label);
        e.setSub(sub);
        e.setUrl(url);
        e.setDetail(detail);
        e.setUpdatedAt(at);
        return e;
    }

    private static final Pattern WIKI_LINK = Pattern.compile("\\[\\[([^\\]|]+)(?:\\|[^\\]]+)?\\]\\]");

    /** 把正文里已存在的 [[双链]] 变成 links 表的显式记录（去重，不覆盖已有权重） */
    private static void materializeBodyLinks(List<Note> notes, List<NoteLink> links, long t) {
        Map<String, String> byTitle = new HashMap<>();
        for (Note n : notes) byTitle.put(n.getTitle(), n.getId());
        Set<String> seen = new HashSet<>();
        for (NoteLink l : links) seen.add(l.getLinkKey());
        for (Note n : notes) {
            Matcher m = WIKI_LINK.matcher(n.getBody() == null ? "" : n.getBody());
            while (m.find()) {
                String to = byTitle.get(m.group(1).trim());
                if (to == null || to.equals(n.getId())) continue;
                String x = n.getId().compareTo(to) < 0 ? n.getId() : to;
                String y = n.getId().compareTo(to) < 0 ? to : n.getId();
                String key = x + "~" + y;
                if (!seen.add(key)) continue;
                NoteLink l = new NoteLink();
                l.setLinkKey(key);
                l.setA(x);
                l.setB(y);
                l.setW(1.0);
                l.setLastWalkedAt(t);
                links.add(l);
            }
        }
    }

    private static Note note(String id, String title, long createdAt, long updatedAt, String body) {
        Note n = new Note();
        n.setId(id);
        n.setTitle(title);
        n.setBody(body.strip());
        n.setCreatedAt(createdAt);
        n.setUpdatedAt(updatedAt);
        return n;
    }

    private static void addLink(List<NoteLink> out, long walkedAt, double w, String x, String y) {
        String a = x.compareTo(y) < 0 ? x : y;
        String b = x.compareTo(y) < 0 ? y : x;
        NoteLink l = new NoteLink();
        l.setLinkKey(a + "~" + b);
        l.setA(a);
        l.setB(b);
        l.setW(w);
        l.setLastWalkedAt(walkedAt);
        out.add(l);
    }

    private static ReviewCard card(String noteId, long lastAt, int iv) {
        ReviewCard r = new ReviewCard();
        r.setNoteId(noteId);
        r.setLastAt(lastAt);
        r.setIv(iv);
        r.setDueAt(lastAt + iv * DAY);
        return r;
    }

    private static DecisionRecord decision(String id, String noteId, long at,
                                           String q, List<String> opts, String pick, String why) {
        DecisionRecord d = new DecisionRecord();
        d.setId(id);
        d.setNoteId(noteId);
        d.setQ(q);
        d.setOpts(opts);
        d.setPick(pick);
        d.setWhy(why);
        d.setAt(at);
        return d;
    }
}
