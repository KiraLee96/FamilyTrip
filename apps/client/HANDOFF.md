# 交付交接清单（派发单 ② · 前端泳道 A1–A5 + 功能补充 + A6/A7）

> 里程碑：**M-Client-1** —— 微信开发者工具（测试号 AppID）打开后，首页 / 心愿池 / 行程 / 年度规划 四页面可显示、可交互、控制台 0 error。
> 交付范围：仅 `apps/client`（红线 #4，`apps/server/**` 未触碰）。

## 一、交付物

| #   | 交付物                             | 位置                                                                                                                                                                                                   |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | Taro 4.x 工程骨架 + 构建脚本       | `config/index.ts`、`babel.config.cjs`、`project.config.json`、`package.json`（scripts: `dev:weapp`/`build:weapp`/`build:h5`/`typecheck`）                                                              |
| A2  | 路由抽象层 + 6 页小程序页面        | `src/nav/index.ts`（`navigate/back/useRouteParams`）、`src/nav/Link.tsx`、`src/pages/*.tsx`                                                                                                            |
| A3  | 样式适配说明                       | `STYLE_ADAPTATION.md`                                                                                                                                                                                  |
| A4  | 原生 tabBar 配置                   | `src/app.config.ts` 的 `tabBar`（4 tab，纯文字）                                                                                                                                                       |
| A5  | `Taro.request` 网络层（Mock 可跑） | `src/api/http.ts`、`src/api/index.ts`（`ApiClient` 接口方法仅新增、未改既有签名）                                                                                                                      |
| P0  | **新建行程**（用户验收反馈补齐）   | `src/pages/TripCreatePage.tsx`（标题 + 起止日期）、`TripsPage` 虚线入口条、`theme.css` 表单样式                                                                                                        |
| P1  | **添加物品**（用户验收反馈补齐）   | `ApiClient.createChecklistItem`（对齐后端 `POST /checklists/items`）、`mock.ts` 实现、`TripDetailPage` 清单 tab 行内添加表单                                                                           |
| P2  | **照片上传**（用户点名）           | `src/utils/upload.ts`（chooseImage→presign→uploadFile→confirm 两段式）、`TripDetailPage` 照片 tab 网格 + 上传格；ApiClient 新增 `presignUpload`/`confirmMediaAsset`/`listMedia`/`deleteMediaAsset`     |
| P3  | **出行/年度回忆**（用户点名）      | `TripDetailPage` 回忆 tab（快照展示 + 生成）、`PlanPage` 年度回忆区块；ApiClient 新增 `listMemories`/`getMemory`/`generateTripMemory`/`generateAnnualMemory`；共享组件 `src/components/MemoryCard.tsx` |
| A6  | **登录对接**                       | `src/api/session.ts`（启动恢复 token → 无 token 静默登录 → User 广播）、`src/hooks/useSession.ts`、`App.tsx` useLaunch 引导、`http.ts` login 落库 token + 4010/4011 清理、首页问候语 + 降级重试卡      |
| A7  | **联调层**                         | `http.ts`：Bearer 注入 / `X-Request-Id` 幂等 / 信封解析 / 凭证失效自清理 / familyId 兜底缓存联动失效；H5 双模式端到端验收 10/10（见下）                                                                |

## 二、质量证据（可复现）

```bash
# 1) 类型：strict 0 错误
pnpm --filter @family-trip/client run typecheck      # exit 0

# 2) 构建：微信小程序产物
pnpm --filter @family-trip/client run build:weapp    # Compiled successfully, exit 0
#    ModuleDependencyWarning：0

# 3) Lint：0 error（37 warning 为 explicit-function-return-type，项目基线级别，非阻断）
pnpm exec eslint apps/client/src                      # 0 errors, 37 warnings, exit 0
```

产物 `apps/client/dist/`：`app.js` + `vendors.js` + `taro.js` + 6 个页面（`.js/.wxml/.json`）+ `app.json`（pages 6、tabBar 4）。

### H5 端到端验收（无头 Chrome，12/12 通过）

验证脚本与截图位于工作区 `.workbuddy/2026-10-12-11-01-27/`（`verify_h5_v3.cjs` + `screenshots/v3-*.png`）：

| #   | 步骤                     | 结果                                                   |
| --- | ------------------------ | ------------------------------------------------------ |
| 1   | 首页渲染                 | PASS                                                   |
| 2   | 行程 tab                 | PASS                                                   |
| 3   | 进入行程详情             | PASS                                                   |
| 4   | 照片 tab（预置照片墙）   | PASS（3 张预置 + 1 上传格）                            |
| 5   | **上传照片全链路**       | PASS（chooseImage→presign→confirm→本地渲染，blob src） |
| 6   | 回忆 tab（既有出行快照） | PASS（徽标 + 成员名单 + 花销汇总）                     |
| 7   | 新建行程表单             | PASS                                                   |
| 8   | 创建并跳转详情           | PASS（新行程 id 生成）                                 |
| 9   | 新行程空态               | PASS（「还没有回忆」+ 生成按钮）                       |
| 10  | 生成出行回忆             | PASS（幂等语义：返回既有快照 + 「已存在」提示）        |
| 11  | 年度规划 + 年度回忆区块  | PASS                                                   |
| 12  | 生成年度回忆             | PASS                                                   |

