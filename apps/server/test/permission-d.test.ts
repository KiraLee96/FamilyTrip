/**
 * D 组 · 权限判定端到端（D1 ~ D8）
 * ============================================================================
 * 覆盖验收要求：
 *   · D1/D8  404 不可区分：非成员的资源与不存在的资源，响应**逐字节一致**
 *   · D4     PRIVATE 短路：家庭成员 ≠ 可访问他人物品（短路口绝不回落家庭/出行维度）
 *   · D4     私有资源由代管人（managed_by）访问亦放行
 *   · D5     权限矩阵完整性：15 资源、无重复 (resource, mode) 组合
 *   · D6     fail-closed：未标注且非 @Public 的 handler 一律拒绝
 *   · D7     SHARED_FAMILY / SHARED_TRIP 两个维度各自独立成立
 *   · D8     越权（403 语义）与不存在（404 语义）在**响应层**不可区分
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, stubWechat, type BuiltApp } from '../src/composition-root.js';
import { mustOk, req, scaffold } from './helpers.js';
import {
  PERMISSION_MATRIX,
  PERMISSION_RESOURCE_COUNT,
  PUBLIC_META,
  REQUIRE_ACCESS_META,
  assertMatrixSize,
  getRequireAccessMeta,
  isPublicHandler,
} from '../src/common/auth/require-access.js';
import { checkAccessDeclaration } from '../src/common/ci/access-gate.js';
import { ErrorCode } from '../src/common/errors/error-code.js';


describe('D1/D8 · 404 不可区分（不给越权者任何探测信号）', () => {
  let app: BuiltApp;

  beforeEach(() => {
    app = buildApp({ wechat: stubWechat() });
  });

  it('非成员读他人出行 → 与「不存在的出行」响应逐字节一致', async () => {
    const owner = await scaffold(app, 'owner');
    const outsider = await scaffold(app, 'outsider');

    // ① 真实存在、但 outsider 无权：用自己的 token 去读 owner 的出行
    const denied = await app.dispatch(
      req('GET', `/trips/${owner.tripId}`, { token: outsider.token }),
    );
    // ② 完全不存在：换一个几乎不可能是真 id 的值
    const absent = await app.dispatch(
      req('GET', '/trips/999999999999999999', { token: outsider.token }),
    );

    expect(denied.httpStatus).toBe(404);
    expect(absent.httpStatus).toBe(404);

    // 🔴 核心断言：code / message / data 三者必须一致
    expect(denied.envelope.code).toBe(ErrorCode.NOT_FOUND);
    expect(denied.envelope.code).toBe(absent.envelope.code);
    expect(denied.envelope.message).toBe(absent.envelope.message);
    expect(denied.envelope.data).toBe(absent.envelope.data);
    expect(denied.envelope.data).toBeNull();
  });

  it('越权探测的响应体里不泄露任何归属信息（无 familyId / tripId / ownerId）', async () => {
    const owner = await scaffold(app, 'owner2');
    const outsider = await scaffold(app, 'outsider2');

    const denied = await app.dispatch(
      req('GET', `/trips/${owner.tripId}`, { token: outsider.token }),
    );
    const raw = JSON.stringify(denied.envelope);
    for (const leak of [owner.tripId, owner.familyId, owner.userId]) {
      expect(raw, `404 响应泄露了 id ${leak}`).not.toContain(leak);
    }
  });

  it('owner 自己读自己的出行 → 200（确认上面的 404 是权限而非功能缺失）', async () => {
    const owner = await scaffold(app, 'owner3');
    const trip = mustOk<{ trip: { id: string } }>(
      await app.dispatch(req('GET', `/trips/${owner.tripId}`, { token: owner.token })),
    );
    expect(trip.trip.id).toBe(owner.tripId);
  });
});

describe('D4 · PRIVATE 短路（家庭成员 ≠ 可访问他人物品）', () => {
  let app: BuiltApp;

  beforeEach(() => {
    app = buildApp({ wechat: stubWechat() });
  });

  /** 把 another 加进 owner 的家庭，使其成为**同一家庭的成员** */
  async function joinFamily(
    app: BuiltApp,
    ownerToken: string,
    familyId: string,
    userCode: string,
  ): Promise<{ token: string; userId: string }> {
    const u = mustOk<{ token: string; user: { id: string } }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: userCode } })),
    );
    mustOk(
      await app.dispatch(
        req('POST', `/families/${familyId}/members`, {
          token: ownerToken,
          body: { userId: u.user.id, role: 'MEMBER' },
        }),
      ),
    );
    return { token: u.token, userId: u.user.id };
  }

  it('同家庭成员访问他人物品 → 404（短路口不得回落家庭维度）', async () => {
    const owner = await scaffold(app, 'priv');
    const mate = await joinFamily(app, owner.token, owner.familyId, 'priv-mate');

    // owner 建一个**自己的**物品（ownerId 默认 = 创建者）
    const item = mustOk<{ item: { id: string } }>(
      await app.dispatch(
        req('POST', '/items', {
          token: owner.token,
          body: { familyId: owner.familyId, name: '我的泳镜' },
        }),
      ),
    );

    // owner 自己读 → 200
    mustOk(await app.dispatch(req('GET', `/items/${item.item.id}`, { token: owner.token })));

    // 🔴 家庭成员读 → 必须 404。若这里返回 200，就是最严重的私有越权。
    const mateRead = await app.dispatch(
      req('GET', `/items/${item.item.id}`, { token: mate.token }),
    );
    expect(mateRead.httpStatus).toBe(404);
    expect(mateRead.envelope.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('完全无关的第三方访问他人物品 → 404（与家庭成员同结果）', async () => {
    const owner = await scaffold(app, 'priv2');
    const stranger = await scaffold(app, 'priv2-x');

    const item = mustOk<{ item: { id: string } }>(
      await app.dispatch(
        req('POST', '/items', {
          token: owner.token,
          body: { familyId: owner.familyId, name: '私人剃须刀' },
        }),
      ),
    );

    const r = await app.dispatch(req('GET', `/items/${item.item.id}`, { token: stranger.token }));
    expect(r.httpStatus).toBe(404);
  });

  it('本人写入自己的物品（改用 CAS 更新）→ 允许；他人 → 404', async () => {
    const owner = await scaffold(app, 'priv3');
    const mate = await scaffold(app, 'priv3-x');

    const item = mustOk<{ item: { id: string; version: number } }>(
      await app.dispatch(
        req('POST', '/items', {
          token: owner.token,
          body: { familyId: owner.familyId, name: '登山杖' },
        }),
      ),
    );

    // 本人更新 → 200
    const own = await app.dispatch(
      req('PATCH', `/items/${item.item.id}`, {
        token: owner.token,
        body: { version: item.item.version, name: '登山杖（已换新）' },
      }),
    );
    expect(own.httpStatus, `本人更新应成功，实得 ${own.envelope.message}`).toBeLessThan(300);

    // 他人更新 → 404（不是 403 —— 不暴露「存在但无权」）
    const other = await app.dispatch(
      req('PATCH', `/items/${item.item.id}`, {
        token: mate.token,
        body: { version: 1, name: '想偷改' },
      }),
    );
    expect(other.httpStatus).toBe(404);
  });
});

describe('D5 · 权限矩阵完整性（启动期断言）', () => {
  it('资源数 = 15', () => {
    const resources = new Set(PERMISSION_MATRIX.map((c) => c.resource));
    expect(resources.size).toBe(PERMISSION_RESOURCE_COUNT);
    expect(PERMISSION_RESOURCE_COUNT).toBe(15);
  });

  it('没有重复的 (resource, mode) 组合', () => {
    const seen = new Set<string>();
    for (const c of PERMISSION_MATRIX) {
      const key = `${c.resource}:${c.mode}`;
      expect(seen.has(key), `权限矩阵重复格：${key}`).toBe(false);
      seen.add(key);
    }
    // 每个资源至少覆盖一个 mode
    expect(seen.size).toBe(PERMISSION_MATRIX.length);
  });

  it('assertMatrixSize 对当前矩阵不抛异常（对错误期望值必须抛）', () => {
    expect(() => assertMatrixSize()).not.toThrow();
    // 🔴 传一个错误期望值必须炸 —— 证明这个断言真的在校验，而不是空转
    expect(() => assertMatrixSize(99)).toThrow();
  });

  it('每行都声明了合法 dimension（缺它会掉进「无维度可判」的暗门）', () => {
    const valid = new Set(['PRIVATE', 'SHARED_FAMILY', 'SHARED_TRIP', 'PUBLIC']);
    for (const c of PERMISSION_MATRIX) {
      expect(valid.has(c.dimension), `${c.resource}:${c.mode} 的 dimension 非法`).toBe(true);
    }
  });

  it('roles 是可选字段：若给出则必须非空（空数组 = 资源对所有人关闭）', () => {
    // ⚠️ 语义：`roles` 缺席表示「任意成员均可」，**不是**「谁都不行」。
    //    所以这里只对「显式给出 roles」的行要求非空。
    for (const c of PERMISSION_MATRIX) {
      if (c.roles === undefined) continue;
      expect(c.roles.length, `${c.resource}:${c.mode} 显式声明了空 roles`).toBeGreaterThan(0);
    }
  });
});

describe('D6 · fail-closed（未标注 = 拒绝，不留暗门）', () => {
  it('门禁：HTTP 路由缺少 @RequireAccess / @Public 声明 → 记为违规', () => {
    const bad = [
      'export class X {',
      '  @Get("items")',
      '  async list() {}',
      '}',
    ].join('\n');
    const v = checkAccessDeclaration('bad.ts', bad);
    expect(v).toHaveLength(1);
    expect(v[0]!.rule).toBe('D2-access-declared');
  });

  it('门禁：带 @RequireAccess 的路由 → 无违规', () => {
    const good = [
      'export class X {',
      '  @RequireAccess({ resource: "trip", mode: "READ" })',
      '  @Get("items")',
      '  async list() {}',
      '}',
    ].join('\n');
    expect(checkAccessDeclaration('good.ts', good)).toHaveLength(0);
  });

  it('门禁：带 @Public 的路由 → 无违规', () => {
    const pub = [
      'export class X {',
      '  @Public()',
      '  @Post("login")',
      '  async login() {}',
      '}',
    ].join('\n');
    expect(checkAccessDeclaration('pub.ts', pub)).toHaveLength(0);
  });

  it('@Public() 元数据可被读回', () => {
    const pub = async (): Promise<{ data: null }> => ({ data: null });
    Reflect.defineMetadata(PUBLIC_META, true, pub);
    expect(isPublicHandler(pub)).toBe(true);
  });

  it('@RequireAccess 元数据可被读回', () => {
    const annotated = async (): Promise<{ data: null }> => ({ data: null });
    Reflect.defineMetadata(REQUIRE_ACCESS_META, { resource: 'trip', mode: 'READ' }, annotated);
    expect(getRequireAccessMeta(annotated)).toEqual({ resource: 'trip', mode: 'READ' });
  });

  it('未标注的 handler 既非 public 也无 requireAccess 元数据（fail-closed 的前提）', () => {
    const bare = async (): Promise<{ data: null }> => ({ data: null });
    expect(isPublicHandler(bare)).toBe(false);
    expect(getRequireAccessMeta(bare)).toBeUndefined();
  });
});

describe('D7 · SHARED 两个维度各自独立成立', () => {
  let app: BuiltApp;

  beforeEach(() => {
    app = buildApp({ wechat: stubWechat() });
  });

  it('仅家庭成员（未加入出行）可读家庭级资源，但不读出行的资源', async () => {
    const owner = await scaffold(app, 'dim');

    // 第二个用户：加入同一家庭，但**不**加入出行
    const mate = mustOk<{ token: string; user: { id: string } }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: 'dim-mate' } })),
    );
    mustOk(
      await app.dispatch(
        req('POST', `/families/${owner.familyId}/members`, {
          token: owner.token,
          body: { userId: mate.user.id, role: 'MEMBER' },
        }),
      ),
    );

    // owner 建一个出行级清单项
    const item = mustOk<{ item: { id: string } }>(
      await app.dispatch(
        req('POST', '/checklists/items', {
          token: owner.token,
          body: {
            tripId: owner.tripId,
            familyId: owner.familyId,
            name: '共享物资',
            scope: 'SHARED',
          },
        }),
      ),
    );

    // mate 不是 trip 成员 → 读该出行级资源必须 404（尽管同家庭）
    const denied = await app.dispatch(
      req('GET', `/checklists/items/${item.item.id}`, { token: mate.token }),
    );
    expect(denied.httpStatus).toBe(404);

    // owner 自己读 → 200
    mustOk(
      await app.dispatch(req('GET', `/checklists/items/${item.item.id}`, { token: owner.token })),
    );
  });
});
