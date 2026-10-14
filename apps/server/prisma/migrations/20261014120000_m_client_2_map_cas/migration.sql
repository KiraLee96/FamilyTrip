-- ============================================================================
-- M-Client-2 · 迁移：行程地图选点字段 + 两处契约漂移补齐
-- 对象：family-trip（MySQL 8.4.3）
--
-- 背景（小程序测试反馈驱动）：
--   1) 「行程页要加地图控件 / 交通方式」→ 需持久化坐标与出行方式。
--   2) 契约漂移：itinerary.service.create/update 早已读写
--      start_at / end_at / amount / currency / amount_base / version，
--      item.service 早已读写 version，但 schema.prisma 与历史迁移均无这些列。
--      此前「建安排 / 改物品」路径从未在真实 MySQL 上成功过（内存驱动掩盖），
--      本次一次性补齐，否则前端补完 UI 仍会失败。
--
-- 性质：纯加法 —— 仅 ADD COLUMN，不改不删既有列；无需数据回填
--      （上述写路径从未在 MySQL 落过行）。
-- 应用：prisma migrate deploy（或 dev）
-- ============================================================================

-- ############################################################################
-- §1 itinerary_item：补服务实际读写列 + 地图标记 / 交通方式
-- ############################################################################
ALTER TABLE `itinerary_item`
  ADD COLUMN `start_at`    DATETIME(3)     NULL COMMENT 'M-Client-2：安排开始（本地时间，服务实际读写列）' AFTER `title`,
  ADD COLUMN `end_at`      DATETIME(3)     NULL COMMENT 'M-Client-2：安排结束（本地时间）' AFTER `start_at`,
  ADD COLUMN `amount`      BIGINT          NULL COMMENT 'M-Client-2：日程内记账金额（最小货币单位整数）' AFTER `end_at`,
  ADD COLUMN `currency`    VARCHAR(3)      NULL COMMENT 'M-Client-2：币种（ISO-4217）' AFTER `amount`,
  ADD COLUMN `amount_base` BIGINT          NULL COMMENT 'M-Client-2：人民币折算额（最小货币单位）' AFTER `currency`,
  ADD COLUMN `version`     BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'M-Client-2：CAS 乐观锁版本（E7）' AFTER `amount_base`,
  ADD COLUMN `lat`         DOUBLE          NULL COMMENT 'M-Client-2：地图标记纬度（未选点为空）' AFTER `version`,
  ADD COLUMN `lng`         DOUBLE          NULL COMMENT 'M-Client-2：地图标记经度' AFTER `lat`,
  ADD COLUMN `transport`   VARCHAR(8)      NULL COMMENT 'M-Client-2：交通方式 WALK/BIKE/CAR/BUS/TRAIN/FLIGHT' AFTER `lng`;

-- 说明：旧列 date / start_time / end_time 无任何代码引用（服务一律走
--       start_at / end_at），为守「纯加法」原则保留不删；
--       待确认无外部依赖后再单独发起清理迁移。

-- ############################################################################
-- §2 item：补 CAS version（item.service 早已 insert/update version）
-- ############################################################################
ALTER TABLE `item`
  ADD COLUMN `version` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'M-Client-2：CAS 乐观锁版本（E7）' AFTER `note`;
