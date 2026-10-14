/**
 * Taro 编译配置 —— 微信小程序首发，H5 同构预留
 * ============================================================================
 * 设计宽度 375（与现有 375 逻辑宽容器一致），px→rpx 自动换算。
 * `process.env.API_BASE_URL` 由构建时注入：为空则走 Mock（默认），
 * 填了真后端地址则走 http adapter。切换只靠环境变量，不写死源码。
 */

import { defineConfig } from '@tarojs/cli';

export default defineConfig({
  projectName: 'family-trip-client',
  date: '2026-10-12',
  designWidth: 375,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    828: 1.81 / 2,
    375: 2,
  },
  sourceRoot: 'src',
  outputRoot: 'dist-h5',
  plugins: [],
  defineConstants: {
    'process.env.API_BASE_URL': JSON.stringify(process.env.API_BASE_URL ?? ''),
  },
  copy: {
    patterns: [],
    options: {},
  },
  framework: 'react',
  compiler: 'webpack5',
  cache: {
    enable: false,
  },
  mini: {
    postcss: {
      pxtransform: {
        enable: true,
        config: {},
      },
      cssModules: {
        enable: false,
        config: {
          namingPattern: 'module',
          generateScopedName: '[name]__[local]___[hash:base64:5]',
        },
      },
    },
  },
  h5: {
    publicPath: '/',
    staticDirectory: 'static',
    postcss: {
      autoprefixer: {
        enable: true,
      },
      pxtransform: {
        enable: true,
        config: {
          // page 选择器下的 px 不转 rpx（保持与小程序 page 根一致）
          selectorBlackList: ['page'],
        },
      },
      cssModules: {
        enable: false,
        config: {
          namingPattern: 'module',
          generateScopedName: '[name]__[local]___[hash:base64:5]',
        },
      },
    },
  },
  rn: {
    appName: 'family-trip-client',
    postcss: {
      cssModules: {
        enable: false,
      },
    },
  },
});
