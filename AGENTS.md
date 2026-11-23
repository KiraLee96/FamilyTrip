# FamilyTrip 项目规则（Codex）

## 这是什么

家庭出行计划：微信小程序首发，H5 预留。用户是家人和小团体，核心功能是心愿池、行程、回忆、账本／汇率和长图分享。
生产 API：`https://api.familytripallinone.cn`，仓库 `KiraLee96/FamilyTrip`，主分支 `main`。

## 结构与技术栈

- `apps/client`：Taro 4 + React 18，同构微信小程序与 H5。
- `apps/server`：NestJS 10 + Prisma 6.19.3 + MySQL 8.4.3，按领域拆在 `src/domains/`。
- `cloudfunctions`：微信云函数；`deploy`：上线手册、nginx、pm2、MySQL 配置；`qa`：用例、追踪、探针、报告；`docs`：方案与交付说明；`.ai-memory`：每日工作记忆。
- pnpm 11 workspace，Node >= 20.11，vitest 测试，ESLint 9 + Prettier + husky + lint-staged，CI 用 GitHub Actions。

## 本地开发

- 一键环境：双击 `start-dev.cmd`，起本地 MySQL（3306）和 server（3000，tsx watch）。
- 或：`pnpm dev:server`；客户端 H5 `pnpm dev:client`；小程序 `pnpm --filter @family-trip/client run dev:weapp`。
- 客户端接口基址：不设 `API_BASE_URL` 时默认连线上后端（`https://api.familytripallinone.cn/api`），dev watch 也一样；显式设空串才回 Mock（仅离线原型）；设其他值原样透传。
  本地联调必须显式 `API_BASE_URL=http://127.0.0.1:3000/api`，否则会读到线上数据、写操作会打到线上。
- 小程序真机：`start-dev.cmd` 里的 LAN 地址是 10.23.30.90，换网络后重设 `API_BASE_URL` 并重新 `taro build --type weapp`；微信开发者工具导入 `apps/client`。

## 验证（改完必须）

- `pnpm run verify`（lint + typecheck + test）必须通过；CI 另跑 `prisma validate` / `prisma generate`、server build、`build:weapp`、`build:h5`。
- 后端改动直接读真实返回：本地 `/health` 应为 `{"code":0,"message":"ok","data":{"status":"up"}}`，业务接口按统一信封 `{code,message,data}` 检查。
- 前端改动：H5 用 `.verify/server.cjs` 起静态服务（默认 5317）在浏览器里点一遍；断言限定在 `.taro_page_show:visible` 作用域（keep-alive 隐藏页会同时命中）。
- 小程序端真机走查需要人工完成，不能跑就明确写「未验证：小程序真机」。
- 发布前按 `qa/README.md` 第六节清单过：追踪表无 NOT RUN、P0/P1 归零、门禁四项达标。

## 数据

- Prisma schema 在 `apps/server/prisma/schema.prisma`，迁移在 `prisma/migrations/`（已有 12 个）。改数据模型必须带迁移，并在真 MySQL 上 `prisma migrate deploy` 验证。
- 不直接改线上库；生产 MySQL 在腾讯云轻量服务器上。
- 既有硬约束（详见 `docs/OVERVIEW.md`）：统一响应信封、固定中间件链、加密与 DEK、审计保留 ≥ 2 年、汇率档位唯一、EXIF 服务端剥离、PIPL 隐私合规、不现场建表。
- 幂等、change_log、审计、加解密都是既有机制，沿用，不绕过。

## 部署

- 生产：pm2 进程 `family-trip`，cwd `/home/ubuntu/family-trip/apps/server`，端口 3010，nginx `api.familytripallinone.cn`，证书 certbot 自动续期。
- 同机还有 XLFamily（:3000）和 food-api（:5050）：任何操作都不能碰这两个服务。
- 发布：看 `deploy/DEPLOY.md` 和 `deploy/上线手册-2026-11-12.md`。服务器上 `git pull` → `prisma migrate deploy` → `pm2 restart family-trip`，再核实 `https://api.familytripallinone.cn/health` 和关键页面。
- 发布、重启、切流量直接做；停 MySQL、删数据、动 DNS／证书、改权限先问。
- 回滚：`pm2 stop family-trip` + 摘 nginx 站点（数据不动），不要轻易停 MySQL。
- 小程序发版：微信开发者工具上传、后台提审／发布；request 合法域名已配；位置信息隐私声明在微信后台勾选（他本人操作）。

## 文案

- 面向家庭用户，含长辈和孩子：简体中文、口语、不用技术词、不堆 emoji；错误提示写清发生了什么、该怎么办。
- 改文案先搜同类页面、空状态、错误提示和按钮，一起改；小程序与 H5 两端文案保持一致。

## 提交与文档

- 提交信息用中文，沿用 `feat(scope):`／`fix(scope):`／`chore(scope):` 格式；push 到 main 触发 CI，合并前本地 verify 已通过。
- 不提交密钥和 `.env`；日志、报告里不要打印 token。
- 不写复述代码的文档。方案、交付说明放 `docs/`，派发单命名沿用 `派发单-D-YYYY-MM-DD-NN-说明.md`。
- 任务结束在 `.ai-memory/YYYYMMDD/daily.md` 追加：动作、决策（含撤销条件）、验证、未验证、派工单。

## 项目特有的坑

- pnpm 11 的构建脚本白名单在 `pnpm-workspace.yaml` 的 `allowBuilds`：新增带 postinstall 的依赖要显式列，否则 install 直接失败。
- 受限沙箱里 pnpm 可能因调用 `wmic` 被拦而失败；先正常跑，失败就直接调 `node_modules` 里的 CLI，或申请更高权限。
- 本机走代理时本地 curl 加 `--noproxy '*'`。
- husky 的 `prepare` 会接管 `core.hooksPath`。
- 现有 QA 资源直接复用：`qa/cases` 用例、`qa/tracking` 状态、`qa/probes` 探针、`qa/reports` 报告。
