/**
 * notify 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { ResolvedOwnership } from '../../common/middleware/chain.js';
import type { DomainContext } from '../domain-context.js';
import { NotifyService } from './notify.service.js';
import {
  createReminderSchema,
  listReminderQuerySchema,
  markReadSchema,
  registerSubscriptionSchema,
  updateReminderSchema,
  type CreateReminderInput,
  type ListReminderQueryInput,
  type MarkReadInput,
  type RegisterSubscriptionInput
} from './notify.schema.js';

export interface NotifyDomainOptions {
  ctx: DomainContext;
}

export interface NotifyDomain {
  routes: RouteSpec<never, unknown>[];
  service: NotifyService;
}

export function createNotifyDomain(o: NotifyDomainOptions): NotifyDomain {
  const service = new NotifyService({ ctx: o.ctx });
  /**
   * 🔴 归属维度必须透传链在 withOwner 段读到的 `resolved`。
   *    写死 `familyId: null` 会让 SHARED_FAMILY 判定永远失败——
   *    表现为「自己是成员却被 404」，是最难查的一类权限 bug。
   */
  const ref = (
    id: bigint,
    _req: unknown,
    resolved: ResolvedOwnership,
  ): { type: 'reminder_task'; id: bigint; familyId: bigint | null; tripId: bigint | null } => ({
    type: 'reminder_task',
    id,
    familyId: resolved.familyId,
    tripId: resolved.tripId,
  });

  const routes: RouteSpec<never, unknown>[] = [
    {
      method: 'POST',
      path: '/reminders',
      auth: { public: false, resourceType: 'reminder_task', mode: 'WRITE' },
      idParam: '__none__',
      schema: createReminderSchema as never,
      handler: async (ctx, input) => {
        const b = input as CreateReminderInput;
        const reminder = await service.createReminder(ctx.userId!, {
          receiverId: BigInt(b.receiverId),
          tripId: b.tripId !== undefined ? BigInt(b.tripId) : undefined,
          subscriptionId: b.subscriptionId !== undefined ? BigInt(b.subscriptionId) : undefined,
          title: b.title,
          content: b.content,
          remindAt: b.remindAt,
          tz: b.tz,
          delivery: b.delivery,
        });
        return { data: { reminder } };
      },
    },

    {
      method: 'GET',
      path: '/reminders',
      auth: { public: false, resourceType: 'reminder_task', mode: 'READ' },
      idParam: '__none__',
      schema: listReminderQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListReminderQueryInput;
        const r = await service.listReminders(ctx.userId!, {
          receiverId: q.receiverId !== undefined ? BigInt(q.receiverId) : undefined,
          tripId: q.tripId !== undefined ? BigInt(q.tripId) : undefined,
          status: q.status,
          dueOnly: q.dueOnly,
          from: q.from,
          to: q.to,
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    {
      method: 'POST',
      path: '/reminders/mark-read',
      auth: { public: false, resourceType: 'reminder_task', mode: 'WRITE' },
      idParam: '__none__',
      schema: markReadSchema as never,
      handler: async (ctx, input) => {
        const r = await service.markRead(ctx.userId!, (input as MarkReadInput).reminderIds);
        return { data: r, meta: { updatedAt: r.readAt } };
      },
    },

    {
      method: 'PATCH',
      path: '/reminders/:id',
      auth: { public: false, resourceType: 'reminder_task', mode: 'WRITE', ref },
      schema: updateReminderSchema as never,
      handler: async (ctx, input) => {
        const reminder = await service.updateReminder(ctx.userId!, ctx.resourceId!, input);
        return { data: { reminder } };
      },
    },

    {
      method: 'DELETE',
      path: '/reminders/:id',
      auth: { public: false, resourceType: 'reminder_task', mode: 'DELETE', ref },
      handler: async (ctx) => {
        const at = await service.removeReminder(ctx.userId!, ctx.resourceId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },

    // ── 订阅授权 ───────────────────────────────────────────
    {
      method: 'POST',
      path: '/subscriptions',
      auth: { public: false, resourceType: 'user', mode: 'WRITE' },
      idParam: '__none__',
      schema: registerSubscriptionSchema as never,
      handler: async (ctx, input) => {
        const b = input as RegisterSubscriptionInput;
        const subscription = await service.registerSubscription(ctx.userId!, {
          templateId: b.templateId,
          status: b.status,
          expireAt: b.expireAt,
          remainCount: b.remainCount,
        });
        return { data: { subscription } };
      },
    },

    {
      method: 'GET',
      path: '/subscriptions',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      handler: async (ctx) => {
        const r = await service.listSubscriptions(ctx.userId!);
        return { data: r };
      },
    },
  ];

  return { routes, service };
}
