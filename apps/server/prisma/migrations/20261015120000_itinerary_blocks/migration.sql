-- ============================================================================
-- D-2026-10-15-01 · 迁移：itinerary_item 增加正文块列（blocks_json）
-- 对象：family-trip（MySQL 8.4.3）
--
-- 背景（用户反馈驱动）：
--   安排卡片要能内嵌图片/富文本（参考 2026-10-14 行程截图混排形态）。
--   前端契约已冻结（apps/client/src/api/types.ts 的 ItineraryBlock），
--   本迁移为其提供持久化列。
--
-- 口径（派发单 §1.1，勿自行发挥）：
--   1) blocks_json 允许 NULL：历史行留空即「无正文块」，前端按 note 兜底渲染，
--      不需要回填脚本。
--   2) 用 TEXT 而非 JSON 列：与既有 trip.destinations_json 同构，
--      避免引入 Prisma 对 MySQL JSON 类型的额外差异面。
--   3) 不新增索引：正文块只随安排行整体读写，从不做块级查询。
--   4) date / start_time / end_time 等既有死列保持不动（纯加法迁移）。
--
-- 性质：纯加法 —— 仅 ADD COLUMN，不改不删既有列；无需数据回填。
-- 应用：prisma migrate deploy（或 dev）
-- ============================================================================

-- AlterTable
ALTER TABLE `itinerary_item`
    ADD COLUMN `blocks_json` TEXT NULL COMMENT 'D-2026-10-15-01：安排正文块（富文本/图片 JSON 数组；NULL = 老数据只有 note）' AFTER `note`;
