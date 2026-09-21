-- ArkPlots 阅读记录的云端存储（Cloudflare D1）
--
-- 应用方式：
--   远程（生产）npx wrangler d1 execute arkplots-records --remote --file=scripts/d1-schema.sql
--   本地（开发）npx wrangler d1 execute arkplots-records --local  --file=scripts/d1-schema.sql
--
-- 只存「用户显式标记过的」章节；未标记的章节由前端按 Plotline.json 补齐为「未读」，
-- 因此新增剧情不需要写迁移，也不需要重新写一遍这张表。

CREATE TABLE IF NOT EXISTS records (
  plot_id TEXT PRIMARY KEY,
  status  TEXT NOT NULL
);
