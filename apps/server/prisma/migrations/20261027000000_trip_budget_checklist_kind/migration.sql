-- ============================================================================
-- 2026-10-27 · 行程预算 + 清单分类
-- ============================================================================
-- 需求来源（用户试用反馈）：
--   ③ 「花销里面没有记录预算的地方」
--      → trip.budget_minor：出行级预算（最小单位整数，与 expense.amount_base 同口径）
--   ③ 「行程里面的清单包括需要做的事项和需要带的东西的清单，是两回事」
--      → trip_checklist_item.kind：TODO（要做的事）/ PACK（要带的东西）
--
-- 两条都是**纯加法**（可空列 / 带默认值的非空列），对老数据与老客户端零影响：
--   · budget_minor = NULL  → 视为「未设预算」，花销页不显示进度条
--   · kind 默认 'PACK'     → 历史清单项全部归为「要带的东西」，正是它们的语义
-- ============================================================================

-- ① 出行预算
ALTER TABLE `trip`
  ADD COLUMN `budget_minor` BIGINT NULL;

-- ② 清单分类
ALTER TABLE `trip_checklist_item`
  ADD COLUMN `kind` VARCHAR(16) NOT NULL DEFAULT 'PACK';

-- ③ 按「行程 + 分类」取清单是最高频查询（清单页两个分区各查一次）
ALTER TABLE `trip_checklist_item`
  ADD INDEX `idx_tci_trip_kind` (`trip_id`, `kind`, `deleted_at`);
