/**
 * Vitest 全局前置。
 *
 * 🔴 必须在这里引入 `reflect-metadata`。
 *
 *    项目里有两处依赖 `Reflect.defineMetadata` / `Reflect.getMetadata`：
 *      ① NestJS 装饰器（`@Controller` / `@All` …）
 *      ② 自研权限标注（`@RequireAccess` / `@Public`，见 common/auth/require-access.ts）
 *
 *    生产入口 `main.ts` 顶部有 `import 'reflect-metadata'`，但**测试代码不会走 main.ts**。
 *    缺了它，装饰器一加载就 `TypeError: Reflect.defineMetadata is not a function` ——
 *    而这类错误只在「真正 import 到那条路径」时才暴露，很容易被误判为「测试写错」。
 *
 *    polyfill 必须在**任何模块加载前**生效，所以放在 setupFiles 而不是某个 test 文件里。
 */

import 'reflect-metadata';
