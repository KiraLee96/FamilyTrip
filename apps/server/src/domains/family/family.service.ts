/**
 * family 域 · service
 * ============================================================================
 * 职责：家庭集合、成员、角色、邀请码、虚拟成员代管。
 *
 * 🔴 三条不变量：
 *   1. **户主唯一**：一个家庭任一时刻恰好一个 OWNER。转让户主必须
 *      「先降旧主、再升新主」，且同事务 —— 否则中途失败会出现零户主家庭。
 *   2. **虚拟成员无 userId**：`is_virtual = true` 的成员 `user_id IS NULL`，
 *      靠 `managed_by` 指代管人。权限判定时由 `expandManagedOwnerIds` 展开。
 *   3. **邀请码唯一且软删感知**：`uk_invite_code` 是 `(invite_code, deleted_at)`
 *      复合键，解散家庭后码可被回收重用。
 */

import { AppError, ErrorCode, inviteCodeInvalid } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import { normalizePageQuery, buildPageMeta } from '../../common/pagination/pagination.js';
import { randomInviteCode } from '../../common/invite-code.js';

export interface FamilyServiceOptions {
  ctx: DomainContext;
  /** 邀请码生成器（便于测试注入固定码） */
  generateInviteCode?: () => string;
  auditRetentionDays?: number;
}

const FAMILY_BIGINT_FIELDS = ['id', 'ownerId'];
const MEMBER_BIGINT_FIELDS = ['id', 'familyId', 'userId', 'managedBy'];

export interface FamilyListPage {
  items: Array<Record<string, unknown>>;
  meta: Record<string, unknown>;
}

export class FamilyService {
  private readonly retentionDays: number;

  constructor(private readonly o: FamilyServiceOptions) {
    this.retentionDays = o.auditRetentionDays ?? 365;
  }

  /** 创建家庭 —— 创建者自动成为 OWNER 成员 */
  async create(
    userId: bigint,
    input: { name: string; timezone?: string },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();

      const inviteCode = await this.uniqueInviteCode(tx);
      const familyId = tx.write.nextId();

      await tx.db.insert('family', {
        id: familyId,
        ownerId: userId,
        inviteCode,
        name: input.name,
        timezone: input.timezone ?? 'Asia/Shanghai',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await tx.db.insert('familyMember', {
        id: tx.write.nextId(),
        familyId,
        userId,
        role: 'OWNER',
        isVirtual: false,
        managedBy: null,
        displayName: input.name, // 户主的展示名先用家庭名，后续可改
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await tx.db.insert('changeLog', {
        id: tx.write.nextId(),
        entityType: 'family',
        entityId: familyId,
        familyId,
        tripId: null,
        op: 'INSERT',
        changedAt: now,
        createdAt: now,
      });

      await this.audit(tx, {
        actorId: userId,
        action: 'family.create',
        reason: 'FAMILY_CREATED',
        severity: 'INFO',
        targetId: familyId,
        at: now,
      });

      const row = await tx.db.findUnique('family', { id: familyId });
      return serializeRow(row ?? {}, FAMILY_BIGINT_FIELDS);
    });
  }

  /** 我所属的家庭列表 */
  async listMine(userId: bigint, query: Record<string, unknown>): Promise<FamilyListPage> {
    const page = normalizePageQuery(query['page'], query['pageSize']);
    const memberships = await this.o.ctx.read.findMany('familyMember', {
      where: { userId, deletedAt: null },
    });

    const familyIds = memberships.map((m) => m['familyId'] as bigint);
    const families = await this.o.ctx.read.findMany('family', { where: { deletedAt: null } });
    const mine = families.filter((f) => familyIds.some((id) => id === f['id']));

    const slice = mine.slice(page.skip, page.skip + page.take);

    const items = slice.map((f) => ({
      ...serializeRow(f, FAMILY_BIGINT_FIELDS),
      myRole: memberships.find((m) => m['familyId'] === f['id'])?.['role'] ?? 'MEMBER',
    }));

    return { items, meta: buildPageMeta(page, mine.length) as unknown as Record<string, unknown> };
  }

  /** 家庭详情（含成员列表） */
  async detail(familyId: bigint): Promise<Record<string, unknown>> {
    const family = await this.o.ctx.read.findUnique('family', { id: familyId, deletedAt: null });
    if (!family) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

    const members = await this.o.ctx.read.findMany('familyMember', {
      where: { familyId, deletedAt: null },
      orderBy: [{ joinedAt: 'asc' }],
    });

    return {
      family: serializeRow(family, FAMILY_BIGINT_FIELDS),
      members: members.map((m) => serializeRow(m, MEMBER_BIGINT_FIELDS)),
    };
  }

  /** 改名 / 换时区（仅户主） */
  async update(
    familyId: bigint,
    actorId: bigint,
    patch: { name?: string; timezone?: string },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      await this.assertOwner(tx, familyId, actorId);
      const now = await tx.db.dbNow();

      await tx.db.update('family', { id: familyId, deletedAt: null }, { ...patch, updatedAt: now });

      await tx.db.insert('changeLog', {
        id: tx.write.nextId(),
        entityType: 'family',
        entityId: familyId,
        familyId,
        tripId: null,
        op: 'UPDATE',
        changedAt: now,
        createdAt: now,
      });

      const row = await tx.db.findUnique('family', { id: familyId });
      return serializeRow(row ?? {}, FAMILY_BIGINT_FIELDS);
    });
  }

