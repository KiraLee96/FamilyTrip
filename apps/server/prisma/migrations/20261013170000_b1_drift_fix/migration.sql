-- ============================================================================
-- B1 漂移修正 · Prisma 迁移（[B] 路径，对应 schema.prisma v1.5 B1 修正）
-- 对象：family-trip（MySQL 8.4.3）
-- 配套：B1-漂移裁决书-磐石石-v1.0.md + B1-修正迁移草案-磐石石-v1.0.sql
-- 应用：prisma migrate deploy（或 dev）。本文件 = 草案 §A + 三确认项 + §6.4 + §C + §B 合并，
--       适配 Prisma 路径（索引使用 schema 显式 name；memory_archive.snap_key 为普通列由
--       Repository 维护，非 DB 生成列；collation 用显式逐表 CONVERT 规避 DELIMITER 限制）。
--
-- ⚠ 前置硬门槛：下方「§0 去重扫描」必须全部返回 0 行；否则结构段 ADD UNIQUE 会因
--   (biz_key,'') 冲突失败（旧键对活跃 NULL 不挡重，可能已存在重复活跃行）。
--   若存在重复，先治理：重复活跃行保留 1 条（最小 id），其余 UPDATE 置 deleted_at 并写
--   deleted_token = REPLACE(UUID(),'-','')（见 §A 回填注释）。
--
-- 🔧 2026-10-14 全新库 deploy 修复（init → b1 → m_client_2 链首次实跑）：
--   本稿原按「探测库」的索引名写死 DROP INDEX（uk_openid / uk_unionid /
--   uk_invite_code / uk_wish_user / uk_trip_user / uk_family_user / uk_user_tpl），
--   而 init 迁移（20261010120000）生成的是 Prisma 默认索引名
--   （*_deleted_at_key 系列）——导致全新库 deploy 必现 Error 1091
--   "Can't DROP 'uk_openid'; check that column/key exists"，迁移链中断。
--   本次按 init 实际产物逐项改名；另补两处收尾：
--     · user_phone_key → uk_phone（schema v1.5 显式名，原稿漏改）
--     · memory_archive 旧唯一键 family_id_year_type_key 清理（B1 改 uk_snap 后
--       该键会阻断「同一家庭同年多个 TRIP 回忆」，属语义错误而非仅命名漂移）
-- ============================================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ############################################################################
-- §0 去重扫描（只读，先于一切 ALTER；任一返回 >0 必须先治理）
-- ############################################################################
-- SELECT openid, COUNT(*) c FROM user WHERE deleted_at IS NULL GROUP BY openid HAVING c > 1;
-- SELECT unionid, COUNT(*) c FROM user WHERE deleted_at IS NULL AND unionid IS NOT NULL GROUP BY unionid HAVING c > 1;
-- SELECT invite_code, COUNT(*) c FROM family WHERE deleted_at IS NULL GROUP BY invite_code HAVING c > 1;
-- SELECT wish_id, user_id, COUNT(*) c FROM wish_vote WHERE deleted_at IS NULL GROUP BY wish_id, user_id HAVING c > 1;
-- SELECT trip_id, user_id, COUNT(*) c FROM trip_member WHERE deleted_at IS NULL GROUP BY trip_id, user_id HAVING c > 1;
-- SELECT family_id, user_id, COUNT(*) c FROM family_member WHERE deleted_at IS NULL GROUP BY family_id, user_id HAVING c > 1;

-- ############################################################################
-- §A STRUCTURAL
-- ############################################################################

-- A15 user：加 deleted_token + 切键 (openid/unionid, deleted_token) + 已软删行回填 token
-- （索引名用 schema 显式 name: uk_openid / uk_unionid）
-- 🔧 DROP 目标按 init 迁移实际生成的 Prisma 默认索引名（见文件头修复说明）
ALTER TABLE `user`
  ADD COLUMN `deleted_token` CHAR(36) NOT NULL DEFAULT '' COMMENT '软删令牌: 活跃行恒空串, 软删由Repository(E4)写UUID' AFTER `deleted_at`;
