# family-trip · M1 编码派发单交付概览

> ⚠️ **历史快照（2026-10-09，M1 公共层）**：文中「未建表 / 客户端仅占位 / 14 域
> 待 v1.4」等状态已被后续交付覆盖。当前架构与实现状态见仓库根目录
> [`README.md`](../README.md)。

> 依据 `DISPATCH-M1-CODE-2026-10-09` 完成「与数据模型无关」的工程初始化与公共层编码。
> 关系型栈（MySQL 8.4.3 + Prisma 6.19.3）为裁决选型，但 v1.4 未出 → **未建任何表**。

## Commit 历史（`main`）

| commit    | 内容                                                                        |
| --------- | --------------------------------------------------------------------------- |
| `84c4dcb` | 首次基线：工程骨架 + M2/M3/M4 公共层（41 文件）                             |
| `76ffb4c` | 修复 pnpm 11 构建脚本拦阻（`pnpm-workspace.yaml` 的 `allowBuilds` 置 true） |
| `9d51d0d` | 补齐 `common/` 分页 + 事务模块与 14 业务域目录骨架                          |

## 门禁结果（全部通过）

| 门禁            | 命令                            | 结果                                              |
| --------------- | ------------------------------- | ------------------------------------------------- |
| Lint            | `eslint .`                      | ✅ 0                                              |
| Typecheck       | `tsc -p tsconfig.json --noEmit` | ✅ 0                                              |
| Test            | `vitest run --no-cache`         | ✅ 90 passed / 5 files                            |
| Build           | `tsc -p tsconfig.build.json`    | ✅ 生成 dist                                      |
| M3 冒烟（prod） | `NODE_ENV=production` 无授权源  | ✅ `FxSourceMisconfiguredError` 拒绝启动 (exit 1) |
| M3 冒烟（dev）  | `NODE_ENV=development`          | ✅ `:3000/health` → 200 统一信封                  |

## 交付内容（派发单 §八 #1–9）

- **工程骨架**：pnpm workspace monorepo；`apps/server`（NestJS 10.4）、`apps/client`（Taro 4 占位）
- **`common/` 公共层**（§八 #2 要求的 7 项齐备）：
  - 鉴权 → `auth/`（access-policy，PRIVATE 短路）
  - 加解密 → `crypto/`（M2）
  - 幂等 → `idempotency/`
  - 错误码 → `errors/`
  - **分页 → `pagination/`**（页码 + 游标双模式，新增）
  - 汇率精度 → `fx/`（M3 + M4 + amount）
  - **事务 → `db/transaction.ts`**（5005 降级为单笔事务 + reconcile，新增）
  - 另：`envelope/`（统一信封）、`media/`（M5 + M6）、`middleware/`（统一链）
- **统一中间件链**（§八 #3）：8 段链路 `resolveIdentity → loadUser → withFamily → withTrip → withOwner → validate → handler → responseEnvelope`
- **`toBuffer()` 适配层 + 单测**（§八 #4）：含跨表搬运拒绝用例（AAD 含表标识）
- **M3 fail-fast + 单测**（§八 #5）
- **M4 汇率口径 + 缓存键 + 单测**（§八 #6）：含切档位不污染历史
- **M5 审计**（§八 #7）：保留期 ≥2 年（PIPL≥1 年取严）
- **M6 EXIF**（§八 #8）：服务端兜底剥离 + GPS 告警
- **首次 commit**（§八 #9）：已在可运行状态，M2/M3/M4 全部在内
- **14 业务域目录骨架**：`domains/`（按域组织，v1.3 §1.1）+ README 索引，handler 待 v1.4

## 验收口径（§六 8 项）与红线（§七 9 条）

- 8 项验收均已在测试/门禁中覆盖（M2 红线 R1、M3 fail-fast、M4 档位唯一、M5 保留期、M6 EXIF、统一信封、中间件链、审计）。
- 9 条红线中「禁止现在建表」「toBuffer 红线 R1」「AAD 含表标识」「盲索引同事务」「汇率档位唯一」等在代码与 ESLint 规则层双重封死。

## 待办（非本次范围，随 v1.4 推进）

- v1.4 出后：按数据模型建表（Prisma migrate）、14 业务域 handler 实现、KMS 接入 DEK、合规汇率授权源接入（解除 M3 fail-fast）。
- ⚠️ v1.4 引入 prisma / @prisma/client 时，其 postinstall 也需加入 `pnpm-workspace.yaml` 的 `allowBuilds`（否则重演构建脚本拦阻）。
- 用户真实环境 `pnpm install` 后 husky 的 `prepare` 会正式接管 `core.hooksPath`（沙箱内因 git 路径/wmic 拦截未自动接管，已用等效直连 bin 方案验证）。

## 本地运行

```bash
cd family-trip
pnpm install                 # 用户环境：安装依赖 + husky prepare
pnpm dev:server              # tsx watch src/main.ts，监听 :3000
curl http://localhost:3000/health   # {"code":0,"message":"ok","data":{"status":"up"}}
pnpm verify                  # lint && typecheck && test
```

> PowerShell 里 `curl` 是 `Invoke-WebRequest` 别名，须写完整 `http://` 前缀（或 `curl.exe`）。
