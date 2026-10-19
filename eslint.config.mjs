// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.git/**',
      '**/coverage/**',
      '**/*.min.js',
      // 微信云函数：CommonJS JS，运行在云运行时（非 TS 项目、非本仓库构建链），
      // 不纳入 typescript-eslint projectService 管辖；改动走人工审查 + 云函数自身部署校验
      'cloudfunctions/**',
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