  /**
   * 解散家庭（仅户主）—— 软删家庭 + 所有成员关系。
   *
   * ⚠️ 不级联软删出行/心愿等数据：它们保留以支撑历史只读（B6）。
   *    客户端通过 change_log 得知家庭消失，本地不再展示。
   */
  async dissolve(familyId: bigint, actorId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      await this.assertOwner(tx, familyId, actorId);
      const now = await tx.db.dbNow();

      await tx.db.update(
        'family',
        { id: familyId, deletedAt: null },
        { deletedAt: now, updatedAt: now },
      );

      const members = await tx.db.findMany('familyMember', {
        where: { familyId, deletedAt: null },
      });
      for (const m of members) {
        await tx.db.update('familyMember', { id: m['id'] }, { deletedAt: now });
      }

      await tx.db.insert('changeLog', {
        id: tx.write.nextId(),
        entityType: 'family',
        entityId: familyId,
        familyId,
        tripId: null,
        op: 'DELETE',
        changedAt: now,
        createdAt: now,
      });

      await this.audit(tx, {
        actorId,
        action: 'family.dissolve',
        reason: 'FAMILY_DISSOLVED',
        severity: 'WARN',
        targetId: familyId,
        detail: { memberCount: members.length },
        at: now,
      });

      return now;
    });
  }

  /** 用邀请码加入 */
  async join(
    userId: bigint,
    input: { inviteCode: string; displayName?: string },
  ): Promise<{
    family: Record<string, unknown>;
    member: Record<string, unknown>;
    alreadyMember: boolean;
  }> {
    return this.o.ctx.tx(async (tx) => {
      const family = await tx.db.findUnique('family', {
        inviteCode: input.inviteCode,
        deletedAt: null,
      });
      // D-2026-10-26-01 P2-1：邀请码未命中回 4041（而不是 4040「资源不存在」）。
      // 邀请码是用户输入的凭据、不构成 ID 枚举面，区分它能让客户端给出
      // 「让家人重新发一次」这种可行动提示（HTTP 仍是 404）。
      if (!family) throw inviteCodeInvalid();
      const familyId = family['id'] as bigint;
      const now = await tx.db.dbNow();

      // 已是成员 → 幂等返回，不重复插
      const existing = await tx.db.findUnique('familyMember', {
        familyId,
        userId,
        deletedAt: null,
      });
      if (existing) {
        return {
          family: serializeRow(family, FAMILY_BIGINT_FIELDS),
          member: serializeRow(existing, MEMBER_BIGINT_FIELDS),
          alreadyMember: true,
        };
      }

      const memberId = tx.write.nextId();
      await tx.db.insert('familyMember', {
        id: memberId,
        familyId,
        userId,
        role: 'MEMBER',
        isVirtual: false,
        managedBy: null,
        displayName: input.displayName ?? (await this.displayNameOf(tx, userId)),
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await tx.db.insert('changeLog', {
        id: tx.write.nextId(),
        entityType: 'family_member',
        entityId: memberId,
        familyId,
        tripId: null,
        op: 'INSERT',
        changedAt: now,
        createdAt: now,
      });

      const member = await tx.db.findUnique('familyMember', { id: memberId });
      return {
        family: serializeRow(family, FAMILY_BIGINT_FIELDS),
        member: serializeRow(member ?? {}, MEMBER_BIGINT_FIELDS),
        alreadyMember: false,
      };
    });
  }

  /**
   * 新增成员。
   *
   * 两种形态：
   *   · 真实成员：给 `userId`
   *   · 虚拟成员：`isVirtual=true` + `displayName`，`user_id` 留空
   */
  async addMember(
    familyId: bigint,
    actorId: bigint,
    input: {
      userId?: string;
      displayName?: string;
      isVirtual: boolean;
      role: 'OWNER' | 'MEMBER';
      managedBy?: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      await this.assertMember(tx, familyId, actorId); // 任意成员可加
      const now = await tx.db.dbNow();

      const isVirtual = input.isVirtual || input.userId === undefined;
      if (isVirtual && !input.displayName) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, '虚拟成员必须提供 displayName');
      }
      // 户主转让必须走专门的接口，这里不允许直接改出第二个 OWNER
      if (input.role === 'OWNER') {
        throw new AppError(ErrorCode.FORBIDDEN, '新增成员不能直接指定户主');
      }

      const userId = isVirtual ? null : BigInt(input.userId!);
      if (userId !== null) {
        const dup = await tx.db.findUnique('familyMember', { familyId, userId, deletedAt: null });
        if (dup) throw new AppError(ErrorCode.FORBIDDEN, '该用户已在家庭中');
      }

      const memberId = tx.write.nextId();
      await tx.db.insert('familyMember', {
        id: memberId,
        familyId,
        userId,
        role: 'MEMBER',
        isVirtual,
        managedBy: isVirtual ? BigInt(input.managedBy ?? actorId.toString()) : null,
        displayName: input.displayName ?? (userId ? await this.displayNameOf(tx, userId) : '成员'),
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await tx.db.insert('changeLog', {
        id: tx.write.nextId(),
        entityType: 'family_member',
        entityId: memberId,
        familyId,
        tripId: null,
        op: 'INSERT',
        changedAt: now,
        createdAt: now,
      });

      await this.audit(tx, {
        actorId,
        action: 'family.member.add',
        reason: 'MEMBER_ADDED',
        severity: 'INFO',
        targetId: memberId,
        detail: { isVirtual },
        at: now,
      });

      const row = await tx.db.findUnique('familyMember', { id: memberId });
      return serializeRow(row ?? {}, MEMBER_BIGINT_FIELDS);
    });
  }

  /** 改成员（角色/昵称/代管人）—— 仅户主 */
  async updateMember(
    memberId: bigint,
    actorId: bigint,
    patch: { role?: 'OWNER' | 'MEMBER'; displayName?: string; managedBy?: string | null },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const member = await tx.db.findUnique('familyMember', { id: memberId, deletedAt: null });
      if (!member) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const familyId = member['familyId'] as bigint;
      await this.assertOwner(tx, familyId, actorId);

      if (patch.role === 'OWNER') {
        throw new AppError(ErrorCode.FORBIDDEN, '转让户主请使用专用接口');
      }

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now };
      if (patch.displayName !== undefined) data['displayName'] = patch.displayName;
      if (patch.managedBy !== undefined) {
        data['managedBy'] = patch.managedBy === null ? null : BigInt(patch.managedBy);
      }

      await tx.db.update('familyMember', { id: memberId }, data);

      await tx.db.insert('changeLog', {
        id: tx.write.nextId(),
        entityType: 'family_member',
        entityId: memberId,
        familyId,
        tripId: null,
        op: 'UPDATE',
        changedAt: now,
        createdAt: now,
      });

      const row = await tx.db.findUnique('familyMember', { id: memberId });
      return serializeRow(row ?? {}, MEMBER_BIGINT_FIELDS);
    });
  }

  /**
   * 转让户主 —— 「先降旧主、再升新主」同事务。
   *
   * 🔴 不能反过来（先升后降），否则中途失败会留下两个 OWNER。
   */
  async transferOwnership(
    familyId: bigint,
    actorId: bigint,
    newOwnerMemberId: bigint,
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      await this.assertOwner(tx, familyId, actorId);
      const now = await tx.db.dbNow();

      const target = await tx.db.findUnique('familyMember', {
        id: newOwnerMemberId,
        familyId,
        deletedAt: null,
      });
      if (!target) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      if (target['isVirtual'] === true) {
        throw new AppError(ErrorCode.FORBIDDEN, '虚拟成员不能成为户主');
      }

      // 1. 先降旧主
      const currentOwner = await tx.db.findUnique('familyMember', {
        familyId,
        userId: actorId,
        deletedAt: null,
      });
      if (currentOwner) {
        await tx.db.update(
          'familyMember',
          { id: currentOwner['id'] },
          { role: 'MEMBER', updatedAt: now },
        );
      }
      // 2. 再升新主
      await tx.db.update(
        'familyMember',
        { id: newOwnerMemberId },
        { role: 'OWNER', updatedAt: now },
      );
      // 3. family.owner_id 同步
      await tx.db.update('family', { id: familyId }, { ownerId: target['userId'], updatedAt: now });

      await tx.db.insert('changeLog', {
        id: tx.write.nextId(),
        entityType: 'family',
        entityId: familyId,
        familyId,
        tripId: null,
        op: 'UPDATE',
        changedAt: now,
        createdAt: now,
      });

      await this.audit(tx, {
        actorId,
        action: 'family.transfer_ownership',
        reason: 'OWNER_TRANSFERRED',
        severity: 'ALERT',
        targetId: familyId,
        detail: { newOwnerUserId: (target['userId'] as bigint | null)?.toString() ?? null },
        at: now,
      });

      const row = await tx.db.findUnique('family', { id: familyId });
      return serializeRow(row ?? {}, FAMILY_BIGINT_FIELDS);
    });
  }

  /** 移除成员（户主）或退出（本人） */
  async removeMember(memberId: bigint, actorId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const member = await tx.db.findUnique('familyMember', { id: memberId, deletedAt: null });
      if (!member) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const familyId = member['familyId'] as bigint;
      const now = await tx.db.dbNow();

      const isSelf = member['userId'] !== null && member['userId'] === actorId;
      if (!isSelf) await this.assertOwner(tx, familyId, actorId);
      if (member['role'] === 'OWNER') {
        throw new AppError(ErrorCode.FORBIDDEN, '户主不能退出，请先转让或解散家庭');
      }

      await tx.db.update('familyMember', { id: memberId }, { deletedAt: now, updatedAt: now });

      await tx.db.insert('changeLog', {
        id: tx.write.nextId(),
        entityType: 'family_member',
        entityId: memberId,
        familyId,
        tripId: null,
        op: 'DELETE',
        changedAt: now,
        createdAt: now,
      });

      return now;
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  private async assertOwner(tx: TxHandle, familyId: bigint, actorId: bigint): Promise<void> {
    const owner = await tx.db.findUnique('familyMember', {
      familyId,
      userId: actorId,
      role: 'OWNER',
      deletedAt: null,
    });
    if (!owner) throw new AppError(ErrorCode.FORBIDDEN, '仅户主可执行该操作');
  }

  private async assertMember(tx: TxHandle, familyId: bigint, actorId: bigint): Promise<void> {
    const m = await tx.db.findUnique('familyMember', {
      familyId,
      userId: actorId,
      deletedAt: null,
    });
    if (!m) {
      const managed = await tx.db.findMany('familyMember', {
        where: { familyId, managedBy: actorId, deletedAt: null },
      });
      if (managed.length === 0) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    }
  }

  private async displayNameOf(tx: TxHandle, userId: bigint): Promise<string> {
    const u = await tx.db.findUnique('user', { id: userId, deletedAt: null });
    return (u?.['nickname'] as string | undefined) ?? '成员';
  }

  private async uniqueInviteCode(tx: TxHandle): Promise<string> {
    const gen = this.o.generateInviteCode ?? (() => randomInviteCode());
    for (let i = 0; i < 8; i += 1) {
      const code = gen();
      const dup = await tx.db.findUnique('family', { inviteCode: code, deletedAt: null });
      if (!dup) return code;
    }
    throw new AppError(ErrorCode.INTERNAL_ERROR, '邀请码生成失败，请重试');
  }

  private async audit(
    tx: TxHandle,
    e: {
      actorId: bigint;
      action: string;
      reason: string;
      severity: 'INFO' | 'WARN' | 'ALERT' | 'CRITICAL';
      targetId: bigint;
      detail?: Record<string, unknown>;
      at: Date;
    },
  ): Promise<void> {
    await tx.db.insert('auditLog', {
      id: tx.write.nextId(),
      actorId: e.actorId,
      action: e.action,
      reason: e.reason,
      severity: e.severity,
      retainUntil: new Date(e.at.getTime() + this.retentionDays * 86_400_000),
      targetType: e.action.startsWith('family.member') ? 'family_member' : 'family',
      targetId: e.targetId,
      detail: e.detail ?? null,
      createdAt: e.at,
    });
  }
}