UPDATE `user` SET `deleted_token` = REPLACE(UUID(),'-','') WHERE `deleted_at` IS NOT NULL AND `deleted_token` = '';
ALTER TABLE `user`
  DROP INDEX `user_openid_deleted_at_key`,
  ADD UNIQUE KEY `uk_openid` (`openid`, `deleted_token`),
  DROP INDEX `user_unionid_deleted_at_key`,
  ADD UNIQUE KEY `uk_unionid` (`unionid`, `deleted_token`),
  DROP INDEX `user_phone_key`,
  ADD UNIQUE KEY `uk_phone` (`phone`);

-- A16 family
ALTER TABLE `family`
  ADD COLUMN `deleted_token` CHAR(36) NOT NULL DEFAULT '' COMMENT '软删令牌: 同 user 约定' AFTER `deleted_at`;
UPDATE `family` SET `deleted_token` = REPLACE(UUID(),'-','') WHERE `deleted_at` IS NOT NULL AND `deleted_token` = '';
ALTER TABLE `family`
  DROP INDEX `family_invite_code_deleted_at_key`,
  ADD UNIQUE KEY `uk_invite_code` (`invite_code`, `deleted_token`);

-- A17 wish_vote
ALTER TABLE `wish_vote`
  ADD COLUMN `deleted_token` CHAR(36) NOT NULL DEFAULT '' COMMENT '软删令牌: 同 user 约定' AFTER `deleted_at`;
UPDATE `wish_vote` SET `deleted_token` = REPLACE(UUID(),'-','') WHERE `deleted_at` IS NOT NULL AND `deleted_token` = '';
ALTER TABLE `wish_vote`
  DROP INDEX `wish_vote_wish_id_user_id_deleted_at_key`,
  ADD UNIQUE KEY `uk_wish_user` (`wish_id`, `user_id`, `deleted_token`);

-- A11/A12：trip_member / family_member 唯一键回退纯 (biz_key)（去误加 deleted_at）
ALTER TABLE `trip_member`
  DROP INDEX `trip_member_trip_id_user_id_deleted_at_key`,
  ADD UNIQUE KEY `uk_trip_user` (`trip_id`, `user_id`);
ALTER TABLE `family_member`
  DROP INDEX `family_member_family_id_user_id_deleted_at_key`,
  ADD UNIQUE KEY `uk_family_user` (`family_id`, `user_id`);

-- A21/A23：补 2 个可落地 CHECK（itinerary_item / booking 的 rate_by 无外键引用动作，可落地）
-- ⛔ 原稿第 3 条 chk_tci_scope_owner 已移除（2026-10-14 修复）：
--    trip_checklist_item.owner_id 的外键为 ON DELETE SET NULL，MySQL 8.4 禁止
--    将带引用动作的列用于 CHECK（Error 3823）；且二者语义本身矛盾 —— 删用户时
--    SET NULL 会把 PERSONAL 项的 owner_id 置空，恰恰违反该 CHECK。DB 层不可落地，
--    不变式改由 Repository 写路径强制 + resolveChecklistDomain 读路径分流保证
--    （与 schema.prisma 中该 @@check 的临时注释口径一致）。
ALTER TABLE `itinerary_item`
  ADD CONSTRAINT `chk_ii_rate_by` CHECK (`rate_source` = 'AUTO' OR `rate_by` IS NOT NULL);
ALTER TABLE `booking`
  ADD CONSTRAINT `chk_bk_rate_by` CHECK (`rate_source` = 'AUTO' OR `rate_by` IS NOT NULL);

-- A13：reminder_task 枚举默认值对齐 C6/C13（tz 由可空改 NOT NULL，先回填 NULL 行）
UPDATE `reminder_task` SET `tz` = 'Asia/Shanghai' WHERE `tz` IS NULL;
ALTER TABLE `reminder_task`
  MODIFY COLUMN `channel` VARCHAR(16) NOT NULL DEFAULT 'IN_APP_TODO' COMMENT '实际投递渠道（C6）',
  MODIFY COLUMN `delivery` VARCHAR(16) NOT NULL DEFAULT 'SUBSCRIBE_FIRST' COMMENT '投递策略（C6 定稿）',
  MODIFY COLUMN `tz`      VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai' COMMENT '提醒时区快照（C13）';

