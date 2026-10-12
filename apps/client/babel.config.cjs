/**
 * Babel 配置 —— Taro 4.x（React + TypeScript + webpack5）
 * 预设名 `taro` 即 babel-preset-taro，由 Taro CLI 自动解析。
 */

module.exports = {
  presets: [
    [
      'taro',
      {
        framework: 'react',
        ts: true,
        compiler: 'webpack5',
        useBuiltIns: process.env.TARO_ENV === 'h5' ? 'usage' : false,
      },
    ],
  ],
};
