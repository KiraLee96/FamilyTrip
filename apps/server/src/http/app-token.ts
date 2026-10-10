/**
 * DI 令牌（独立叶子模块）
 * ============================================================================
 * 🔴 为什么单独一个文件，而不是放在 `app.module.ts` 里：
 *
 *   `http-adapter.controller.ts` 需要 `APP_TOKEN` 做 `@Inject()`，而
 *   `app.module.ts` 又要 import 这个 controller —— 二者构成循环依赖：
 *
 *       app.module  →  http-adapter.controller  →  app.module
 *
 *   在原 ESM 求值顺序下这个环「恰好」没炸；但只要**新增一条入口 import**
 *   （例如 `main.ts` 引入 `composition-root`），求值顺序就会改变，导致
 *   `APP_TOKEN` 在被 `@Inject()` 读取时仍处于 TDZ，抛出：
 *
 *       ReferenceError: Cannot access 'APP_TOKEN' before initialization
 *
 *   而这类错误的特点是：`tsc` 全过、单测全过（测试走的是另一条 import 路径），
 *   只在**真正跑构建产物**时炸。故根治方式是把令牌提到叶子模块，
 *   让依赖图变成单向：controller → token ← app.module（无环）。
 */

/** 组合根产出的 `BuiltApp` 实例在容器里的令牌 */
export const APP_TOKEN = 'FAMILY_TRIP_APP';
