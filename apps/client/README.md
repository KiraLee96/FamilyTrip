# @family-trip/client

家庭出行计划客户端。**微信小程序首发，H5 同构预留**。

> 项目总览（架构、后端、部署、需求完成度评估）见仓库根目录
> [`README.md`](../../README.md)。本文件只说明客户端。

## 技术栈

- Taro 4.x + React 18 + TypeScript（`strict: true`）
- 编译目标：`weapp`（首发）/ `h5`（预留）
- 测试：Vitest（`utils/` 与 `api/` 纯逻辑）

## 目录

```text
src/
├── api/          # ApiClient 接口 + mock / http 两套实现 + 信封解析
├── pages/        # 12 个页面（5 个 tab + 7 个二级页）
├── components/   # Calendar / ChecklistPanel / RegionPicker 等 13 个组件
├── hooks/        # useAsync / useSession / useFxRate
├── nav/          # 逻辑路径 → Taro 页面栈的统一导航抽象
├── utils/        # 日期、节假日、账单解析、清单粘贴、汇率、上传、预览
└── styles/       # theme.css
```

页面与路由映射见 `src/app.config.ts` 和 `src/nav/index.ts`。

## 数据源：Mock ↔ 真后端

界面只依赖 `api/client.ts` 的 `ApiClient` 接口，数据来源由构建期常量
`API_BASE_URL` 决定（`config/index.ts`）：

| `API_BASE_URL` | 数据源 | 用途                                                  |
| -------------- | ------ | ----------------------------------------------------- |
| 空             | Mock   | `pnpm dev:client` 直接看完整界面，无需后端            |
| 非空           | HTTP   | `Taro.request` 打真后端，信封/鉴权/幂等与 Mock 同接口 |

```bash
# H5（默认 Mock）
pnpm dev:client

# 小程序（微信开发者工具打开 apps/client/dist）
pnpm --filter @family-trip/client run dev:weapp

# 连本地后端（真机不能用 127.0.0.1，要填电脑局域网 IP）
API_BASE_URL=http://<电脑IP>:3000/api \
  pnpm --filter @family-trip/client run build:weapp
```

生产小程序构建（`NODE_ENV=production` 且非 H5）默认指向
`https://api.familytripallinone.cn/api`，避免漏传环境变量时静默回落 Mock。

> **Mock 全绿只证明界面能渲染，不证明业务可用**：Mock 会跳过上传与后端
> schema 校验。涉及上传、权限、字段落库的改动必须连真后端再验一遍。

## 常用命令

```bash
pnpm --filter @family-trip/client run typecheck   # tsc --noEmit
pnpm --filter @family-trip/client run test        # vitest
pnpm --filter @family-trip/client run build:weapp # 小程序产物 dist/
pnpm --filter @family-trip/client run build:h5    # H5 产物 dist-h5/
```

## 相关文档

- [`HANDOFF.md`](HANDOFF.md) —— 交接与真机走查步骤
- [`STYLE_ADAPTATION.md`](STYLE_ADAPTATION.md) —— 样式 / 多端适配说明
- [`../server/`](../server/) —— 后端实现
