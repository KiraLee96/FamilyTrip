import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // 🔴 reflect-metadata 必须最先加载：NestJS 装饰器与 @RequireAccess/@Public
    //    都依赖 Reflect.*Metadata，缺了它会在 import 期直接抛 TypeError。
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    // 单线程池：本套件是纯内存集成测试（毫秒级），并发收益极小；
    // 而 vitest 的默认 worker 池在 Windows 上会去调 wmic.exe 探测 CPU，
    // 在受限/沙箱环境里必然失败，并连带把「尚未收集完」的测试文件静默丢弃
    // （表现为「跑过 137 个用例，剩 44 个不见了」）。串行执行可完全规避。
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
    // 关掉 SSR 转译缓存的落盘：写临时目录在受限环境下会 EPERM。
    // 本套件规模小，重复转译的开销可忽略。
    cache: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/domains/**'],
    },
  },
});
