-- ============================================================================
-- TP-02A · 数据库 DDL 变更脚本（v1.0 · 决策落库版）
-- 项目：家庭出行计划 · 评审整改（对应《TP-02-技术负责人-后端》子包 TP-02A，组 A 共 26 项）
-- 编制：磐石石（后端架构专家）    日期：2026-09-30
-- 目标库：MySQL 8.0+（CHECK 约束要求 >= 8.0.16；JSON_TABLE 需 8.0+）
-- 约定：utf8mb4 / utf8mb4_0900_ai_ci，InnoDB
--
-- 修订记录：
--   v0.9 (09-29) 组 A 26 项初稿，memory_archive 注释态等 C8
--   v1.0 (09-30) C1~C13 拍板后决策落库：
--     * A6  memory_archive 正式启用（C8：TRIP 快照 + ANNUAL 年度快照）
--     * A2  notify_subscription 增 sub_type（C6：长期订阅优先 + 降级）
--     * A13 delivery 枚举定稿 SUBSCRIBE_FIRST/TODO_ONLY（C6）；tz 默认值对齐 C13
--     * A14 home_timezone 默认 Asia/Shanghai（C13）
--     * 新增 A27：amount_base 允许 NULL（C3/C9：待补汇率不计入汇总）
--   v1.0a(10-08) 三项签认落库：
--     * A24 签认合并 -> 激活 §A24（trip 加 destinations_json）+ §3 B-6 回填；
--       定稿表数量 24 -> 23（trip_destination 过渡期保留，二期删表）
--     * 存量 DATETIME -> DATETIME(3) 精度扩容：选 B，不纳入本脚本（二期在线变更）
--     * H5 章节编号：保持 §4.3/§4.5（文档侧，不影响本脚本）
--
-- 时间口径（与 H8 声明一致）：
--   * *_time / *_at 类时刻列     -> DATETIME(3)，一律 UTC
--   * *_date 类自然日列          -> DATE，无时区，禁止任何 toUTC() 换算
--   * 服务端时间统一取 DB CURRENT_TIMESTAMP(3)（技术 B8 / E2）
--
-- 覆盖度总览：
--   A1~A7         新增表 7 张（全部实建）
--   A8~A21        已有表变更 14 项
--   A22~A25       容量与语义加固 4 项
--   A26           ER 图补齐 -> 文档任务，见《TP-02A-DDL-说明与核对清单-v0.9.md》
--   A27           C3/C9 配套：amount_base 可空口径（新增）
--
-- [CHK-n] 标记 = 需对照现网表结构核对后执行，全集见说明文档 §5。
-- 执行顺序（详见说明文档 §4）：§5 预检 -> §3 回填 -> §1 新表 -> §2 变更 -> §3 校验
-- ============================================================================


-- ############################################################################
-- §0.1 软删除与唯一键约定（适用于全脚本，对应 A15/A16/A17 与编码规范增补 §2）
-- ############################################################################
-- 约定 1：软删列统一为 `deleted_at` DATETIME(3) NULL；NULL=活跃，非 NULL=已删。
-- 约定 2：需要"软删后可重建 + 活跃行唯一"的表，唯一键一律借助应用层维护的
--         `deleted_token` CHAR(36) NOT NULL DEFAULT ''：
--           活跃行恒为 ''，软删时由 Repository 统一封装（E4）写入 UUID。
--         【为什么不用 (biz_key, deleted_at) 复合唯一键】MySQL 中 NULL 互不相等，
--         两个活跃行（deleted_at 均 NULL）不会触发唯一冲突，会放进重复数据——
--         这正是第二 N-B1 要堵的洞，必须用非 NULL 的 token 列兜底。
-- 约定 3：软删封装同时更新 deleted_at / updated_at / deleted_token，业务代码
--         禁止裸写 SET deleted_at（第二 N-B4 洞 1，编码规范增补 §2）。


-- ############################################################################
-- §1 新增表（A-1，7 张）
-- ############################################################################

