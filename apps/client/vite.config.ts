import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * H5 原型构建配置。
 *
 * 说明：本工程是「界面雏形验证」用途，用浏览器直接看效果；
 * 正式客户端将走 Taro 4.x 编译微信小程序（见 README.md）。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