console 错误数 0。

> 上传步骤说明：headless 环境无文件选择对话框（CDP 拦截经对照实验证实不触发），验收脚本在页面加载前注入脚本劫持 `input[type=file].click()`，用 DataTransfer 喂测试图并派发 change；Taro `chooseMedia` 之后的链路（loadMedia→chooseImage resolve→presign→confirm→渲染）全部走真实代码路径。

### A6/A7 端到端验收（无头 Chrome，10/10 通过）

验证脚本 `verify_h5_a6.cjs` + 截图 `screenshots/a6-*.png`（工作区 `.workbuddy/2026-10-12-11-01-27/`），双端口双产物：

| 端口 | 产物           | 模式                                                          |
| ---- | -------------- | ------------------------------------------------------------- |
| 5199 | `dist-h5`      | Mock（`API_BASE_URL` 空，默认）                               |
| 5200 | `dist-h5-dead` | http（`API_BASE_URL=http://127.0.0.1:59999/api`，不可达后端） |

| #   | 步骤                                          | 结果 |
| --- | --------------------------------------------- | ---- |
| A1  | 首页渲染（Mock）                              | PASS |
| A2  | **登录态广播**（bootstrap→me→「你好，小珂」） | PASS |
| A3  | 数据源徽标「示例数据」                        | PASS |
| A4  | 心愿池 / 行程 / 年度规划 tab 可切换           | PASS |
| A5  | 控制台 0 error（Mock）                        | PASS |
| B1  | 不可达后端不白屏                              | PASS |
| B2  | 「重新登录」降级入口可见                      | PASS |
| B3  | 数据错误态展示（非崩溃）                      | PASS |

H5 本地预览：`node static_server.cjs <port> <dist目录>`（工作区 `.workbuddy/2026-10-12-11-01-27/static_server.cjs`），Mock 入口 <http://127.0.0.1:5199>。
注意：`dist-h5` / `dist-h5-dead` 与 weapp 的 `dist` 是三份独立产物，互不覆盖（`config/index.ts` 的 `outputRoot` 构建后已 `git checkout` 还原为 `dist`）。

## 三、⚠️ 关键修复（必读）

1. **页面白屏**（迁移第一版遗留）：五个页面原为 named export，Taro `taro-loader` 取 default export 作页面组件 → `createPageConfig(undefined)` → 白屏。已补 `export default X;`，告警 5→0。
2. **详情页 404**（迁移第一版遗留，**小程序端同样存在**）：`nav` 层生成的 query 参数名是 `id`，而 `TripDetailPage` 读的是 `tripId` → 解构出 undefined → `getTrip('')` 404。已改为 `const { id: tripId = '' } = useRouteParams<{ id: string }>()`。此前无人真正点进详情页，H5 无头验收首次抓到。
3. **tab 页不刷新**：创建行程后返回列表看不到新卡（tab 页驻留缓存）。`TripsPage` 已加 `Taro.useDidShow(() => q.reload())`，小程序端对应 onShow，双端语义一致。
4. **H5 上传不弹文件选择器**：`Taro.chooseImage` 的 `sourceType: ['album','camera']` 在 H5 端被映射为 `<input capture="environment">`，桌面浏览器表现为「直接调起相机」而非弹文件选择（无相机设备即静默失败，**真实桌面浏览器同样中招，产品级 bug**）。已在 `utils/upload.ts` 按环境分流：H5 端用 `['album']`，小程序端保留 `['album','camera']`（微信弹「拍摄/相册」菜单是期望语义）。

## 四、微信开发者工具验证步骤（M-Client-1 验收）

1. 打开微信开发者工具 → 导入项目 → 目录选 `apps/client/dist`（`miniprogramRoot` 已配 `dist/`）。
2. **AppID**：`project.config.json` 已配置测试号 `wx3567e523d83206e4`（真机/预览可用；游客预览可改回 `touristappid`）。
   - 真后端联调（A7）时勾选「详情 → 本地设置 → 不校验合法域名」。
