-- D-2026-10-26-03 · 枚举字面量超过列宽 → MySQL 严格模式 1406 → 整事务回滚 → HTTP 500
--
-- 根因（不是「Prisma 不收 null」——那条已用生产实证排除：
--   `trip.service.create` 一直在写 `actual_json: null`，而建行程是正常的）：
--
--   ① trip_member.access_level = VARCHAR(16)，代码写入 'HISTORICAL_READONLY'（19 字符）
--      → `POST /trips/:id/finish` 在「把成员转历史只读」这一步必定 1406；
--        而 CAS 改 status 与它在**同一事务** → 一起回滚
--        → 行程 status 永远停在 PLANNED、成员 access_level 永远是 ACTIVE。
--        这正是线上「finish 恒 500，但界面按日期派生仍显示已完成」的全部原因。
--
--   ② {expense,booking,itinerary_item}.rate_source = VARCHAR(8)，代码写入
--      'SAME_CURRENCY'（13 字符）→ 同币种（CNY）记账 / 预订同样 1406。
--      属同一类隐患，一并在本迁移修掉（否则修完 finish 还会撞上记账）。
--
-- 为什么 CI 全绿也测不出：单测跑内存驱动，不校验列宽、不校验 SQL 方言。
-- 防复发：test/schema-enum-width.test.ts（静态校验「枚举字面量 ≤ 列宽」）。
--
-- 性质：纯放宽列宽（16→32 / 8→32），不改语义、不删数据。
--
-- 迁移前自检（部署侧 2 分钟）：
--   SELECT @@sql_mode;                       -- 含 STRICT_TRANS_TABLES = 严格模式（预期）
--   SHOW CREATE TABLE trip_member;           -- 确认 access_level 仍是 varchar(16)
--   SELECT access_level, COUNT(*) FROM trip_member GROUP BY access_level;
--   → 出现 'HISTORICAL_REA' 之类的截断值 ⇒ 该库是**非严格模式**（静默截断），
--     本文件 §③ 会自动把它订正回来；全是 ACTIVE 则符合严格模式预期。

-- ── ① 行程成员访问级别：HISTORICAL_READONLY = 19 字符 ──────────────────
ALTER TABLE `trip_member`
  MODIFY `access_level` VARCHAR(32) NOT NULL DEFAULT 'ACTIVE';

-- ── ② 汇率来源：SAME_CURRENCY = 13 字符 ───────────────────────────────
ALTER TABLE `expense`
  MODIFY `rate_source` VARCHAR(32) NOT NULL DEFAULT 'AUTO';

ALTER TABLE `booking`
  MODIFY `rate_source` VARCHAR(32) NOT NULL DEFAULT 'AUTO';

ALTER TABLE `itinerary_item`
  MODIFY `rate_source` VARCHAR(32) NOT NULL DEFAULT 'AUTO';

-- ── ③ 订正非严格模式下被静默截断的历史值（严格模式库上为 no-op）─────────
-- 只修「截断签名」，不做通配重写：不认识的值一律不动，宁可留证据也不覆盖。
UPDATE `trip_member`
   SET `access_level` = 'HISTORICAL_READONLY'
 WHERE `access_level` LIKE 'HISTORICAL\_REA%'
   AND `access_level` <> 'HISTORICAL_READONLY';

UPDATE `expense`
   SET `rate_source` = 'SAME_CURRENCY'
 WHERE `rate_source` LIKE 'SAME\_CUR%'
   AND `rate_source` <> 'SAME_CURRENCY';

UPDATE `booking`
   SET `rate_source` = 'SAME_CURRENCY'
 WHERE `rate_source` LIKE 'SAME\_CUR%'
   AND `rate_source` <> 'SAME_CURRENCY';

-- 订正后仍存在的异常值（应返回空集；有值请人工确认后再处理）：
--   SELECT DISTINCT access_level FROM trip_member;
--   SELECT DISTINCT rate_source  FROM expense;
--   SELECT DISTINCT rate_source  FROM booking;

-- ── 回滚（如需；注意长值已能落库，回滚会截断）───────────────────────────
-- 仅在「业务决定不再区分历史只读 / 同币种」时使用，且必须先清值：
--   UPDATE `trip_member` SET `access_level` = 'ACTIVE'
--    WHERE `access_level` NOT IN ('ACTIVE');
--   ALTER TABLE `trip_member` MODIFY `access_level` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE';
--   UPDATE `expense` SET `rate_source` = 'AUTO' WHERE `rate_source` = 'SAME_CURRENCY';
--   UPDATE `booking` SET `rate_source` = 'AUTO' WHERE `rate_source` = 'SAME_CURRENCY';
--   ALTER TABLE `expense` MODIFY `rate_source` VARCHAR(8) NOT NULL DEFAULT 'AUTO';
--   ALTER TABLE `booking` MODIFY `rate_source` VARCHAR(8) NOT NULL DEFAULT 'AUTO';
--   ALTER TABLE `itinerary_item` MODIFY `rate_source` VARCHAR(8) NOT NULL DEFAULT 'AUTO';
