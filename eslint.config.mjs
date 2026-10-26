// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      // 构建产物目录的历史变体（如 `apps/client/dist-h5-dead`）。它们同样是
      // 打包结果、不属任何 tsconfig program，projectService 会报解析错误。
      '**/dist-*/**',
      '**/build/**',
      '**/.git/**',
      '**/coverage/**',
      '**/*.min.js',
      // 微信云函数：CommonJS JS，运行在云运行时（非 TS 项目、非本仓库构建链），
      // 不纳入 typescript-eslint projectService 管辖；改动走人工审查 + 云函数自身部署校验
      'cloudfunctions/**',
      // 验收 / 探针脚本：纯 CommonJS `.cjs`，不属于任何 tsconfig 的 program，
      // projectService 会直接报 "not found by the project service" 解析错误。
      // 这些脚本的价值在「能被 node 直接跑起来取证」，其正确性由运行结果保证，
      // 不由类型检查保证 —— 与 cloudfunctions 同一口径。
      '**/*.cjs',
      '**/.verify/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs', '*.config.mjs', '*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  // ─────────────────────────────────────────────────────────────
  //红线 R1：加密字段读取必须经 toBuffer()
  // Prisma 从 MySQL 读回 VARBINARY 是裸 Uint8Array，直接传给 crypto 层
  // 会静默失败且不报错。此规则在语法层封死这一类写法。
  // ─────────────────────────────────────────────────────────────
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/common/crypto/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='update'] > Identifier[name='decipher']",
          message:
            '红线 R1：decipher.update() 禁止直接传 Prisma 返回的 Uint8Array，必须先经 toBuffer()。',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'apps/client/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // 测试 mock 普遍是「实现异步接口但体内无 await」的同步桩，require-await 误报
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // 工程配置文件本身不参与业务类型校验，关闭类型感知的 unsafe 规则
    files: [
      '*.config.mjs',
      '*.config.ts',
      'eslint.config.mjs',
      'vitest.config.ts',
      'vitest.config.mts',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  prettier,
);
