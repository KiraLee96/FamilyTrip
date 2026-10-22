-- ============================================================================
-- D-2026-10-14-02 · 迁移：trip 增加行程邀请码（GRP-02 外部同行者加入）
-- 对象：family-trip（MySQL 8.4.3）
--
-- 背景：
--   家庭邀请码只能拉「家人」；朋友同行需要**行程级**邀请码。
--   前端契约已于 2026-10-14 冻结（apps/client/src/api/types.ts 的 TripInvite），
--   本迁移为其提供持久化列。
--
-- 口径（派发单 §一，勿自行发挥）：
--   1) invite_code 允许 NULL：历史行与「尚未生成」的行留空；
--      MySQL 唯一索引不约束 NULL，多行 NULL 合法。
--   2) 唯一索引与 family 域同构：软删感知（含 deleted_at）。
--   3) invite_updated_at 记录码的最近重置时间；建行程时置 now，reset 时更新。
--      **不要**用 trip.updated_at 代替 —— 行程内容更新会污染该语义，
--      前端邀请卡展示的「重置时间」会失真。
--   4) 历史行回填：一次性 UPDATE 用字符集（去 0/O/1/I/l）生成 8 位码。
--      本文件采用「随迁移执行」方式（非独立数据脚本），见下方 §2。
--
-- 性质：纯加法 —— 仅 ADD COLUMN + 回填 + CREATE INDEX；不改不删既有列。
-- ⚠️ 与既有列无关的口径：trip.version / status 等 E7 CAS 字段一律不动；
--    邀请码不属于 E7 版本管辖（reset 不走 CAS，见派发单 §2.4 第 5 条）。
--
-- 应用：prisma migrate deploy（或 dev）
-- ⚠️ 排序说明：本迁移时间戳 20261014180000 早于已上线的
--    20261015120000_itinerary_blocks（生产 D10 已应用 4 个迁移）。
--    `migrate deploy` 会按目录名升序应用**未应用**的迁移，功能上可正常落地；
--    若 CI 对「迁移时间戳必须严格递增」有校验，请将本目录重命名
--    （例如 20261022000000_trip_invite_code）后再提交，SQL 内容不变。
-- ============================================================================

-- ── §1 结构：加两列 ────────────────────────────────────────────────────────
ALTER TABLE `trip`
    ADD COLUMN `invite_code` VARCHAR(16) NULL COMMENT 'D-2026-10-14-02：行程邀请码（8 位去易混字符；NULL=尚未生成，读取时懒生成）' AFTER `actual_json`,
    ADD COLUMN `invite_updated_at` DATETIME(3) NULL COMMENT 'D-2026-10-14-02：邀请码最近重置时间（无重置=创建时间；不复用 updated_at）' AFTER `invite_code`;

-- ── §2 回填：给存量行生成 8 位码 ───────────────────────────────────────────
-- 取 MD5(id + 常量盐) 的 16 个十六进制位，每 2 位折成一个 0–255 的整数，
-- 对 31（字符集长度）取模后映射到字符集 —— 逐个 id 结果不同，无需随机函数，
-- 也不会因 MySQL 对非确定函数（RAND/UUID）的求值次数差异造成整表同码。
-- 32 位十六进制 = 8 个位置 × 2 位，与 8 位码长恰好对齐。
UPDATE `trip`
SET
    `invite_code` = CONCAT(
        SUBSTRING('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + MOD(CONV(SUBSTRING(MD5(CONCAT('trip-invite:', `id`)), 1, 2), 16, 10), 31), 1),
        SUBSTRING('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + MOD(CONV(SUBSTRING(MD5(CONCAT('trip-invite:', `id`)), 3, 2), 16, 10), 31), 1),
        SUBSTRING('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + MOD(CONV(SUBSTRING(MD5(CONCAT('trip-invite:', `id`)), 5, 2), 16, 10), 31), 1),
        SUBSTRING('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + MOD(CONV(SUBSTRING(MD5(CONCAT('trip-invite:', `id`)), 7, 2), 16, 10), 31), 1),
        SUBSTRING('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + MOD(CONV(SUBSTRING(MD5(CONCAT('trip-invite:', `id`)), 9, 2), 16, 10), 31), 1),
        SUBSTRING('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + MOD(CONV(SUBSTRING(MD5(CONCAT('trip-invite:', `id`)), 11, 2), 16, 10), 31), 1),
        SUBSTRING('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + MOD(CONV(SUBSTRING(MD5(CONCAT('trip-invite:', `id`)), 13, 2), 16, 10), 31), 1),
        SUBSTRING('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + MOD(CONV(SUBSTRING(MD5(CONCAT('trip-invite:', `id`)), 15, 2), 16, 10), 31), 1)
    ),
    `invite_updated_at` = `created_at`
WHERE `invite_code` IS NULL;

-- ⚠️ 回填不做「查重后重写」：撞码概率约 31^-8（约 1/8.5e11），且
--    服务端 `uniqueTripInviteCode` 在建行程 / 重置 / 懒生成三处都会查重，
--    真的撞上也会在下一次访问时被纠正。若上线后确需强一致，另开数据脚本。

-- ── §3 索引：软删感知唯一（与 family 域同构）──────────────────────────────
-- 放在回填之后：若回填意外产生重码，此处失败可直接观察，而不是让 §2 的
-- UPDATE 因索引冲突中断（增量行能定位到具体 id）。
CREATE UNIQUE INDEX `trip_invite_code_deleted_at_key` ON `trip`(`invite_code`, `deleted_at`);

-- 验收：
--   SELECT COUNT(*) FROM `trip` WHERE `invite_code` IS NULL;                 -- 期望 0
--   SELECT COUNT(*) FROM `trip` WHERE `invite_code` NOT REGEXP '^[A-HJ-NP-Z2-9]{8}$'; -- 期望 0
--   SHOW INDEX FROM `trip` WHERE Key_name = 'trip_invite_code_deleted_at_key';       -- 期望 1 行
