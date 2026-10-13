/**
 * 极简 .env 加载器（零依赖，兼容所有 Node 版本）。
 *
 * 🔴 为什么需要它：
 *   仓库约定「本地配置放 apps/server/.env，参照 .env.example」，但此前代码
 *   从未加载 .env（无 dotenv、无 --env-file），导致 .env 是死配置——文件存在
 *   也不会被读取。本模块在进程最早阶段把 .env 注入 process.env。
 *
 * ⚠️ 仅当变量未被 shell 显式设置时才填充（shell 环境优先），避免覆盖 CI/部署变量。
 * ⚠️ 必须在任何读取 process.env 的模块之前 import（main.ts 第一行）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');

if (existsSync(ENV_PATH)) {
  const raw = readFileSync(ENV_PATH, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