3. 逐项打勾：
   - [ ] 首页 / 心愿池 / 行程 / 年度规划 **四页面均正常渲染**
   - [ ] 底部 4 个原生 tab 可切换、选中态变色
   - [ ] 行程列表点「＋ 新建行程」→ 填标题 → 创建 → **进入详情页**（不再 404）
   - [ ] 详情页「清单」tab → 输入物品名 → 点「添加」→ **新物品即时入列**
   - [ ] 详情页「照片」tab → 点上传格 → **弹出「拍摄/从相册选择」** → 选图后照片入墙（H5 端为文件选择）
   - [ ] 详情页「回忆」tab → **快照卡片**（成员/日程/花销/照片数）→ 点「生成本次出行回忆」→ 幂等提示
   - [ ] 「年度规划」tab → **年度回忆区块** → 点生成 → 年度快照
   - [ ] 返回行程列表 → **新行程卡可见**（useDidShow 刷新）
   - [ ] 心愿**投票**可交互、清单**勾选**可交互（Mock 数据）
   - [ ] 冷启动后首页问候语为「你好，小珂」（A6：bootstrap 登录态已广播；真联调时显示微信用户昵称）
   - [ ] 顶部徽标显示 **MOCK**（`process.env.API_BASE_URL` 为空 → 走 Mock，红线 #2；注入后端地址后变「已连后端」）
   - [ ] 控制台 **0 error**
4. **截图**：小程序端截图仍需在开发者工具内人工截取（待补项）；H5 端 8 张流程截图已由无头浏览器产出（见第二节）。

## 五、红线自查

| 红线                                     | 状态                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| #1 `ApiClient` 接口不改                  | ✅ 既有方法签名一字未动；仅**新增** `createChecklistItem` + media/memory 8 方法（后端路由均已存在，属补齐契约，非单方面改签名） |
| #2 全程 Mock，不发真实请求               | ✅ 默认 `API_BASE_URL` 为空走 Mock（media 直传在 Mock 模式跳过，`uploadUrl` 为空）；http 模式需显式注入地址，切换只靠环境变量   |
| #3 组件不 fork                           | ✅ 6 页 + shared/Loading/Icon/MemoryCard 统一 `View/Text`，无双份                                                               |
| #4 `apps/server/**` 不动，单独 commit    | ✅ 提交仅含 `apps/client` + 根 `package.json`/`pnpm-lock.yaml`（client 使能），未含 `apps/server`                               |
| #5 AppID 走配置不写死                    | ✅ `project.config.json` 承载，当前为测试号 `wx3567e523d83206e4`                                                                |
| #6 TS strict / ESLint 0 error / Prettier | ✅ typecheck 0 错误、eslint 0 error                                                                                             |

## 六、A6/A7 落地说明与后续依赖

### A6 登录链路（已实现）

- **小程序**：`App.tsx` useLaunch → `bootstrapSession()` → 存储无 token 时 `Taro.login()` 拿 code → `POST /api/auth/login` → 信封 `data = {token, expiresIn, user, isNewUser}` → token 存 `Taro.setStorage('auth_token')` → 后续请求自动带 `Authorization: Bearer <token>`。
- **H5**：`@tarojs/taro-h5@4.3.0` 的 `Taro.login` 是 `temporarilyNotSupport` 空实现，H5 分支合成 code（`h5-<时间戳>-<随机>`）。服务端默认装配 `stubWechat`（openid = `openid_${code}`，任意非空 code 可换 token），**本地无 `.env` 也能联调**；生产接入真实 exchanger 后，H5 登录态需另接方案（如微信开放平台 OAuth 或二期 H5 专属登录），已在代码注释标注。
- **契约边界**：`ApiClient.login(code): Promise<User>` 签名未动；token 持久化由 http 实现层内部完成（收到 AuthSession 后 `setToken` + `setStorageSync`），界面层零感知。
- **凭证失效**：信封 `code` 为 4010/4011 时自动清本地 token，bootstrap 带旧 token 失败会兜底重登一次；仍失败则首页显示「微信登录未完成」+ 手动「重新登录」。

### A7 联调（已实现，待后端就绪后真连）

联调三步：① `API_BASE_URL=http://<后端>:34570/api pnpm --filter @family-trip/client run build:weapp`；② 微信开发者工具勾选「不校验合法域名」；③ 导入 `apps/client/dist`。徽标变绿（「已连后端」）即真链路。

仍需后端/环境侧配合的注意点：

- 后端 checklist 列表返回 `{items, meta, ...}` 且行字段为 `name/checked`，与前端 `ChecklistItem`（`title/done`）有既有字段差，需统一适配层（`listChecklist`/`createChecklistItem`/`toggleChecklistItem` 同批处理）。
- media 的 list 响应只给 `fileKey` 无可访问 URL，真后端模式下图片展示需对象存储/CDN 规则拼接（Mock 模式用本地临时路径即时渲染，刷新失效，已知局限）。
- `familyId` 经 `resolveFamilyId()`（`GET /families` 取首个，模块级缓存）解析，界面零感知；登出/401 时缓存联动失效（`resetFamilyIdCache`）。
- CORS 需放行 H5 dev origin（派发单 ④ B4′）；端口以后端 `PORT` 为准（派发单约定 34570）。

### 其他后续

- **H5 二期**：`build:h5` 已可用（`dev:h5`/`build:h5` 脚本就绪），同构无需再改。
- 小程序端截图仍需在开发者工具内人工截取（待补项）；H5 端截图已由无头浏览器产出。
