-- VIBE DESK 表结构（可重复执行：全部 IF NOT EXISTS）
-- 库本身由 init-db.sql 创建

CREATE TABLE IF NOT EXISTS notes (
  id          VARCHAR(32)  NOT NULL COMMENT '笔记 id（前端坐标契约：id 一经分配永不变）',
  title       VARCHAR(255) NOT NULL COMMENT '标题',
  body        MEDIUMTEXT   NULL COMMENT '正文（Markdown，含 [[双链]] #标签 代码块）',
  created_at  BIGINT       NOT NULL COMMENT '创建时间（epoch 毫秒）',
  updated_at  BIGINT       NOT NULL COMMENT '更新时间（epoch 毫秒）',
  PRIMARY KEY (id),
  KEY idx_notes_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='笔记';

CREATE TABLE IF NOT EXISTS links (
  link_key       VARCHAR(80)  NOT NULL COMMENT '无向键：小的 id 在前，a~b',
  a              VARCHAR(32)  NOT NULL COMMENT '端点一',
  b              VARCHAR(32)  NOT NULL COMMENT '端点二',
  w              DOUBLE       NOT NULL DEFAULT 1 COMMENT 'Hebbian 权重：走过 +1，按天衰减',
  last_walked_at BIGINT       NOT NULL DEFAULT 0 COMMENT '最近一次走过的时间（epoch 毫秒）',
  PRIMARY KEY (link_key),
  KEY idx_links_a (a),
  KEY idx_links_b (b)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='双链（无向图）';

CREATE TABLE IF NOT EXISTS review (
  note_id VARCHAR(32) NOT NULL COMMENT '笔记 id（一篇一张复习卡）',
  due_at  BIGINT      NOT NULL COMMENT '到期时间（epoch 毫秒）',
  last_at BIGINT      NOT NULL DEFAULT 0 COMMENT '上次回看时间',
  iv      INT         NOT NULL DEFAULT 1 COMMENT '当前间隔（天）：1→3→7→×2，上限 45',
  PRIMARY KEY (note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='回看队列（间隔重复）';

CREATE TABLE IF NOT EXISTS decisions (
  id      VARCHAR(32)  NOT NULL COMMENT '决策 id',
  note_id VARCHAR(32)  NOT NULL COMMENT '挂在哪篇笔记上（脚注）',
  q       VARCHAR(500) NOT NULL COMMENT '问题',
  opts    TEXT         NULL COMMENT '选项（JSON 数组）',
  pick    VARCHAR(255) NULL COMMENT '选了哪个',
  why     TEXT         NULL COMMENT '理由',
  at      BIGINT       NOT NULL COMMENT '决策时间（epoch 毫秒）',
  PRIMARY KEY (id),
  KEY idx_decisions_note (note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='决策日志';

CREATE TABLE IF NOT EXISTS assets (
  id   VARCHAR(40) NOT NULL COMMENT '资源 id（img-xxxx）',
  mime VARCHAR(80) NOT NULL DEFAULT 'image/png' COMMENT 'MIME 类型',
  w    INT         NOT NULL DEFAULT 0 COMMENT '宽（像素）',
  h    INT         NOT NULL DEFAULT 0 COMMENT '高（像素）',
  at   BIGINT      NOT NULL COMMENT '入库时间（epoch 毫秒）',
  data LONGTEXT    NULL COMMENT '图片内容（base64，不带 data: 前缀）',
  PRIMARY KEY (id),
  KEY idx_assets_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='粘贴进笔记的图片资源';

CREATE TABLE IF NOT EXISTS meta (
  k VARCHAR(64)  NOT NULL COMMENT '键',
  v TEXT        NULL COMMENT '值（JSON）',
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='内部状态（迁移标记等，不参与同步）';

CREATE TABLE IF NOT EXISTS entities (
  id          VARCHAR(32)  NOT NULL COMMENT '实体 id（与前端 coords.ts 的冻结坐标一一对应）',
  kind        VARCHAR(16)  NOT NULL COMMENT 'gate / project / core / spider',
  label       VARCHAR(100) NOT NULL COMMENT '星图上的名字',
  sub         VARCHAR(200) NULL COMMENT '星图上的副标题',
  url         VARCHAR(500) NULL COMMENT '站外入口 / 仓库链接',
  detail      TEXT         NULL COMMENT '项目卡三字段或说明（JSON）',
  updated_at  BIGINT       NOT NULL COMMENT '更新时间（epoch 毫秒）',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='站点实体配置（光门与项目卡；坐标不在库里，仍由前端冻结）';
