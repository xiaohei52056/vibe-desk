-- 一次性建库脚本：mysql -uroot -p < init-db.sql
-- 字符集必须 utf8mb4：笔记里有表情、中文引号和代码
CREATE DATABASE IF NOT EXISTS vibedesk
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;
