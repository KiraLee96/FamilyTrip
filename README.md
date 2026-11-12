# 家庭出行计划 · FamilyTrip（旅行管家 AllInOne）

> 面向家庭的出行规划工具：微信小程序首发，H5 预留。pnpm monorepo。
>
> 本文档说明**当前代码的架构与实现**，并基于 `docs/` 中的需求与派发单，给出
> **尚未闭环的需求清单**。基线：2026-11-11 工作区代码（`0391872`）。文档与代码
> 不一致时，以代码为准。

---

## 目录

- [1. 项目概览](#1-项目概览)
- [2. 仓库结构](#2-仓库结构)
- [3. 后端架构](#3-后端架构)
- [4. 客户端架构](#4-客户端架构)
- [5. 数据模型](#5-数据模型)
- [6. 关键机制的实现方式](#6-关键机制的实现方式)
- [7. 本地开发](#7-本地开发)
- [8. 测试与质量门禁](#8-测试与质量门禁)
- [9. 构建与部署](#9-构建与部署)
- [10. 文档索引](#10-文档索引)
- [11. 需求完成度评估](#11-需求完成度评估)
- [12. 已知限制](#12-已知限制)

---

## 1. 项目概览

| 层       | 选型                                                     |
| -------- | -------------------------------------------------------- |
| 客户端   | Taro 4.x + React 18 + TypeScript（微信小程序 / H5 同构） |
| 后端     | NestJS 10 + TypeScript，按域组织                         |
| 数据库   | MySQL 8（Prisma 6.19）                                   |
| 校验     | Zod（后端入参）                                          |
| 测试     | Vitest（前端纯逻辑 + 后端集成）                          |
| 包管理   | pnpm workspace（`apps/*`）                               |
| 媒体存储 | 本地磁盘 + nginx 直出（`ObjectStorage` 接口预留云存储）  |
| 定时任务 | 进程内 `setInterval`（当前单 pm2 实例）                  |

产品范围：账号与家庭、心愿池、年度规划与行程、行程安排 / 预订、清单与穿搭、
花销与多币种、回忆归档、提醒、媒体、节假日、汇率、增量同步。

当前实现不是「原型占位」：12 个客户端页面、106 条后端路由、28 张表、9 个迁移
均已落地。未完成项集中在**客户端功能入口**与**生产级基础设施**，详见
[第 11 节](#11-需求完成度评估)。

---

## 2. 仓库结构

```text
.
├── apps/
│   ├── server/                 # NestJS 后端
│   │   ├── prisma/
│   │   │   ├── schema.prisma   # 28 个 model
│   │   │   └── migrations/     # 9 个迁移（含邀请码 / 清单版本 / 预算 / 头像解耦）
│   │   ├── src/
│   │   │   ├── main.ts         # 启动装配 + fail-fast + 定时器 + 媒体路由
│   │   │   ├── app.module.ts   # Nest 根模块（组合根封装）
│   │   │   ├── composition-root.ts
│   │   │   ├── common/         # 公共层（鉴权/加密/事务/汇率/媒体/同步/调度…）
│   │   │   ├── domains/        # 16 个业务域
│   │   │   ├── health/         # /health
│   │   │   └── http/           # Nest ⇄ dispatcher 适配
│   │   ├── test/               # 集成测试（内存驱动）
│   │   └── .verify/            # 真驱动 / 生产自检脚本
│   └── client/                 # Taro 客户端
│       ├── config/             # Taro 编译配置
│       ├── src/
│       │   ├── api/            # ApiClient 接口 + mock/http 两套实现
│       │   ├── pages/          # 12 个页面
│       │   ├── components/     # 13 个通用组件
│       │   ├── hooks/          # useAsync / useSession / useFxRate
│       │   ├── nav/            # H5 / 小程序统一导航抽象
│       │   ├── utils/          # 纯逻辑（可单测）
│       │   └── styles/
│       └── .verify/            # 端到端 / 验收脚本
├── cloudfunctions/             # 微信云函数（仅 fx-rate，备选方案）
├── deploy/                     # 生产部署 Runbook / nginx / pm2 模板
├── docs/                       # 架构说明、派发单、交付说明、参考方案
├── qa/                         # 用例、缺陷单、测试报告、探针
└── TP-02-交付物/               # 早期派发单与待做清单
```

---

## 3. 后端架构

### 3.1 请求链路

后端没有把鉴权、校验、业务逻辑散落在 controller 里，而是统一收敛到一条链：

```text
Taro 客户端
  │  HTTPS + JSON，Authorization: Bearer <token>，写请求带 requestId
  ▼
NestJS HttpAdapterController（@All('/api/*')，只做转发）
  │  取 method/path/headers/query/body
  ▼
dispatcher（按 method + path 匹配路由表）
  ▼
8 段中间件链
  1 resolveIdentity  → 解析 token，得到 userId / openid
  2 loadUser         → 用户存在且未注销
  3 withFamily       → 所属家庭集合
  4 withTrip         → 参与行程与 accessLevel
  5 withOwner        → 读资源行归属（familyId / tripId / ownerId）
  6 validate         → Zod 校验入参（鉴权之后）
  7 handler          → 业务逻辑（域 service）
  8 responseEnvelope → 统一信封 + meta.updatedAt / serverTime
  ▼
{ code, message, data, meta }
  code = 0 成功；4xxxx 客户端错误；5xxxx 服务端错误
```

关键设计：

- **controller 是薄的**：`http-adapter.controller.ts` 除转发外没有业务分支，
  `common/ci/access-gate.ts` 对这一点做静态校验。
- **出参形状唯一**：成功、401、403、404、422、409、500 一律同形信封；客户端只需
  一套解析逻辑。
- **越权与不存在同形**：资源类 404 返回逐字节一致的 `4040`，防 ID 枚举。
  唯一破例是邀请码 `4041`（用户输入的凭据，不构成枚举面，需要可行动的文案）。
- **BigInt 出口兜底**：`main.ts` 给 Express 装了 `bigintSafeReplacer`；域层另有
  `*_BIGINT_FIELDS` 白名单。真 MySQL 下漏列只会退化成「多一个字符串字段」，不会 500。

### 3.2 组合根与数据驱动

`composition-root.ts` 是唯一把基础设施和业务域装配到一起的地方：

```text
buildApp(options)
  ① 权限矩阵断言（78 格）
  ② 汇率授权源白名单
  ③ 选驱动：options.driver > 进程登记位 > MemoryTableDriver
  ④ createChainDeps        → 8 段链的 7 个依赖
  ⑤ createDomainContext    → 域共享的读 / 事务 / 软删句柄
  ⑥ 16 个 create<Domain>() → routes + service
  ⑦ dispatcher             → 汇总路由并断言无重复
```

`buildApp` 是纯同步装配函数，不做 I/O。驱动选择在 `main.ts` 中经由
`resolveAppDriver()` 完成：

| 条件                       | 结果                                       |
| -------------------------- | ------------------------------------------ |
| 显式注入 driver            | 使用注入的驱动（测试）                     |
| 有 `DATABASE_URL`          | `PrismaTableDriver`（生产路径）            |
| 无 `DATABASE_URL` + 非生产 | `MemoryTableDriver`（本地/测试，重启即丢） |
| 无 `DATABASE_URL` + 生产   | **拒绝启动**（防止静默跑内存库）           |

域代码只依赖 `TableDriver` / `TxClient` 接口，换驱动不改域。

### 3.3 业务域

`src/domains/` 下 16 个域，共 106 条路由（`/health` 另计）：

| 域          | 代表路由                                                        |
| ----------- | --------------------------------------------------------------- |
| `auth`      | `POST /auth/login`、`GET/PATCH/DELETE /auth/me`                 |
| `family`    | 家庭 CRUD、加入、成员、转让户主                                 |
| `wish`      | 心愿 CRUD、投票、`POST /wishes/to-trip-draft`                   |
| `trip`      | 行程 CRUD、完结、成员、主导者、邀请码三端点、`POST /trips/join` |
| `holiday`   | 节假日查询、工作日判断、家庭自定义导入                          |
| `itinerary` | 安排 CRUD、正文块、排序                                         |
| `booking`   | 预订 CRUD、按订单号查询（敏感字段加密）                         |
| `expense`   | 记账、批量记账、汇总、改删                                      |
| `checklist` | 行程清单、模板 CRUD / 套用 / 同步、批量勾选                     |
| `item`      | 个人物品库（PRIVATE 域）                                        |
| `item-sync` | 增量游标、变更拉取、合并报告                                    |
| `outfit`    | 穿搭 CRUD（PRIVATE 域，校验 item 归属）                         |
| `notify`    | 提醒任务、订阅授权登记                                          |
| `media`     | presign / confirm / 列表 / 删除 / 回忆照片 / EXIF 剥离          |
| `fx`        | 汇率查询、录入、快照、批量换算、历史重算                        |
| `memory`    | 回忆列表、详情、按行程/年度生成                                 |

### 3.4 公共层

`src/common/` 是可复用的横切能力，域内不重复实现：

| 目录 / 文件       | 职责                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `auth/`           | 78 格权限矩阵、PRIVATE 短路、`@RequireAccess` / `@Public`               |
| `crypto/`         | 字段级加密（AES-256-GCM + AAD + 盲索引）、DEK 管理、`toBuffer`          |
| `db/`             | `TableDriver`、Prisma / 内存双驱动、事务、软删、三写收口、乐观锁        |
| `envelope/`       | 统一信封、BigInt 安全序列化                                             |
| `errors/`         | 错误码 → HTTP 状态映射                                                  |
| `fx/`             | 金额精度（decimal.js + 最小单位）、档位、授权源、公开/人工源            |
| `idempotency/`    | `requestId` 幂等（TTL 24h）                                             |
| `media/`          | EXIF 剥离 / GPS 告警                                                    |
| `middleware/`     | 8 段链、dispatcher、链路依赖                                            |
| `object-storage/` | `ObjectStorage` 接口、本地磁盘驱动、上传/回读路由                       |
| `pagination/`     | 页码 + 游标分页                                                         |
| `scheduler/`      | 过期行程自动完结                                                        |
| `security/`       | 限流、输入清洗                                                          |
| `sync/`           | `change_log` 游标                                                       |
| `audit/`          | 审计保留期（常量按 PIPL 取严定为 2 年；域服务当前默认 365 天，见 11.3） |
| `concurrency/`    | 行锁 / 乐观锁                                                           |
| `ci/`             | controller 薄度等静态门禁                                               |

### 3.5 启动顺序与 fail-fast

`main.ts` 的顺序有依赖，不可调整：

```text
load-env（必须在读取 process.env 之前）
  → guardFxSource       生产无合规汇率源则拒绝启动
  → installDriver       必须在 NestFactory.create 之前登记驱动
  → installWechat       生产缺微信凭证则拒绝启动
  → installTokenSecret  生产缺 JWT_SECRET 则拒绝启动
  → NestFactory.create
  → 取 BuiltApp
  → 装 BigInt JSON replacer
  → 挂 /media-files 上传/回读路由（本地磁盘时）
  → CORS
  → listen
  → 启动自动完结定时器
```

设计原则：**坏配置不应该活到第一个请求**。因此生产缺 `DATABASE_URL`、缺
`JWT_SECRET`、缺微信凭证、缺合规汇率源都会直接退出；媒体缺配置是例外，
只降级为 `presign` 返回 503 + `5008`，不拖垮整个 API。

### 3.6 写路径与一致性

所有业务写都走 `DomainContext.tx()` → `commitWrite()`，同一事务内完成三件事：

1. 业务表写入；
2. `change_log`（供多端增量同步）；
3. `audit_log`（合规审计）。

三条不变量：三写同事务；时间取 **DB 时间**；软删只写 `deleted_at`，不物理删行。
唯一键统一带 `deletedToken`，让软删后的业务键可以重建。

---

## 4. 客户端架构

### 4.1 页面与导航

`app.config.ts` 注册 12 个页面，底部 5 个 tab：

```text
总览 HomePage / 规划 PlanPage / 行程 TripsPage / 物品 ItemsPage / 我的 ProfilePage
非 tab：MemoryPage（回忆墙）、WishPoolPage、TripDetailPage、TripManagePage、
        TripCreatePage、JoinTripPage、JoinFamilyPage
```

`src/nav/index.ts` 是路由抽象层：页面只调用 `navigate / back / backOr`，不感知
Taro 页面栈。tab 页走 `switchTab`，非 tab 页走 `navigateTo`；「返回」必须用
`backOr`，避免反复压栈撞上小程序 10 层上限。

### 4.2 数据层：一套接口，两套实现

```text
页面 / 组件
   │  只依赖 ApiClient 接口
   ▼
api/index.ts
   ├── API_BASE_URL 为空 → createMockClient()   # 本地打开即可看完整界面
   └── API_BASE_URL 非空 → createHttpClient()   # Taro.request / uploadFile 打真后端
```

- 请求层：`Taro.request`（微信 `wx.request` / H5 同构），统一解析信封；
- 鉴权：`Authorization: Bearer <token>`，token 存 `Taro.setStorage`；
- 幂等：写请求自动带 `requestId`；
- 登录态：`api/session.ts` 启动恢复 token，401 时清 token、单航班重登、重试一次；
- 能力降级：例如 `/media/memories` 404 时打 10 分钟本地标记，后端部署后自动恢复。

`API_BASE_URL` 是**构建期常量**（`config/index.ts` 的 `defineConstants`）：

- 生产小程序构建默认 `https://api.familytripallinone.cn/api`；
- 本地 `dev:weapp` / `dev:h5` 默认空 → Mock；
- 连本地后端：构建时传 `API_BASE_URL=http://<电脑IP>:3000/api`。

### 4.3 状态与工具

- 无全局状态库：`useAsync` 管请求，`useSession` 用 `useSyncExternalStore` 广播登录态；
- `utils/` 放纯逻辑并单测：日期区间、日历、节假日、账单解析、清单粘贴、
  BigInt 定点汇率换算、地区字典、分享海报；
- 上传：`utils/upload.ts` 统一 `presign → Taro.uploadFile → confirm`，头像与照片共用；
- 预览：`utils/preview.ts` 封装 `Taro.previewImage`，回忆墙与行程照片 tab 共用。

---

## 5. 数据模型

`apps/server/prisma/schema.prisma` 共 **28 个 model**，按域分组：

| 分组       | 表                                                                           |
| ---------- | ---------------------------------------------------------------------------- |
| 身份与家庭 | `user`、`family`、`family_member`                                            |
| 心愿       | `wish`、`wish_vote`                                                          |
| 出行       | `trip`、`trip_member`、`trip_destination`、`trip_history`                    |
| 行程       | `itinerary_item`、`booking`                                                  |
| 清单与物品 | `trip_checklist_item`、`checklist_template`、`item`、`outfit`、`outfit_item` |
| 花销与汇率 | `expense`、`currency_config`、`exchange_rate`                                |
| 提醒       | `reminder_task`、`notify_subscription`                                       |
| 媒体与回忆 | `media_asset`、`file_pending`、`memory_archive`                              |
| 字典与基础 | `holiday`、`change_log`、`idempotency`、`audit_log`                          |

全库规范：

- 主键雪花 ID（BIGINT，应用侧生成）；
- 金额以「最小货币单位整数」落库，展示口径 `DECIMAL(18,4)`；
- 汇率 `DECIMAL(18,8)`，档位固定 `SPOT_SELL`；
- 时间戳 `DATETIME(3)`，以 DB 为源；
- 软删除 + `deleted_token` 复合唯一键；
- 加密列用 `VARBINARY`，密文头带 key version；
- 受保护行带 `version` 做 CAS 乐观锁。

迁移目录 `prisma/migrations/` 当前 9 个版本，部署时必须
`prisma migrate deploy`（顺序见 `deploy/DEPLOY.md`）。

---

## 6. 关键机制的实现方式

### 6.1 登录与鉴权

- 微信小程序 `wx.login` 拿 code → `POST /auth/login` → 后端
  `jscode2session` 换 openid → 签发 HS256 JWT（默认 7 天）。
- 开发桩：未配置微信凭证时 `openid = openid_${code}`；
  配 `DEV_WECHAT_OPENID` 可固定为同一账号，避免「每次登录换人」。
- 生产：缺 `WECHAT_APPID` / `WECHAT_SECRET` / `JWT_SECRET` 均拒绝启动。
- H5：`Taro.login` 在 H5 无实现，当前合成 code 走开发桩；生产 H5 登录尚未实现。

### 6.2 权限

- 资源类型 15 种，操作 3 种（READ / WRITE / DELETE），组合成 78 格矩阵，启动期断言完整。
- 判定公式：
  - PRIVATE：`owner_id = U OR managed_by = U`，不满足即拒；
  - SHARED：`U ∈ family` 或 `U ∈ trip`。
- 清单类表是双语义：`scope` 决定当 SHARED 还是 PERSONAL 处理。
- 归档行程：除 `media` 外，安排 / 清单 / 花销 / 预订 / 行程信息一律拒写；
  `media` 单独放行「加/删照片」，并写审计 `media.upload_archived_trip`。

### 6.3 字段级加密

- 每个用户一个 DEK，密钥由 KMS 提供；密文头带 key version；
- AES-256-GCM，AAD 含表标识，防止跨表搬运密文；
- 盲索引与业务写同事务；
- `toBuffer()` 统一处理 Buffer / 二进制列，含跨表搬运拒绝用例；
- 当前 DEK 由内存 KMS 用 `sha256(userId:keyVer)` 派生，**仅开发/测试**。

### 6.4 汇率

- 金额换算在服务端用 `decimal.js` + 最小货币单位整数，前端只做展示换算（BigInt 定点）。
- 档位唯一 `SPOT_SELL`；缓存键包含档位与日期。
- 开发/预览：`PublicRateSource`（公开中间价，生产恒禁用）。
- 生产初期：`ManualRateSource`（银行现汇卖出价人工录入，`POST /fx/rates`）。
- 生产白名单 `FX_AUTHORIZED_SOURCES` 缺失 = 拒绝启动；未录入币种返回 `5006`，
  不静默按 1:1 兜底。

### 6.5 媒体

```text
① POST /api/media/presign         → { uploadUrl, fileKey, expiresIn }
② Taro.uploadFile(uploadUrl, file) → multipart POST 到自家收单端点
   uploadUrl = <MEDIA_PUBLIC_BASE_URL>/upload?fileKey=..&exp=..&sig=..
③ 收单端点校验 HMAC 签名 → 落盘 OBJECT_STORAGE_ROOT → 返回字节数
④ POST /api/media/confirm         → 登记 media_asset + change_log
⑤ 读图：nginx alias 直出 <MEDIA_PUBLIC_BASE_URL>/<fileKey>
```

- 小程序 `Taro.uploadFile` 只能发 multipart POST，不能 PUT 裸流，所以走「自家端点」；
- 字节在服务端手里，`confirm` 可以做 EXIF 剥离（GPS 告警）；
- `media_asset.family_id` 已放宽为可空：AVATAR 不再要求 `familyId`，也不再校验家庭成员；
- 未配置媒体三件套时服务照常启动，但 `presign` 明确返回 `503 + 5008`，不再返回假地址。

### 6.6 自动完结

- 过期行程（`end_date < 今天` 且状态 `PLANNED/ONGOING`）自动转 `FINISHED`；
- 三条入口：进程内定时器（默认 5 分钟）、读路径惰性流转、手工 `finish`；
- 总开关 `AUTO_FINISH_ENABLED=false` 一处关闭三条入口；
- 定时器与 HTTP 共用 `finishInternal`，审计 reason 区分 `TRIP_AUTO_FINISHED` / `TRIP_FINISHED`；
- 单条失败不影响其余；CAS 失败视为已完成。

### 6.7 多端同步

- 业务写同时写 `change_log`；
- 客户端用 `GET /sync/cursor` + `GET /sync/changes` 拉增量；
- 游标由服务端签发，客户端只回传不解析；
- 当前客户端**尚未接入**该链路，且服务端 `item-sync` 仍有全表扫描（见第 11 节）。

---

## 7. 本地开发

### 前置

- Node.js ≥ 20.11（部署文档以 Node 22 构建；pnpm 11 建议 Node 22.13+）
- pnpm 11（`packageManager: pnpm@11.0.1`）
- 可选：MySQL 8（不装也能用内存驱动跑通全部接口）

### 安装与启动

```bash
pnpm install --frozen-lockfile

# 后端（内存驱动，无需 MySQL；重启数据清零）
pnpm dev:server                 # http://127.0.0.1:3000

# 客户端 H5（默认 Mock，不连后端）
pnpm dev:client

# 客户端小程序（微信开发者工具打开 apps/client/dist）
pnpm --filter @family-trip/client run dev:weapp
```

### 连真后端

```bash
# 1. 后端接 MySQL
cp apps/server/.env.example apps/server/.env
#    填 DATABASE_URL，然后：
cd apps/server && npx prisma migrate deploy && pnpm dev

# 2. 客户端构建时注入后端地址（真机不能用 127.0.0.1）
API_BASE_URL=http://<电脑局域网IP>:3000/api \
  pnpm --filter @family-trip/client run build:weapp
```

数据源判定：`API_BASE_URL` 为空 → Mock；非空 → HTTP。
**Mock 全绿只证明界面能渲染，不证明业务可用**；涉及上传、schema、权限的改动
必须连真后端验一遍。

### 常用命令

```bash
pnpm lint          # ESLint（根目录）
pnpm typecheck     # 两个包的 tsc --noEmit
pnpm test          # 两个包的 vitest
pnpm verify        # lint + typecheck + test（提交前必须通过）
pnpm format        # Prettier 写回
pnpm format:check  # Prettier 校验
pnpm build         # 后端 prisma generate + tsc；客户端 weapp 构建
```

后端真 MySQL 自检脚本：

```bash
cd apps/server
node .verify/real-driver-smoke.cjs     # 需先起 MySQL、迁移、构建并启动真驱动服务
node .verify/prod-selfcheck.mjs        # 线上版本/路由探测（只读）
```

---

## 8. 测试与质量门禁

| 层     | 方式                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------- |
| 单测   | Vitest；客户端纯逻辑（日历、账单、清单、汇率、海报等）                                                    |
| 集成   | 后端 `test/`，直接构造 `RawRequest` 调 `app.dispatch`，覆盖权限、并发、加密、邀请码、自动完结、媒体回环等 |
| 端到端 | `apps/client/.verify/*.cjs`，无头 H5 / 真后端验收                                                         |
| 真驱动 | `apps/server/.verify/real-driver-smoke.cjs`（需 MySQL）                                                   |
| 静态   | ESLint + Prettier + TypeScript strict                                                                     |

门禁以 `pnpm run verify` 为准。**新环境首次跑之前要先 `prisma generate`**
（`pnpm --filter @family-trip/server exec prisma generate` 或先跑一次 build）：
否则 `@prisma/client` 没有生成类型，ESLint 会把 Prisma 相关调用判成 `any` 并报错，
看起来像代码缺陷，实际是环境未初始化。

其余注意：

- 后端测试默认跑 `MemoryTableDriver`，**不校验真实列/约束/方言**。历史上
  `snap_key`、`finish` 500、清单 `version` 都是「内存测试全绿、真库 500」；
- 因此涉及 schema / Prisma / BigInt / 对象存储的改动，除单测外还要跑真驱动或
  真后端验收；
- 仓库目前**没有 CI workflow**（`.github/` 下只有 issue 模板），真驱动冒烟脚本
  尚未挂到 CI。

---

## 9. 构建与部署

生产目标：腾讯云轻量单机（Ubuntu），与 XLFamily / food-api 共机：

- 后端 pm2 进程 `family-trip`，端口 **3010**（3000 被 XLFamily 占用）；
- nginx 独立 `server_name`，`/api` 反代到 3010；
- `/media-files/upload` 反代到 Node，其余 `/media-files/` alias 到
  `OBJECT_STORAGE_ROOT` 静态直出；
- MySQL 8 本机，库 `family_trip`，最小权限账号；
- 必需环境变量：`DATABASE_URL`、`WECHAT_APPID`、`WECHAT_SECRET`、`JWT_SECRET`、
  `FX_AUTHORIZED_SOURCES`、媒体三件套；生产缺数据库 / 微信凭证 / JWT / 汇率白名单
  任一项都会拒绝启动。

完整步骤、上线后自检与回滚见：

- [`deploy/DEPLOY.md`](deploy/DEPLOY.md)
- [`deploy/上线清单一页版-2026-10-26.md`](deploy/上线清单一页版-2026-10-26.md)
- [`deploy/nginx-family-trip.conf`](deploy/nginx-family-trip.conf)
- [`deploy/ecosystem.config.js.example`](deploy/ecosystem.config.js.example)

发布顺序必须是：**迁移 → 构建（含 `prisma generate`）→ 重启**。
只 `git pull` + `pm2 restart` 不会更新 `dist`；只构建不迁移会因缺列继续 500。

---

## 10. 文档索引

| 文档                                                                                                                   | 内容                                              |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`docs/OVERVIEW.md`](docs/OVERVIEW.md)                                                                                 | M1 公共层交付概览（**早期快照，部分状态已过期**） |
| [`docs/TP-02-交付物/参考文档/技术方案-家庭出行计划.md`](docs/TP-02-交付物/参考文档/技术方案-家庭出行计划.md)           | 早期技术方案 / 数据模型 / 接口清单                |
| [`docs/TP-02-交付物/参考文档/技术方案-v1.2-RC1-后端架构.md`](docs/TP-02-交付物/参考文档/技术方案-v1.2-RC1-后端架构.md) | 后端架构与数据模型细化                            |
| [`docs/TP-02-交付物/参考文档/TP-02C-加密权限安全-v1.0.md`](docs/TP-02-交付物/参考文档/TP-02C-加密权限安全-v1.0.md)     | 加密 / 权限 / 安全红线                            |
| [`docs/FX-汇率接入说明.md`](docs/FX-汇率接入说明.md)                                                                   | 汇率源、生产录入流程、云函数备选                  |
| [`docs/媒体存储接入.md`](docs/媒体存储接入.md)                                                                         | 媒体链路、配置、换云存储步骤、已知限制            |
| [`docs/本地联调避坑清单.md`](docs/本地联调避坑清单.md)                                                                 | 本地联调真实踩坑与排查顺序                        |
| [`docs/派发单-D-2026-10-26-*.md`](docs/)                                                                               | 清单/账单、自动完结、finish 500、媒体上传         |
| [`docs/改动对照-2026-11-05-后端五项修复.md`](docs/改动对照-2026-11-05-后端五项修复.md)                                 | 昵称 / memberCount / 头像解耦等后端修复           |
| [`qa/reports/测试报告-2026-10-22.md`](qa/reports/测试报告-2026-10-22.md)                                               | 88 条功能用例执行结果与门禁结论                   |
| [`qa/defects/缺陷单-2026-10-22.md`](qa/defects/缺陷单-2026-10-22.md)                                                   | 缺陷清单（本文评估的重要来源）                    |
| [`deploy/DEPLOY.md`](deploy/DEPLOY.md)                                                                                 | 生产部署 Runbook                                  |

时效性提示：`docs/OVERVIEW.md` 是早期「未建表 / 客户端仅占位」阶段的快照，
**不代表当前实现**；当前状态以本文为准。

---

## 11. 需求完成度评估

> 评估方法：以 `qa/`、`docs/`、`docs/TP-02-交付物/`、`deploy/` 中登记的需求、
> 缺陷与待办为输入，逐项对照当前代码。旧文档标注「未实现」但代码已闭环的，
> 归入「已闭环」；文档标注「需产品确认」的，保留为待决策项。
>
> 结论：核心链路（登录 → 家庭 → 心愿 → 行程 → 安排 → 清单 → 花销 → 回忆 →
> 归档只读）已打通；剩余工作主要是**客户端功能入口**与**生产级基础设施**。

### 11.1 已闭环（文档曾列为缺口，当前代码已实现）

| 需求 / 缺口                                       | 当前落点                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| 长期清单改条目 / 改名 / 删整套（D-2026-10-26-01） | `PATCH/DELETE /checklists/templates/:id`，CAS + 软删 + 审计              |
| 模板改条目同步到未成行行程                        | `checklist.service.syncTemplateToOpenTrips`（FINISHED/CANCELLED 不回溯） |
| 批量记账                                          | `POST /expenses/batch`，部分成功 + 行级结果 + 限流                       |
| 行程邀请码三端点 + 4041                           | `GET /trips/:id/invite`、`POST .../reset`、`POST /trips/join`            |
| 行程到期自动完结                                  | `common/scheduler/auto-finish.ts` + 读路径惰性流转 + 总开关              |
| 归档行程仍可加/删回忆照片                         | `media` 域专用写门（其余域维持只读）                                     |
| 行程预算                                          | `trip.budget_minor` + 详情页预算卡（未设预算不显示 0%）                  |
| 清单「要做的事 / 要带的东西」分类                 | `trip_checklist_item.kind`（TODO / PACK）                                |
| 媒体上传（本地磁盘）                              | `ObjectStorage` + `/media-files` 收单/回读 + 签名 + 50MB 限制            |
| 头像与家庭解耦                                    | `media_asset.family_id` 可空迁移 + AVATAR 只校验账号归属                 |
| 昵称与家庭称呼分开                                | `nickname` 主行 + `displayName` 副行（2026-11-05/06）                    |
| 回忆照片预览 / 删除确认 / 归到行程                | `utils/preview.ts` + `showModal` + 上传前选行程                          |
| 日历标注法定节假日                                | `utils/holidays.ts` 内置 2026 / 2027 数据                                |
| 邀请码 / 清单 / 日程等越权入口加固                | 权限矩阵、写门、全国假期字典只读、BigInt 出口兜底                        |

### 11.2 部分完成 / 未完成

状态说明：**部分** = 后端或契约已就绪，但客户端入口/展示缺失；
**未做** = 前后端都没有完整实现。

| #   | 需求（来源）                                                                     | 状态 | 当前实现与缺口                                                                                                                                                                                       | 建议优先级 |
| --- | -------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | 多币种记账：币种 / 汇率快照 / 双币展示 / 手动覆盖（需求 §5.2、决策 13；BUG-004） | 部分 | 后端 `expense.currency`、`amount_base`、fx 域、`/fx/convert-batch` 已就绪；客户端 `types` / `http` / `useFxRate` / `utils/fx` 已存在，但 `TripDetailPage` 的记账表单没有币种与汇率输入，明细写死 `¥` | **高**     |
| 2   | 心愿字段完整性、状态流转、一键带入（需求 §3.2–3.4；BUG-005/006/007）             | 部分 | 服务端支持 `title/description/priority/tripId/status(WANT/PLANNED/DONE/DROPPED)` 与 `POST /wishes/to-trip-draft`；客户端只能填标题+说明，状态映射合并为 OPEN/ADOPTED/ARCHIVED，没有「安排」入口      | **高**     |
| 3   | 穿搭模块：物品组合成套装、按天安排、存模板（需求 §6.2；BUG-012）                 | 部分 | 服务端 `outfit` CRUD（PRIVATE，校验 item 归属）已有，缺 `apply` / 按天安排；客户端无 API、页面、入口                                                                                                 | 中         |
| 4   | 预算 vs 实际分类对比表（需求 §5.2；BUG-018）                                     | 部分 | 已有行程总预算与按类目实际花费；没有分类预算模型，也没有「预算 vs 实际」对比表                                                                                                                       | 中         |
| 5   | 出行日期冲突校验（需求 §4.3；BUG-003）                                           | 未做 | 无 `/trips/conflict-check`；客户端创建行程时没有区间 ∩ 成员的温和提示（纯前端即可先做）                                                                                                              | 中         |
| 6   | 跨年行程归属次年（决策 7；BUG-009）                                              | 未做 | `PlanPage.tripYear()` 仍取 `startDate`，跨年行程归到出发年                                                                                                                                           | 低         |
| 7   | 首页月份时间轴区分年份（BUG-014）                                                | 未做 | `HomePage.MonthRail` 只看月份，去年同月也会点亮                                                                                                                                                      | 低         |
| 8   | 首页预算卡（BUG-016）                                                            | 未做 | 仍固定 `width:100%` + 「/ 待定」，未使用已存在的 `trip.budgetMinor`                                                                                                                                  | 低         |
| 9   | 首页 / 规划页同行人数口径（BUG-015）                                             | 部分 | 行程列表已改用 `trip.memberCount`；首页与规划页仍取 `family.memberCount`                                                                                                                             | 低         |
| 10  | 物品图片（需求 §6.2；BUG-013）                                                   | 未做 | `item` 表与 UI 都没有图片字段；穿搭挑选只能靠文字                                                                                                                                                    | 低         |
| 11  | 提醒 / 微信订阅消息（需求 §4.4）                                                 | 部分 | 服务端有 `reminder_task` / `notify_subscription` 的 CRUD 与额度状态机；**没有发送调度器，也没有微信订阅消息 API 调用**；客户端无提醒入口                                                             | **高**     |
| 12  | 多端增量同步（需求 §4.3）                                                        | 部分 | 服务端 `change_log` + `item-sync` 路由已有；客户端未接入，且服务端实现有全表扫描（见 11.3）                                                                                                          | 中         |
| 13  | 节假日字典自动更新（决策 10）                                                    | 部分 | 客户端内置 2026/2027，满足展示；服务端 `holiday` 表无种子数据，每年自动抓取未实现，需手工追加                                                                                                        | 中         |
| 14  | 生产 H5 登录                                                                     | 未做 | H5 端 `Taro.login` 不可用，当前合成 code 依赖开发桩；Web 二期需独立登录方案                                                                                                                          | 二期       |
| 15  | Web 端产品化（一期只做小程序）                                                   | 未做 | Taro H5 可构建，但未作为正式端接入登录、路由与发布                                                                                                                                                   | 二期       |

> 表中的 BUG 编号来自 `qa/defects/缺陷单-2026-10-22.md`。该报告同时把多条
> 标为 `PENDING-SCOPE`（需产品裁定是否本版范围）；上表保留它们是因为
> **当前代码确实没有闭环**，不代表必须在本迭代完成。

### 11.3 工程与运维债务

| #   | 事项                 | 现状与影响                                                                                                                                         | 建议                    |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | 对象存储 / CDN       | 当前只有本地磁盘：单盘无冗余、无 CDN、多实例会分叉；换 COS/OSS/S3 需新增 driver（接口已预留）                                                      | 上多实例前必须做        |
| 2   | 媒体孤儿文件清理     | `filePending` 的 PENDING 记录与落盘文件没有清理任务；`PENDING_TTL_MS` 常量已留                                                                     | 加定时清理              |
| 3   | 真 KMS               | 仍是 `createMemoryKms()` 的 `sha256(userId:keyVer)` 派生，仅开发/测试；生产需接 KMS 与密钥轮换                                                     | 上线前                  |
| 4   | 真 MySQL / 真驱动 CI | 测试默认内存驱动；`real-driver-smoke.cjs` 已就绪但仓库没有 CI workflow，真库问题仍可能漏到线上                                                     | 挂 CI（MySQL service）  |
| 5   | `item-sync` 全表扫描 | `item-sync.service.ts` 仍用 `findMany('changeLog', { where: {} })` 拉全表再内存过滤；数据量大后是慢查询                                            | 下推到 SQL              |
| 6   | 种子数据             | 节假日等基础字典没有 seed 脚本；服务端 `holiday` 表为空，客户端靠内置数据                                                                          | 补 seed                 |
| 7   | 多实例一致性         | 自动完结靠 CAS 可多实例；但本地磁盘媒体、`InMemoryIdempotencyStore`（批量记账）都假设单实例                                                        | 扩多实例前改造          |
| 8   | 生产版本核对         | `deploy/上线清单一页版-2026-10-26.md` 记录生产曾停留在 10-22 构建；仓库内无法确认当前线上版本，发布前应跑 `prod-selfcheck.mjs` 与 `migrate status` | 每次发布                |
| 9   | 审计保留期口径       | `audit-retention.ts` 定义 2 年（PIPL 取严），但各域服务默认 `auditRetentionDays = 365`，实际写入 1 年；另有 `runAuditCleanup` 但未挂调度           | 统一为 2 年并挂清理任务 |
| 10  | QA 门禁              | 2026-10-22 报告执行率 71.6%、通过率 76.2%、安全用例覆盖 20%，未达门禁；真机 / 双账号 / 真后端用例仍缺口                                            | 发版前补测              |

### 11.4 建议的推进顺序

1. **先保上线正确性**：发布前跑真驱动冒烟、`prisma migrate status`、生产路由自检；
   确认线上不是旧 `dist`。
2. **补客户端高价值缺口**：多币种记账 UI → 心愿状态/一键带入 → 提醒入口。
   这三项直接决定「海外记账」「心愿到行程」「按时提醒」三个卖点是否可用。
3. **清客户端小缺陷**：冲突提示、跨年归属、首页月轨/预算卡/人数口径，
   都是局部改动，适合集中一轮修完。
4. **再补工程债**：真 KMS → 真驱动 CI → 媒体云存储/清理 → 同步下推。
5. **产品裁定**：穿搭、分类预算、物品图片、Web 二期是否本版范围；
   未列入本版的应转 Backlog，避免长期以「缺陷」形式挂着。

---

## 12. 已知限制

- **单实例假设**：媒体写本地磁盘、批量记账幂等用进程内 Map、自动完结用进程内定时器；
- **H5 登录**：开发桩依赖合成 code，生产 H5 未接真实登录；
- **Mock 与真后端不等价**：Mock 跳过上传与 schema 校验，验收必须标明数据源；
- **微信平台限制**：tabBar 最多 5 个（当前 5 个）；`Taro.uploadFile` 只能 multipart POST；
- **测试盲区**：内存驱动不校验真实列、约束、方言；BigInt / JSON / 列宽问题只在真库暴露；
- **文档时效**：`docs/OVERVIEW.md` 是 M1 早期快照，与当前实现不一致时以代码与
  本 README 为准。