-- A18/A19：version 默认 0→1，类型 INT→BIGINT UNSIGNED
UPDATE `trip` SET `version` = 1 WHERE `version` = 0;
UPDATE `trip_checklist_item` SET `version` = 1 WHERE `version` = 0;
ALTER TABLE `trip` MODIFY COLUMN `version` BIGINT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE `trip_checklist_item` MODIFY COLUMN `version` BIGINT UNSIGNED NOT NULL DEFAULT 1;

-- ============================================================================
-- 三确认项 ① notify_subscription：收敛枚举 + 结构对齐 TP-02A
-- ============================================================================
UPDATE `notify_subscription`
  SET `status` = CASE `status`
    WHEN 'GRANTED' THEN 'ACCEPTED'
    WHEN 'REVOKED' THEN 'REVOKED'
    WHEN 'EXPIRED' THEN 'EXPIRED'
    ELSE 'REVOKED' END;
UPDATE `notify_subscription` SET `remain_count` = 0 WHERE `remain_count` IS NULL;
ALTER TABLE `notify_subscription`
  MODIFY COLUMN `status` ENUM('ACCEPTED','REVOKED','BANNED','EXPIRED') NOT NULL DEFAULT 'ACCEPTED' COMMENT '收敛状态机(磐石石推荐)',
  ADD COLUMN  `sub_type` ENUM('ONCE','LONG_TERM') NOT NULL DEFAULT 'ONCE' COMMENT 'C6 长期订阅优先+降级' AFTER `template_id`,
  MODIFY COLUMN `remain_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'ONCE 递减 / LONG_TERM 恒 0=不限',
  DROP INDEX `notify_subscription_user_id_template_id_deleted_at_key`,
  ADD UNIQUE KEY `uk_user_template` (`user_id`, `template_id`);
ALTER TABLE `notify_subscription` DROP COLUMN `deleted_at`;

-- ============================================================================
-- 三确认项 ② memory_archive：允许多次快照（snap_key 普通列 + Repository 维护 + 回填）
-- ============================================================================
ALTER TABLE `memory_archive`
  ADD COLUMN `photo_keys`  JSON         NULL     COMMENT '快照引用照片 COS 键列表（C12 对象不归档）',
  ADD COLUMN `checksum`    CHAR(64)     NULL     COMMENT '快照 SHA-256 防漂移',
  ADD COLUMN `archived_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '归档时刻',
  ADD COLUMN `snap_key`    VARCHAR(80)  NULL     COMMENT '唯一键合成列: T:<refId>/A:<familyId>:<year>';

-- 回填存量 snap_key（与 schema.prisma B1 约定一致；新写由 Repository 维护）
UPDATE `memory_archive` SET `snap_key` =
  CASE `type`
    WHEN 'TRIP'   THEN CONCAT('T:', `ref_id`)
    WHEN 'ANNUAL' THEN CONCAT('A:', `family_id`, ':', `year`)
    ELSE CONCAT('X:', `id`)
  END
  WHERE `snap_key` IS NULL OR `snap_key` = '';

-- ⚠ 若库内已有 type 不在 (TRIP,ANNUAL) 或 TRIP 缺 ref_id 的脏数据，下方 ADD CONSTRAINT 会失败；
--   先修正越界行，再执行本段。
ALTER TABLE `memory_archive`
  MODIFY COLUMN `snap_key` VARCHAR(80) NOT NULL,
  DROP INDEX `memory_archive_family_id_year_type_key`,
  ADD UNIQUE KEY `uk_snap` (`snap_key`),
  ADD CONSTRAINT `chk_ma_type`    CHECK (`type` IN ('TRIP','ANNUAL'));
-- ⛔ 原稿 chk_ma_trip / chk_ma_annual 已移除（2026-10-14 修复）：
--    ref_id / family_id 的外键均带引用动作（SET NULL / CASCADE），MySQL 8.4 禁止
--    此类列进 CHECK（Error 3823）；不变式由 Repository 写路径保证
--    （TRIP 必带 ref_id/family_id，ANNUAL 必带 family_id/year）。

