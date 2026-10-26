-- ============================================================================
-- D-2026-10-26-01 · 迁移：checklist_template 增加乐观锁版本号（P0-1 前置）
-- 对象：family-trip（MySQL 8.4.3）
--
-- 背景：
--   「长期清单」要能改条目 / 改名（PATCH /checklists/templates/:id），
--   家庭里两个人同时维护一套清单是常态。没有 CAS 就是**静默覆盖**：
--   A 加了「溯溪鞋」，B 加「登山杖」，后写者把前者的条目整体冲掉且无人察觉。
--   前端契约已按最终形态写好（apps/client/src/api/http.ts 的
--   updateChecklistTemplate 必传 version），本迁移提供持久化列。
--
-- 口径（派发单 §P0-1，勿自行发挥）：
--   1) version 默认 0 且 NOT NULL —— 与 trip.version / trip_checklist_item.version
--      同口径；存量行自动为 0，无需回填脚本。
--   2) 列名即 `version`（与既有 CAS 表一致，便于跨域统一读法）。
--   3) 不新增索引：version 只在 `UPDATE ... WHERE id = ? AND version = ?`
--      里作为过滤条件，主键已覆盖，单独建索引无收益。
--   4) delete_at 视图口径不变：软删感知查询依赖 (family_id/owner_id, deleted_at)
--      两个既有索引，本迁移不触碰。
--
-- 性质：纯加法 —— 仅 ADD COLUMN；不改不删既有列，无需数据回填。
-- 应用：prisma migrate deploy（或 dev）
-- ============================================================================

-- AlterTable
ALTER TABLE `checklist_template`
    ADD COLUMN `version` INTEGER NOT NULL DEFAULT 0 COMMENT 'D-2026-10-26-01：改模板 CAS 乐观锁版本号' AFTER `items_json`;