-- ----------------------------------------------------------------------------
-- A1  change_log —— 多端同步游标唯一来源（技术 M8 / B1 / B8；一期启用，原定二期）
-- ----------------------------------------------------------------------------
CREATE TABLE `change_log` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `changed_at`  DATETIME(3)     NOT NULL COMMENT '变更时刻 UTC(3)，同步游标第一维',
  `entity_type` VARCHAR(64)     NOT NULL COMMENT '实体类型，如 trip / itinerary_item / booking',
  `entity_id`   BIGINT UNSIGNED NOT NULL COMMENT '实体主键 [CHK-1: 核对实体主键类型是否为 BIGINT]',
  `op`          ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  `actor_id`    BIGINT UNSIGNED NULL COMMENT '操作者 user_id；系统/迁移操作为 NULL',
  `trace_id`    VARCHAR(64)     NULL COMMENT '链路追踪 ID',
  PRIMARY KEY (`id`),
  KEY `idx_cursor` (`changed_at`, `id`),
  KEY `idx_entity` (`entity_type`, `entity_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='多端同步变更日志（E1：游标用 (changed_at,id) 复合；建议按月分区或滚动清理，交 TP-06 运维定保留期）';

-- ----------------------------------------------------------------------------
-- A2  notify_subscription —— 订阅消息授权状态（技术 M9 / B7）
-- ----------------------------------------------------------------------------
CREATE TABLE `notify_subscription` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`      BIGINT UNSIGNED NOT NULL,
  `template_id`  VARCHAR(64)     NOT NULL COMMENT '微信订阅消息模板 ID',
  `sub_type`     ENUM('ONCE','LONG_TERM') NOT NULL DEFAULT 'ONCE' COMMENT '订阅类型（C6：长期订阅优先，R-1 类目审批不过则回落 ONCE）',
  `status`       ENUM('ACCEPTED','REJECTED','BANNED') NOT NULL DEFAULT 'ACCEPTED',
  `remain_count` INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '剩余可下发次数（ONCE 逐次累加/扣减；LONG_TERM 恒 0 表示不限次）',
  `expire_at`    DATETIME(3)     NULL COMMENT '授权有效期至 UTC(3)（C6：长期订阅单次授权 3 个月）',
  `granted_at`   DATETIME(3)     NULL COMMENT '最近一次授权时刻 UTC(3)',
  `last_used_at` DATETIME(3)     NULL COMMENT '最近一次下发时刻 UTC(3)',
  `created_at`   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_template` (`user_id`, `template_id`),
  KEY `idx_user_status` (`user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='微信订阅消息授权台账（谁授权、哪些模板、剩余次数；C6 降级链路数据源）';

-- ----------------------------------------------------------------------------
-- A3  currency_config —— 币种精度与舍入（技术 M10 / I3；前后端共用，见 B3 接口）
-- ----------------------------------------------------------------------------
CREATE TABLE `currency_config` (
  `currency_code` CHAR(3)         NOT NULL COMMENT 'ISO 4217 货币代码',
  `minor_unit`    TINYINT UNSIGNED NOT NULL COMMENT '最小货币单位小数位：JPY=0 / CNY=2 / BHD=3',
  `rounding_mode` VARCHAR(16)     NOT NULL DEFAULT 'ROUND_HALF_UP' COMMENT '舍入模式，写入时一次性舍入（F2）',
  `is_active`     TINYINT(1)      NOT NULL DEFAULT 1,
  `created_at`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`currency_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='币种精度与舍入规则（评审定稿口径的唯一事实来源）';

-- 初始化种子（仅任务点名的三种，其余币种启用时补充）
INSERT INTO `currency_config` (`currency_code`, `minor_unit`) VALUES
  ('JPY', 0), ('CNY', 2), ('BHD', 3);

-- ----------------------------------------------------------------------------
-- A4  outfit_item —— 穿搭-物品关联，替代 outfit.item_ids JSON（技术 M11 / I9）
--     迁移：见 §3 B-4 JSON 展开回填；回填完成后 outfit.item_ids 置空保留一期，
--     二期删列（保留期由评审定）。
-- ----------------------------------------------------------------------------
CREATE TABLE `outfit_item` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `outfit_id`  BIGINT UNSIGNED NOT NULL,
  `item_id`    BIGINT UNSIGNED NOT NULL COMMENT '私人清单物品 ID [CHK-2: 确认 item 主键列名/类型]',
  `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_outfit_item` (`outfit_id`, `item_id`),
  KEY `idx_item` (`item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='穿搭-物品关联表（替代 outfit.item_ids JSON，支撑按物品反查穿搭）';

-- ----------------------------------------------------------------------------
-- A5  trip_history —— trip 域历史版本快照（技术 M12 / B1 / R3）
--     兑现"保留最近 1 个历史版本"：Repository 更新 trip 前先 upsert 快照，
--     并删除同 trip 更早的快照（只留 1 条）。
-- ----------------------------------------------------------------------------
CREATE TABLE `trip_history` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `trip_id`       BIGINT UNSIGNED NOT NULL,
  `version`       BIGINT UNSIGNED NOT NULL COMMENT '快照对应的 trip.version（A18）',
  `snapshot_json` JSON            NOT NULL COMMENT '覆盖前的完整 trip 快照（含 actual_json）',
  `edited_by`     BIGINT UNSIGNED NULL COMMENT '触发覆盖的操作者 user_id',
  `created_at`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_trip_version` (`trip_id`, `version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='trip 变更前快照，每 trip 仅保留最近 1 个历史版本（M12 / R3）';

-- ----------------------------------------------------------------------------
-- A6  memory_archive —— 回忆只读快照（第二 N-I1）【C8 已拍板：正式启用】
--     触发时机（C8）：
--       * type=TRIP    ：trip.status -> DONE 时写入（出行结束即固化）
--       * type=ANNUAL  ：每年 12 月定时任务写入年度总结快照
--     语义：归档内容不随后续原始数据修订而变化（只读快照，MEM-01/03）。
--     联动：照片本体不进归档层（C12），本表只存快照数据引用。
-- ----------------------------------------------------------------------------
CREATE TABLE `memory_archive` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `memory_id`        BIGINT UNSIGNED NOT NULL COMMENT '原回忆记录 ID',
  `type`             ENUM('TRIP','ANNUAL') NOT NULL COMMENT '快照类型（C8）：TRIP=出行结束 / ANNUAL=年度总结',
  `trip_id`          BIGINT UNSIGNED NULL COMMENT 'type=TRIP 时的关联出行',
  `year`             SMALLINT UNSIGNED NULL COMMENT 'type=ANNUAL 时的自然年度（无时区，H8）',
  `snapshot_json`    JSON            NOT NULL COMMENT '只读快照内容（文本/结构化数据）',
  `photo_keys`       JSON            NULL COMMENT '快照引用的照片 COS 键列表（对象不归档，C12）',
  `checksum`         CHAR(64)        NULL COMMENT '快照 SHA-256，防漂移校验',
  `archived_at`      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at`       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_memory_type` (`memory_id`, `type`),
  KEY `idx_year_type` (`year`, `type`),
  KEY `idx_trip` (`trip_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='回忆区只读快照（C8 已拍板：TRIP + ANNUAL 双快照，归档内容不随原始数据漂移）';

-- ----------------------------------------------------------------------------
-- A7  file_pending —— 孤儿文件治理（第二 N-I5）
--     评估结论：建议一期就建。理由：无此表则 COS 生命周期清理无法区分
--     "待确认"与"孤儿"，存在误删有效文件风险；建表成本极低。
--     流程：POST /upload/sign 时写入 PENDING(purpose,size)（受限签名，G1/B6）
--           -> 直传完成确认 -> CONFIRMED
--           -> 定时任务扫描 PENDING 超时 -> ORPHANED -> 删 COS 对象
-- ----------------------------------------------------------------------------
CREATE TABLE `file_pending` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `file_key`      VARCHAR(512)    NOT NULL COMMENT 'COS 对象键（含 userId/tripId 前缀，G1）',
  `purpose`       VARCHAR(32)     NOT NULL COMMENT '上传用途，与受限签名的 purpose 一致（B6）',
  `expected_size` BIGINT UNSIGNED NOT NULL COMMENT '签名时申报字节数（G1 大小上限校验）',
  `content_type`  VARCHAR(64)     NULL COMMENT '白名单内类型：image/jpeg|png|webp（G1）',
  `status`        ENUM('PENDING','CONFIRMED','ORPHANED') NOT NULL DEFAULT 'PENDING',
  `confirmed_at`  DATETIME(3)     NULL,
  `created_at`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_file_key` (`file_key`),
  KEY `idx_status_created` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='上传文件先待确认台账（孤儿文件治理：先待确认后标记有效，第二 N-I5）';


-- ############################################################################
-- §2 已有表变更（A-2 共 14 项 + A-3 加固）
--     ⚠ 所有 ALTER 前先跑 §5 预检 SQL；顺序：回填(§3) -> 本节 -> CHECK
-- ############################################################################

-- A8  booking：软删 + 创建人索引（技术 M1 / B2）
ALTER TABLE `booking`
  ADD COLUMN `deleted_at` DATETIME(3) NULL COMMENT '软删时刻 UTC(3)' AFTER `updated_at`,
  ADD INDEX `idx_created_by` (`created_by`);          -- [CHK-3: 核对创建人列名]

-- A9  itinerary_item：软删 + 更新时间索引（技术 M2 / B2 / 第二 N-B4）
ALTER TABLE `itinerary_item`
  ADD COLUMN `deleted_at` DATETIME(3) NULL COMMENT '软删时刻 UTC(3)',
  ADD INDEX `idx_updated` (`updated_at`);

-- A10 补齐缺失的 updated_at（技术 M3 / B2 / B8）
--     DB 托管（DEFAULT + ON UPDATE），与 E2"服务端时间取 DB"一致。
ALTER TABLE `trip_destination`
  ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE `wish_vote`
  ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE `holiday`
  ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE `exchange_rate`
  ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
-- reminder_task 的 updated_at 在 A13 一并处理
-- [CHK-4: 若某表已有 updated_at 且由应用层维护，改为核对行为差异后再执行]

-- A11 trip_member：代管人 / 退出行踪 / 历史只读（技术 M4 / B5 / B6 / I8）
ALTER TABLE `trip_member`
  ADD COLUMN `managed_by`    BIGINT UNSIGNED NULL COMMENT '虚拟成员代管人 user_id（B5/D6 权限链）' AFTER `user_id`,
  ADD COLUMN `left_at`       DATETIME(3)     NULL COMMENT '退出/移除时刻 UTC(3)' AFTER `managed_by`,
  ADD COLUMN `access_level`  ENUM('ACTIVE','HISTORICAL_READONLY') NOT NULL DEFAULT 'ACTIVE' COMMENT 'B4 接口设置历史只读' AFTER `left_at`,
  ADD UNIQUE KEY `uk_trip_user` (`trip_id`, `user_id`),
  ADD INDEX `idx_trip_external` (`trip_id`, `external_user_id`),  -- [CHK-5: 核对外部成员列名]
  ADD INDEX `idx_managed_by` (`managed_by`);
-- 策略说明：离团不删行、再次加入时原行复活（left_at 置 NULL），保证 uk_trip_user 恒成立。
-- 若产品要求保留多次入退历史，此唯一键需重设计——交评审确认（M4）。

-- A12 family_member：家庭-用户唯一 + 活跃行索引（技术 M5 / I8 / 第二 N-B2）
ALTER TABLE `family_member`
  ADD UNIQUE KEY `uk_family_user` (`family_id`, `user_id`),
  ADD INDEX `idx_user_alive`   (`user_id`,   `deleted_at`),
  ADD INDEX `idx_family_alive` (`family_id`, `deleted_at`);
-- [CHK-6: family_member 应已有 deleted_at；若无，需先补列]

-- A13 reminder_task：通道 / 合并组 / 时区 / 投递 / 已读 / 软删 / 索引重排
--     （技术 M6 / B7 / I7 / S6；第二 N-I2）
ALTER TABLE `reminder_task`
  ADD COLUMN `channel`         ENUM('SUBSCRIBE','IN_APP_TODO') NOT NULL DEFAULT 'IN_APP_TODO' COMMENT '实际投递渠道（C6）：SUBSCRIBE=订阅消息 / IN_APP_TODO=应用内待办（降级落地）',
  ADD COLUMN `merged_group_id` BIGINT UNSIGNED NULL COMMENT '合并提醒组 ID（S6）' AFTER `channel`,
  ADD COLUMN `tz`              VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai' COMMENT '生成时快照的用户常驻地时区（C13，IANA）；仅用于 remind_at 语义（H8）' AFTER `merged_group_id`,
  ADD COLUMN `delivery`        ENUM('SUBSCRIBE_FIRST','TODO_ONLY') NOT NULL DEFAULT 'SUBSCRIBE_FIRST' COMMENT '投递策略（C6 定稿）：SUBSCRIBE_FIRST=订阅优先可降级 / TODO_ONLY=仅应用内待办（B2 口径）' AFTER `tz`,
  ADD COLUMN `read_at`         DATETIME(3) NULL COMMENT '待办已读时刻 UTC(3)' AFTER `delivery`,
  ADD COLUMN `deleted_at`      DATETIME(3) NULL COMMENT '软删时刻 UTC(3)' AFTER `read_at`,
  ADD COLUMN `updated_at`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) AFTER `deleted_at`,
  MODIFY COLUMN `remind_at`    DATETIME(3) NOT NULL COMMENT '提醒时刻 UTC(3)；存量换算见 §3 B-3 [CHK-9: 严禁盲跑]';
ALTER TABLE `reminder_task` DROP INDEX `idx_remind_at`;
ALTER TABLE `reminder_task`
  ADD INDEX `idx_remind_at`        (`status`, `remind_at`),
  ADD INDEX `idx_receiver_delivery`(`receiver_id`, `delivery`);
-- [CHK-10: status / receiver_id 为现有列，核对列名]

-- A14 user：手机号唯一 + 主时区（技术 M7 / S2 / I7；C13 落库）
ALTER TABLE `user`
  ADD COLUMN `home_timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai' COMMENT '用户常驻地时区（C13，IANA；默认 Asia/Shanghai 可改）' AFTER `phone`,
  ADD UNIQUE KEY `uk_phone` (`phone`);
-- MySQL 唯一索引对 NULL 天然放行多行，满足"允许 NULL"。
-- [CHK-11: phone 空值必须是 NULL 而非 ''，否则空串互相冲突——见 §5 P-3]
-- 备注：若业务允许"注销后同手机号重新注册"，建议 uk_phone 并入 deleted_token
--       （与 A15 同款），一行改动，交评审一并定。

-- A15 user：openid / unionid 唯一键软删化（第二 N-B1）
--     前置：§3 B-1 已为软删行回填 deleted_token。
ALTER TABLE `user`
  ADD COLUMN `deleted_token` CHAR(36) NOT NULL DEFAULT '' COMMENT '软删令牌：活跃恒 ''，软删由 Repository 写 UUID（E4）' AFTER `deleted_at`,
  DROP INDEX `uk_openid`,
  ADD UNIQUE KEY `uk_openid`  (`openid`,  `deleted_token`),
  DROP INDEX `uk_unionid`,
  ADD UNIQUE KEY `uk_unionid` (`unionid`, `deleted_token`);

-- A16 family：邀请码唯一键软删化（第二 N-B1）
ALTER TABLE `family`
  ADD COLUMN `deleted_token` CHAR(36) NOT NULL DEFAULT '' COMMENT '同 A15 约定' AFTER `deleted_at`,
  DROP INDEX `uk_invite_code`,
  ADD UNIQUE KEY `uk_invite_code` (`invite_code`, `deleted_token`);
-- [CHK-12: family 若无 deleted_at 需先补列]
-- 附注（第二 N-S6，2026-10-08 已签认）：invite_code 一期明确"长期有效"，不加 expires_at / max_uses；
--     兜底能力 = 户主可重置邀请码（重置即作废旧码），应用层实现，本脚本无需为此变更。

-- A17 wish_vote：软删取消投票（第二 N-B1）【✅ 已签认保持软删，2026-10-08】
--     签认结论：采用"软删取消投票"，保留复活语义与投票历史；
--     与全局统一软删约定（§0.1 / E4 Repository 封装）一致，不为单表开硬删特例。
--     （若后续改判硬删：撤销本段，恢复 DELETE + 原 uk_wish_user 不动。）
ALTER TABLE `wish_vote`
  ADD COLUMN `deleted_at`    DATETIME(3) NULL COMMENT '取消投票=软删；再次投票=原行复活（deleted_at/token 置空）',
  ADD COLUMN `deleted_token` CHAR(36)    NOT NULL DEFAULT '' COMMENT '同 A15 约定' AFTER `deleted_at`,
  DROP INDEX `uk_wish_user`,
  ADD UNIQUE KEY `uk_wish_user` (`wish_id`, `user_id`, `deleted_token`);

-- A18 trip：乐观锁版本号（技术 M28 / T-1；第二 N-B4）
ALTER TABLE `trip`
  ADD COLUMN `version` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '乐观锁；E8 经由事务+行锁递增，保护 actual_json' AFTER `updated_at`,
  ADD INDEX `idx_updated` (`updated_at`);

-- A19 trip_checklist_item：版本号 + 共享/个人域（技术 M28 / T-1；第二 N-B2）
ALTER TABLE `trip_checklist_item`
  ADD COLUMN `version` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '乐观锁；勾选走 CAS（E7）' AFTER `updated_at`,
  ADD COLUMN `scope`   ENUM('SHARED','PERSONAL') NOT NULL DEFAULT 'SHARED' COMMENT '共享/个人；回填见 §3 B-2' AFTER `version`,
  ADD INDEX `idx_updated` (`updated_at`);

-- A20 booking 拆表评估（第二 N-I8）—— 结论见说明文档 §6.3【✅ 已签认不拆，2026-10-08】
--     签认结论：一期不拆分 booking_transport / booking_hotel，改为把高频查询字段提升为真实列。
--     以下示例仍为注释态：具体列全集待 CHK-13 核对现表 info_json 结构后确定，核对通过再启用。
-- ALTER TABLE `booking`
--   ADD COLUMN `booking_type` ENUM('TRANSPORT','HOTEL') NOT NULL COMMENT '业务类型 [CHK-13: 需先核对现表 info_json 结构]',
--   ADD INDEX `idx_trip_type_date` (`trip_id`, `booking_type`, `start_date`);

-- A21 汇率手动覆盖审计：itinerary_item / booking（第二 N-I9）
ALTER TABLE `itinerary_item`
  ADD COLUMN `rate_source` ENUM('AUTO','MANUAL') NOT NULL DEFAULT 'AUTO' COMMENT '汇率来源（第二 N-I9）',
  ADD COLUMN `rate_by`     BIGINT UNSIGNED NULL COMMENT '手动覆盖操作人 user_id；MANUAL 时必填' AFTER `rate_source`,
  ADD CONSTRAINT `chk_ii_rate_by` CHECK (`rate_source` = 'AUTO' OR `rate_by` IS NOT NULL);
ALTER TABLE `booking`
  ADD COLUMN `rate_source` ENUM('AUTO','MANUAL') NOT NULL DEFAULT 'AUTO' COMMENT '汇率来源（第二 N-I9）',
  ADD COLUMN `rate_by`     BIGINT UNSIGNED NULL COMMENT '手动覆盖操作人 user_id；MANUAL 时必填' AFTER `rate_source`,
  ADD CONSTRAINT `chk_bk_rate_by` CHECK (`rate_source` = 'AUTO' OR `rate_by` IS NOT NULL);

-- ----------------------------------------------------------------------------
-- §2 续：容量与语义加固（A-3）
-- ----------------------------------------------------------------------------

-- A22 order_link_enc 容量（第二 §3.2⑦ / 技术 B4）
--     不可静默截断：DB 层给足容量；应用层按 C-3 校验长度不足即抛错。
ALTER TABLE `booking`
  MODIFY COLUMN `order_link_enc` VARBINARY(2048) NULL
  COMMENT '加密订单链接 [1B format_ver][1B key_ver][1B algo_id][12B IV][ct][16B tag]（C-1/C-2）';
-- [CHK-14: 核对现容量；超长存量数据先排查 SELECT id, LENGTH(order_link_enc) FROM booking WHERE LENGTH(order_link_enc)>2048]

-- A23 双语义表加固（技术 M25 / B1）
--     trip_checklist_item：scope 与 owner_id 互斥一致（先跑 §3 B-2 回填，否则 ALTER 失败）
ALTER TABLE `trip_checklist_item`
  ADD CONSTRAINT `chk_tci_scope_owner` CHECK (
    (`scope` = 'SHARED'   AND `owner_id` IS NULL) OR
    (`scope` = 'PERSONAL' AND `owner_id` IS NOT NULL)
  );
--     family_member：虚拟成员必须有代管人。若现表已有 managed_by 列则启用：
-- ALTER TABLE `family_member`
--   ADD CONSTRAINT `chk_fm_virtual` CHECK (`is_virtual` = 0 OR `managed_by` IS NOT NULL);
--     [CHK-15: family_member 若无 managed_by 列，按 M25 备选方案走 Repository 强制封装
--      （推荐，与编码规范增补 §2 一并落地），DB 层不强行加 CHECK]

-- A24 trip_destination 合并评估（第二 N-S1）—— ✅ 已签认采纳合并（2026-10-08）
--     目的地并入 trip.destinations_json；三步可回滚迁移（说明文档 §6.4）：
--       ① 本段 ALTER 加列 + §3 B-6 回填；
--       ② 代码切读新列（灰度观察）；
--       ③ trip_destination 转只读 -> 二期 DROP TABLE。
--     ⚠ 过渡期 trip_destination 物理保留，故库中实体表数暂为 24；
--        定稿结构（技术方案 v1.2）已按合并后 23 张计。
ALTER TABLE `trip`
  ADD COLUMN `destinations_json` JSON NULL COMMENT '目的地清单（数组；替代 trip_destination 表，N-S1，写入前过 schema 校验）' AFTER `actual_json`;

-- A25 wish：投票计数对账时间戳（技术 M23 / I1）
ALTER TABLE `wish`
  ADD COLUMN `vote_count_synced_at` DATETIME(3) NULL COMMENT 'vote_count 最近一次对账时刻 UTC(3)（M23/I1）';

-- A27 amount_base 可空口径（C3 + C9 配套；新增于 v1.0）
--     C3：待补汇率金额不计入汇总，且展示「+N 笔待补」角标（设计 C3）。
--     C9：amount_base IS NULL（待补汇率）不计入任何汇总。
--     ⚠ 先核对 itinerary_item.amount_base / booking.amount_base 现定义：
--       若为 NOT NULL，须先执行 §3 B-5 回填再改 NULL。
-- ALTER TABLE `itinerary_item`
--   MODIFY COLUMN `amount_base` BIGINT NULL COMMENT '基准币 minor_unit 整数；NULL=汇率待补（C9 不计入汇总）';
-- ALTER TABLE `booking`
--   MODIFY COLUMN `amount_base` BIGINT NULL COMMENT '基准币 minor_unit 整数；NULL=汇率待补（C9 不计入汇总）';
-- [CHK-16: 核对两表 amount_base 现定义与 NULL 占比]

-- A26 ER 图补齐 -> 文档任务：holiday / exchange_rate / reminder_task 及本脚本
--     全部新增表纳入 ER 图，随技术方案 v1.2 一并交付（见说明文档 §7）。


-- ############################################################################
-- §3 数据回填与迁移（幂等草案，全部先在预发验证）
-- ############################################################################

-- B-1 deleted_token 回填（A15/A16/A17 前置）
UPDATE `user`      SET `deleted_token` = REPLACE(UUID(), '-', '') WHERE `deleted_at` IS NOT NULL AND `deleted_token` = '';
UPDATE `family`    SET `deleted_token` = REPLACE(UUID(), '-', '') WHERE `deleted_at` IS NOT NULL AND `deleted_token` = '';
UPDATE `wish_vote` SET `deleted_token` = REPLACE(UUID(), '-', '') WHERE `deleted_at` IS NOT NULL AND `deleted_token` = '';

-- B-2 trip_checklist_item.scope 回填（A19/A23 前置）
UPDATE `trip_checklist_item` SET `scope` = 'PERSONAL' WHERE `owner_id` IS NOT NULL AND `scope` = 'SHARED';

-- B-3 reminder_task.remind_at 时区基准换算
--     ⚠ 严禁盲跑：先执行 §5 P-5 抽查确认存量是本地时间(UTC+8)还是 UTC。
--     以下假设存量为 UTC+8 本地时间，上线切换点之前的行做 +8h 归一：
-- UPDATE `reminder_task`
--   SET `remind_at` = DATE_ADD(`remind_at`, INTERVAL 8 HOUR)
--   WHERE `remind_at` < '@cutover@';   -- 替换为上线切换时刻

-- B-4 outfit.item_ids JSON 展开（A4 前置）
--     ⚠ 先核对 item_ids 元素类型（纯数字 ID 数组？对象数组？）。
-- INSERT INTO `outfit_item` (`outfit_id`, `item_id`, `sort_order`)
-- SELECT o.`id`, jt.`item_id`, jt.`ord`
--   FROM `outfit` o
--   JOIN JSON_TABLE(o.`item_ids`, '$[*]'
--        COLUMNS (`ord` FOR ORDINALITY, `item_id` BIGINT UNSIGNED PATH '$')) jt;
-- 展开校验通过后：UPDATE outfit SET item_ids = NULL;（一期置空保留，二期删列）

-- B-5 amount_base 待补汇率回填（A27 前置）
--     仅当 amount_base 现为 NOT NULL 且存在"汇率待补"行时执行；
--     待补语义由 rate_source/录入状态判定（[CHK-16] 先确认判定口径）。
-- UPDATE `itinerary_item` SET `amount_base` = NULL
--   WHERE `rate_source` = 'AUTO' AND `amount_base` = 0;   -- 0 值占位视为待补（待确认）

-- B-6 trip_destination -> trip.destinations_json 回填（A24 前置）
--     ⚠ 先核对目的地字段（name/sort）与 trip 侧 schema 的映射；JSON 元素结构须过 schema 校验。
--     ⚠ MySQL 的 JSON_ARRAYAGG 不支持 ORDER BY，需先在子查询内排序再聚合。
-- UPDATE `trip` t
--   JOIN (
--     SELECT `trip_id`, JSON_ARRAYAGG(JSON_OBJECT('name', `name`, 'sort', `sort`)) AS arr
--       FROM (SELECT * FROM `trip_destination` ORDER BY `trip_id`, `sort`) s
--      GROUP BY `trip_id`
--   ) d ON d.`trip_id` = t.`id`
--    SET t.`destinations_json` = d.arr
--  WHERE t.`destinations_json` IS NULL;
-- 回填校验：SELECT COUNT(*) FROM `trip`
--   WHERE `destinations_json` IS NULL AND `id` IN (SELECT DISTINCT `trip_id` FROM `trip_destination`);
-- 校验通过且灰度观察后：trip_destination 转只读，二期 DROP TABLE。


-- ############################################################################
-- §4 评估结论速览（详述见《TP-02A-DDL-说明与核对清单-v0.9.md》§6）
--   A6  memory_archive  : ✅ C8 已拍板，正式启用（TRIP + ANNUAL 双快照）
--   A7  file_pending    : 建议一期就建（已实建）
--   A20 booking 拆表    : ✅ 已签认不拆（2026-10-08），提升高频列为真实列（列全集待 CHK-13）
--   A24 trip_destination: ✅ 已签认合并进 destinations_json（2026-10-08），三步迁移（已激活）
--   A27 amount_base NULL: C3/C9 配套，待 CHK-16 核对后启用
--
-- v1.0 决策落库索引（C1~C13 -> 本脚本）：
--   C1  -> trip / trip_checklist_item.version（A18/A19）+ E7 CAS（见 TP-02B）
--   C3  -> A27 amount_base NULL
--   C6  -> A2.sub_type + A13.delivery/channel
--   C8  -> A6 memory_archive 正式启用
--   C9  -> A27 + 汇总口径（见 TP-02D）
--   C12 -> A6.photo_keys（照片对象不进归档层）
--   C13 -> A14.home_timezone + A13.tz
-- ############################################################################
