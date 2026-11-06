-- ============================================================================
-- 2026-11-05 · 头像资产不再绑定家庭（media_asset.family_id → NULL 允许）
-- ============================================================================
-- 需求来源：派发单《前端五项问题只读核查》§4
--   「AVATAR 是否错误依赖 familyId/家庭成员资格」——是。
--   症状：一个还没加入任何家庭的用户**无法上传头像**（presign/confirm 都 422），
--         但头像是用户资产，业务上不该依赖家庭成员资格。
--
-- 代码侧已把 fileKey 前缀分成两池（`a/<userId>/` / `f/<familyId>/`），
-- 但 `family_id` 仍是 NOT NULL + 外键，导致「只改 Zod」会在 confirm 写库时炸。
-- 故本迁移只放宽可空性，是**纯加法**：
--   · 既有行全部保留原 family_id，旧照片/旧头像的读取路径不变；
--   · 新头像行写 NULL，家庭相册按 `family_id IS NULL` 天然排除
--     （`media.service.list` 另按 `a/` 前缀再挡一层，兼容改造前的旧头像行）。
--
-- 🔴 外键为何要 DROP 再 ADD：Prisma 对**可选关系**默认用 `ON DELETE SET NULL`，
--    对必填关系用 `ON DELETE RESTRICT`。只 MODIFY 列、不动外键的话，库里的
--    引用动作会与 schema.prisma 推导结果不一致 → 下次 `migrate diff` 报漂移。
--    本文件的 SQL 由 `prisma migrate diff --from-schema-datamodel <旧> \
--    --to-schema-datamodel <新> --script` 原样生成，不是手写推断。
--
-- ⚠️ 上线顺序：先 `prisma migrate deploy` 再发新代码。反过来会让新代码往
--    NOT NULL 列写 NULL（报 1048），表现为「头像上传 500」。
-- ============================================================================

-- DropForeignKey
ALTER TABLE `media_asset` DROP FOREIGN KEY `media_asset_family_id_fkey`;

-- AlterTable
ALTER TABLE `media_asset` MODIFY `family_id` BIGINT NULL;

-- AddForeignKey
ALTER TABLE `media_asset` ADD CONSTRAINT `media_asset_family_id_fkey` FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