-- ============================================================================
-- 三确认项 ③ file_pending：G1 字节数上限校验落地
-- ============================================================================
ALTER TABLE `file_pending`
  ADD COLUMN `purpose`       VARCHAR(32)     NOT NULL DEFAULT 'MEDIA' COMMENT '上传用途（G1 受限签名）',
  ADD COLUMN `expected_size` BIGINT UNSIGNED NOT NULL DEFAULT 0      COMMENT '签名时申报字节数上限（G1）',
  ADD COLUMN `content_type`  VARCHAR(64)     NULL     COMMENT '白名单 image/jpeg|png|webp|pdf（G1）',
  ADD COLUMN `confirmed_at`  DATETIME(3)     NULL     COMMENT '直传完成确认时刻';
UPDATE `file_pending` SET `expected_size` = 52428800 WHERE `expected_size` = 0;
ALTER TABLE `file_pending`
  DROP INDEX `idx_file_pending_status`,
  ADD INDEX `idx_status_created` (`status`, `created_at`),
  ADD CONSTRAINT `chk_fp_size` CHECK (`expected_size` > 0 AND `expected_size` <= 52428800);

-- ============================================================================
-- §6.4 列级漂移修正（change_log / trip_history）—— 仅补功能性缺口
--      （hid / changed_by / family_id,trip_id 为 Prisma 有意命名，保留不回退）
-- ============================================================================
ALTER TABLE `change_log`
  ADD COLUMN `actor_id` BIGINT       NULL    COMMENT '操作者 user_id；系统/迁移为 NULL' AFTER `entity_id`,
  ADD COLUMN `trace_id` VARCHAR(64)  NULL    COMMENT '链路追踪 ID' AFTER `actor_id`,
  MODIFY COLUMN `entity_type` VARCHAR(64) NOT NULL COMMENT '实体类型，如 trip / itinerary_item / booking';

ALTER TABLE `trip_history`
  ADD COLUMN `version` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '快照对应的 trip.version（A18）；0=修正前存量' AFTER `trip_id`;
ALTER TABLE `trip_history`
  ADD INDEX `idx_trip_version` (`trip_id`, `version`);

-- ============================================================================
-- §C COLLATION 统一（P2 · 报告 §8-4）
-- 目标：库级 + 全部表 + 全部文本列 统一为 utf8mb4_0900_ai_ci（TP-02A §0.1 权威约定）
-- 说明：Prisma 迁移不支持 DELIMITER/存储过程，故对已知 28 张表逐表显式 CONVERT。
-- ============================================================================
ALTER DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

ALTER TABLE `user`              CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `family`            CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `family_member`     CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `wish`              CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `wish_vote`         CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `trip`              CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `trip_member`       CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `trip_destination`  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `trip_history`      CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `itinerary_item`    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `booking`           CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `trip_checklist_item` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `checklist_template`  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `item`              CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `outfit`            CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `outfit_item`       CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `expense`           CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `currency_config`   CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `exchange_rate`     CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `reminder_task`     CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `notify_subscription` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `media_asset`       CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `memory_archive`    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `file_pending`      CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `holiday`           CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `change_log`        CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `idempotency`       CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `audit_log`         CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- ############################################################################
-- §B DATA
-- ############################################################################
INSERT INTO `currency_config` (`currency`, `minor_unit`) VALUES ('JPY', 0), ('CNY', 2), ('BHD', 3)
  ON DUPLICATE KEY UPDATE `minor_unit` = VALUES(`minor_unit`);

UPDATE `reminder_task` SET `delivery` = 'TODO_ONLY' WHERE `delivery` = 'NORMAL';

SET FOREIGN_KEY_CHECKS = 1;
-- 验收：_prisma_migrations 含本迁移；mysqldump --no-data 排序集合 diff == 修正后 schema 语义。
-- 注：change_log / trip_history 的 §6.4 列级漂移已并入上方（仅补功能性缺口）。
