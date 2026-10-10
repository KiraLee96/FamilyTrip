-- CreateTable
CREATE TABLE `user` (
    `id` BIGINT NOT NULL,
    `openid` VARCHAR(64) NOT NULL,
    `unionid` VARCHAR(64) NULL,
    `phone` VARCHAR(20) NULL,
    `nickname` VARCHAR(64) NOT NULL,
    `avatarUrl` VARCHAR(512) NULL,
    `home_timezone` VARCHAR(32) NOT NULL DEFAULT 'Asia/Shanghai',
    `dek_version` INTEGER NOT NULL DEFAULT 1,
    `status` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_users_created_at`(`created_at`),
    UNIQUE INDEX `user_openid_deleted_at_key`(`openid`, `deleted_at`),
    UNIQUE INDEX `user_unionid_deleted_at_key`(`unionid`, `deleted_at`),
    UNIQUE INDEX `user_phone_key`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `family` (
    `id` BIGINT NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `owner_id` BIGINT NOT NULL,
    `invite_code` VARCHAR(16) NOT NULL,
    `timezone` VARCHAR(32) NOT NULL DEFAULT 'Asia/Shanghai',
    `status` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_family_owner`(`owner_id`),
    UNIQUE INDEX `family_invite_code_deleted_at_key`(`invite_code`, `deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `family_member` (
    `id` BIGINT NOT NULL,
    `family_id` BIGINT NOT NULL,
    `user_id` BIGINT NULL,
    `role` VARCHAR(16) NOT NULL DEFAULT 'MEMBER',
    `is_virtual` BOOLEAN NOT NULL DEFAULT false,
    `managed_by` BIGINT NULL,
    `display_name` VARCHAR(64) NOT NULL,
    `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_user_alive`(`user_id`, `deleted_at`),
    INDEX `idx_family_alive`(`family_id`, `deleted_at`),
    INDEX `idx_fm_managed_by`(`managed_by`),
    UNIQUE INDEX `family_member_family_id_user_id_deleted_at_key`(`family_id`, `user_id`, `deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wish` (
    `id` BIGINT NOT NULL,
    `family_id` BIGINT NOT NULL,
    `trip_id` BIGINT NULL,
    `created_by` BIGINT NOT NULL,
    `title` VARCHAR(128) NOT NULL,
    `description` TEXT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'WANT',
    `vote_count` INTEGER NOT NULL DEFAULT 0,
    `vote_count_synced_at` DATETIME(3) NULL,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_wish_family_status`(`family_id`, `status`, `deleted_at`),
    INDEX `idx_wish_creator`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wish_vote` (
    `id` BIGINT NOT NULL,
    `wish_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_wish_vote_user`(`user_id`, `deleted_at`),
    UNIQUE INDEX `wish_vote_wish_id_user_id_deleted_at_key`(`wish_id`, `user_id`, `deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trip` (
    `id` BIGINT NOT NULL,
    `family_id` BIGINT NOT NULL,
    `created_by` BIGINT NOT NULL,
    `leader_id` BIGINT NULL,
    `title` VARCHAR(128) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    `start_date` DATE NULL,
    `end_date` DATE NULL,
    `timezone` VARCHAR(32) NOT NULL DEFAULT 'Asia/Shanghai',
    `destinations_json` JSON NULL,
    `actual_json` JSON NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_trip_family_status`(`family_id`, `status`, `deleted_at`),
    INDEX `idx_trip_leader`(`leader_id`),
    INDEX `idx_trip_updated`(`updated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trip_member` (
    `id` BIGINT NOT NULL,
    `trip_id` BIGINT NOT NULL,
    `user_id` BIGINT NULL,
    `managed_by` BIGINT NULL,
    `role` VARCHAR(16) NOT NULL DEFAULT 'MEMBER',
    `is_external` BOOLEAN NOT NULL DEFAULT false,
    `access_level` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    `display_name` VARCHAR(64) NOT NULL,
    `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `left_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_trip_external`(`trip_id`, `is_external`),
    INDEX `idx_managed_by`(`managed_by`),
    INDEX `idx_tm_user_level`(`user_id`, `access_level`),
    UNIQUE INDEX `trip_member_trip_id_user_id_deleted_at_key`(`trip_id`, `user_id`, `deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trip_destination` (
    `id` BIGINT NOT NULL,
    `trip_id` BIGINT NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `extra_json` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_dest_trip`(`trip_id`, `sort`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trip_history` (
    `hid` BIGINT NOT NULL,
    `trip_id` BIGINT NOT NULL,
    `snapshot_json` JSON NOT NULL,
    `changed_by` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_trip_history_trip`(`trip_id`),
    PRIMARY KEY (`hid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `itinerary_item` (
    `id` BIGINT NOT NULL,
    `trip_id` BIGINT NOT NULL,
    `created_by` BIGINT NOT NULL,
    `title` VARCHAR(128) NOT NULL,
    `date` DATE NULL,
    `start_time` DATETIME(3) NULL,
    `end_time` DATETIME(3) NULL,
    `location` VARCHAR(256) NULL,
    `note` TEXT NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `rate_source` VARCHAR(8) NOT NULL DEFAULT 'AUTO',
    `rate_by` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_itinerary_trip_date`(`trip_id`, `date`, `sort`),
    INDEX `idx_itinerary_updated`(`updated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `booking` (
    `id` BIGINT NOT NULL,
    `trip_id` BIGINT NOT NULL,
    `created_by` BIGINT NOT NULL,
    `type` VARCHAR(16) NOT NULL DEFAULT 'OTHER',
    `title` VARCHAR(128) NOT NULL,
    `order_no` VARCHAR(128) NULL,
    `order_link` VARCHAR(512) NULL,
    `order_no_enc` VARBINARY(1024) NULL,
    `order_link_enc` VARBINARY(2048) NULL,
    `contact_enc` VARBINARY(1024) NULL,
    `order_no_blind` VARBINARY(32) NULL,
    `amount_base` BIGINT NULL,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'CNY',
    `rate_source` VARCHAR(8) NOT NULL DEFAULT 'AUTO',
    `rate_by` BIGINT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_booking_trip_type`(`trip_id`, `type`, `deleted_at`),
    INDEX `idx_created_by`(`created_by`),
    INDEX `idx_booking_blind`(`order_no_blind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trip_checklist_item` (
    `id` BIGINT NOT NULL,
    `trip_id` BIGINT NOT NULL,
    `template_id` BIGINT NULL,
    `scope` VARCHAR(16) NOT NULL DEFAULT 'SHARED',
    `owner_id` BIGINT NULL,
    `created_by` BIGINT NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `checked` BOOLEAN NOT NULL DEFAULT false,
    `checked_by` BIGINT NULL,
    `checked_at` DATETIME(3) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_tci_trip_scope`(`trip_id`, `scope`, `deleted_at`),
    INDEX `idx_tci_owner`(`owner_id`, `deleted_at`),
    INDEX `idx_tci_updated`(`updated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `checklist_template` (
    `id` BIGINT NOT NULL,
    `family_id` BIGINT NULL,
    `scope` VARCHAR(16) NOT NULL DEFAULT 'SHARED',
    `owner_id` BIGINT NULL,
    `name` VARCHAR(128) NOT NULL,
    `items_json` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_tpl_family`(`family_id`, `deleted_at`),
    INDEX `idx_tpl_owner`(`owner_id`, `deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `item` (
    `id` BIGINT NOT NULL,
    `family_id` BIGINT NOT NULL,
    `owner_id` BIGINT NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `category` VARCHAR(32) NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `note` VARCHAR(256) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_item_owner`(`owner_id`, `deleted_at`),
    INDEX `idx_item_family_cat`(`family_id`, `category`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `outfit` (
    `id` BIGINT NOT NULL,
    `family_id` BIGINT NOT NULL,
    `owner_id` BIGINT NOT NULL,
    `trip_id` BIGINT NULL,
    `name` VARCHAR(128) NOT NULL,
    `note` VARCHAR(256) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_outfit_owner`(`owner_id`, `deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `outfit_item` (
    `id` BIGINT NOT NULL,
    `outfit_id` BIGINT NOT NULL,
    `item_id` BIGINT NOT NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_outfit_item_outfit`(`outfit_id`),
    INDEX `idx_outfit_item_item`(`item_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expense` (
    `id` BIGINT NOT NULL,
    `trip_id` BIGINT NOT NULL,
    `family_id` BIGINT NOT NULL,
    `created_by` BIGINT NOT NULL,
    `owner_member_id` BIGINT NULL,
    `title` VARCHAR(128) NOT NULL,
    `amount` BIGINT NOT NULL,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'CNY',
    `amount_base` BIGINT NULL,
    `exchange_rate` DECIMAL(18, 8) NULL,
    `rate_date` VARCHAR(10) NULL,
    `tier` VARCHAR(16) NOT NULL DEFAULT 'SPOT_SELL',
    `rate_source` VARCHAR(8) NOT NULL DEFAULT 'AUTO',
    `rate_by` BIGINT NULL,
    `category` VARCHAR(32) NULL,
    `spent_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_expense_trip`(`trip_id`, `deleted_at`),
    INDEX `idx_expense_owner_member`(`owner_member_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `currency_config` (
    `currency` VARCHAR(8) NOT NULL,
    `minor_unit` INTEGER NOT NULL DEFAULT 2,
    `round_mode` VARCHAR(16) NOT NULL DEFAULT 'HALF_UP',
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`currency`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exchange_rate` (
    `id` BIGINT NOT NULL,
    `base` VARCHAR(8) NOT NULL,
    `quote` VARCHAR(8) NOT NULL,
    `tier` VARCHAR(16) NOT NULL DEFAULT 'SPOT_SELL',
    `rate` DECIMAL(18, 8) NOT NULL,
    `rate_date` VARCHAR(10) NOT NULL,
    `source` VARCHAR(64) NOT NULL,
    `rate_time` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_fx_date`(`rate_date`),
    UNIQUE INDEX `exchange_rate_base_quote_tier_rate_date_source_deleted_at_key`(`base`, `quote`, `tier`, `rate_date`, `source`, `deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reminder_task` (
    `id` BIGINT NOT NULL,
    `receiver_id` BIGINT NOT NULL,
    `created_by` BIGINT NOT NULL,
    `trip_id` BIGINT NULL,
    `subscription_id` BIGINT NULL,
    `title` VARCHAR(128) NOT NULL,
    `content` VARCHAR(512) NULL,
    `remind_at` DATETIME(3) NOT NULL,
    `tz` VARCHAR(32) NULL,
    `channel` VARCHAR(16) NOT NULL DEFAULT 'SUBSCRIBE',
    `delivery` VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
    `merged_group_id` BIGINT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `read_at` DATETIME(3) NULL,
    `sent_at` DATETIME(3) NULL,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_remind_at`(`status`, `remind_at`),
    INDEX `idx_receiver_delivery`(`receiver_id`, `delivery`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notify_subscription` (
    `id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `template_id` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'GRANTED',
    `granted_at` DATETIME(3) NULL,
    `expire_at` DATETIME(3) NULL,
    `remain_count` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_notify_sub_user`(`user_id`),
    UNIQUE INDEX `notify_subscription_user_id_template_id_deleted_at_key`(`user_id`, `template_id`, `deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_asset` (
    `id` BIGINT NOT NULL,
    `family_id` BIGINT NOT NULL,
    `trip_id` BIGINT NULL,
    `owner_id` BIGINT NOT NULL,
    `file_key` VARCHAR(256) NOT NULL,
    `mime_type` VARCHAR(64) NOT NULL,
    `byte_size` BIGINT NOT NULL,
    `compressed` BOOLEAN NOT NULL DEFAULT false,
    `exif_stripped` BOOLEAN NOT NULL DEFAULT false,
    `had_gps` BOOLEAN NOT NULL DEFAULT false,
    `storage_class` VARCHAR(16) NOT NULL DEFAULT 'STANDARD',
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_media_family`(`family_id`, `deleted_at`),
    INDEX `idx_media_trip`(`trip_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `memory_archive` (
    `id` BIGINT NOT NULL,
    `family_id` BIGINT NOT NULL,
    `year` INTEGER NOT NULL,
    `type` VARCHAR(16) NOT NULL,
    `ref_id` BIGINT NULL,
    `snapshot_json` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_memory_family`(`family_id`),
    UNIQUE INDEX `memory_archive_family_id_year_type_key`(`family_id`, `year`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `file_pending` (
    `id` BIGINT NOT NULL,
    `file_key` VARCHAR(256) NOT NULL,
    `owner_id` BIGINT NULL,
    `trip_id` BIGINT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `idx_file_pending_status`(`status`),
    UNIQUE INDEX `file_pending_file_key_key`(`file_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holiday` (
    `id` BIGINT NOT NULL,
    `country` VARCHAR(8) NOT NULL DEFAULT 'CN',
    `name` VARCHAR(64) NOT NULL,
    `date` DATE NOT NULL,
    `is_workday` BOOLEAN NOT NULL DEFAULT false,
    `year` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,
    `family_id` BIGINT NULL,

    INDEX `idx_holiday_country_year`(`country`, `year`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `change_log` (
    `id` BIGINT NOT NULL,
    `entity_type` VARCHAR(32) NOT NULL,
    `entity_id` BIGINT NOT NULL,
    `family_id` BIGINT NULL,
    `trip_id` BIGINT NULL,
    `op` VARCHAR(8) NOT NULL,
    `changed_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_cursor`(`changed_at`, `id`),
    INDEX `idx_entity`(`entity_type`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency` (
    `id` BIGINT NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `request_id` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'IN_PROGRESS',
    `result` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `idx_idem_expires`(`expires_at`),
    UNIQUE INDEX `idempotency_scope_request_id_key`(`scope`, `request_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log` (
    `id` BIGINT NOT NULL,
    `actor_id` BIGINT NULL,
    `action` VARCHAR(64) NOT NULL,
    `reason` VARCHAR(64) NOT NULL,
    `severity` VARCHAR(16) NOT NULL DEFAULT 'INFO',
    `retain_until` DATETIME(3) NOT NULL,
    `target_type` VARCHAR(32) NULL,
    `target_id` BIGINT NULL,
    `detail` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_audit_retain`(`retain_until`),
    INDEX `idx_audit_actor`(`actor_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `family` ADD CONSTRAINT `family_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `family_member` ADD CONSTRAINT `family_member_family_id_fkey` FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `family_member` ADD CONSTRAINT `family_member_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `family_member` ADD CONSTRAINT `family_member_managed_by_fkey` FOREIGN KEY (`managed_by`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wish` ADD CONSTRAINT `wish_family_id_fkey` FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wish` ADD CONSTRAINT `wish_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wish_vote` ADD CONSTRAINT `wish_vote_wish_id_fkey` FOREIGN KEY (`wish_id`) REFERENCES `wish`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wish_vote` ADD CONSTRAINT `wish_vote_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip` ADD CONSTRAINT `trip_family_id_fkey` FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip` ADD CONSTRAINT `trip_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip` ADD CONSTRAINT `trip_leader_id_fkey` FOREIGN KEY (`leader_id`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_member` ADD CONSTRAINT `trip_member_trip_id_fkey` FOREIGN KEY (`trip_id`) REFERENCES `trip`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_member` ADD CONSTRAINT `trip_member_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_member` ADD CONSTRAINT `trip_member_managed_by_fkey` FOREIGN KEY (`managed_by`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_destination` ADD CONSTRAINT `trip_destination_trip_id_fkey` FOREIGN KEY (`trip_id`) REFERENCES `trip`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_history` ADD CONSTRAINT `trip_history_trip_id_fkey` FOREIGN KEY (`trip_id`) REFERENCES `trip`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `itinerary_item` ADD CONSTRAINT `itinerary_item_trip_id_fkey` FOREIGN KEY (`trip_id`) REFERENCES `trip`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `booking` ADD CONSTRAINT `booking_trip_id_fkey` FOREIGN KEY (`trip_id`) REFERENCES `trip`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `booking` ADD CONSTRAINT `booking_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_checklist_item` ADD CONSTRAINT `trip_checklist_item_trip_id_fkey` FOREIGN KEY (`trip_id`) REFERENCES `trip`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_checklist_item` ADD CONSTRAINT `trip_checklist_item_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_checklist_item` ADD CONSTRAINT `trip_checklist_item_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trip_checklist_item` ADD CONSTRAINT `trip_checklist_item_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `checklist_template`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item` ADD CONSTRAINT `item_family_id_fkey` FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item` ADD CONSTRAINT `item_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `outfit` ADD CONSTRAINT `outfit_family_id_fkey` FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `outfit` ADD CONSTRAINT `outfit_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `outfit_item` ADD CONSTRAINT `outfit_item_outfit_id_fkey` FOREIGN KEY (`outfit_id`) REFERENCES `outfit`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `outfit_item` ADD CONSTRAINT `outfit_item_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expense` ADD CONSTRAINT `expense_trip_id_fkey` FOREIGN KEY (`trip_id`) REFERENCES `trip`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expense` ADD CONSTRAINT `expense_family_id_fkey` FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expense` ADD CONSTRAINT `expense_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reminder_task` ADD CONSTRAINT `reminder_task_receiver_id_fkey` FOREIGN KEY (`receiver_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reminder_task` ADD CONSTRAINT `reminder_task_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reminder_task` ADD CONSTRAINT `reminder_task_trip_id_fkey` FOREIGN KEY (`trip_id`) REFERENCES `trip`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reminder_task` ADD CONSTRAINT `reminder_task_subscription_id_fkey` FOREIGN KEY (`subscription_id`) REFERENCES `notify_subscription`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notify_subscription` ADD CONSTRAINT `notify_subscription_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_asset` ADD CONSTRAINT `media_asset_family_id_fkey` FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_asset` ADD CONSTRAINT `media_asset_trip_id_fkey` FOREIGN KEY (`trip_id`) REFERENCES `trip`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_asset` ADD CONSTRAINT `media_asset_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `memory_archive` ADD CONSTRAINT `memory_archive_family_id_fkey` FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `memory_archive` ADD CONSTRAINT `memory_archive_ref_id_fkey` FOREIGN KEY (`ref_id`) REFERENCES `trip`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `holiday` ADD CONSTRAINT `holiday_family_id_fkey` FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

