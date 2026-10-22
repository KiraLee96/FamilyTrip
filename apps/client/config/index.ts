/**
 * Taro 编译配置 —— 微信小程序首发，H5 同构预留
 * ============================================================================
 * 设计宽度 375（与现有 375 逻辑宽容器一致），px→rpx 自动换算。
 * `process.env.API_BASE_URL` 由构建时注入：为空则走 Mock（默认），
 * 填了真后端地址则走 http adapter。切换只靠环境变量，不写死源码。
 */

import { defineConfig } from '@tarojs/cli';

/**
 * 产物目录按平台分流。
 * 小程序必须落在 `dist/` —— project.config.json 的 miniprogramRoot 指向 dist/，
 * 否则微信开发者工具打开的是上一次的旧产物（曾出现「改了 app.config 但工具里 tab 没变」的假象）。
 * H5 保持 dist-h5/ 不变（沿用既有预览脚本）。
 */
const isH5 = process.env.TARO_ENV === 'h5';
const outputRoot = isH5 ? 'dist-h5' : 'dist';

/**
 * API 基址（构建期常量，见下方 defineConstants）
 *
 * 优先级：显式 `API_BASE_URL` > 生产默认值 > 空（Mock）
 *   - `taro build`（NODE_ENV=production）→ 默认指向**线上后端**，不需要额外环境变量。
 *     🔴 这条是硬性修正：此前生产基址只能靠命令行传 env，一旦漏传就静默回落 Mock，
 *        表现为「包上传上去了但数据还是假的」（2026-10-22 实际踩过）。
 *   - `taro dev:weapp`（watch）→ 默认空 = 走 Mock，本地联调不受线上数据干扰；
 *     想让本地连线上后端，显式传 API_BASE_URL 即可。
 */
const PROD_API_BASE_URL = 'https://api.familytripallinone.cn/api';
const isProdBuild = process.env.NODE_ENV === 'production';
const apiBaseUrl = process.env.API_BASE_URL ?? (isProdBuild && !isH5 ? PROD_API_BASE_URL : '');

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
  outputRoot,
  plugins: [],
  defineConstants: {
    'process.env.API_BASE_URL': JSON.stringify(apiBaseUrl),
  },
  copy: {
    /**
     * 地图标记图标按「静态拷贝」处理，不走 webpack 图片管线。
     * 原因：小程序 <map> 的 marker.iconPath 只认包内文件路径 / 网络地址，
     * webpack 默认把小图内联成 base64 data URI（Taro 4 的 imageUrlLoaderOption
     * 对小图内联未生效），会导致标记图标不显示。
     * 拷贝后以包内绝对路径 `/assets/marker.png` 引用（见 TripDetailPage）。
     */
    patterns: [{ from: 'src/assets/marker.png', to: `${outputRoot}/assets/marker.png` }],
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
