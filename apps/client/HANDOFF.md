# 交付交接清单（派发单 ② · 前端泳道 A1–A5 + 功能补充）

> 里程碑：**M-Client-1** —— 微信开发者工具（测试号 AppID）打开后，首页 / 心愿池 / 行程 / 年度规划 四页面可显示、可交互、控制台 0 error。
> 交付范围：仅 `apps/client`（红线 #4，`apps/server/**` 未触碰）。

## 一、交付物

| #   | 交付物                             | 位置                                                                                                                                      |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Taro 4.x 工程骨架 + 构建脚本       | `config/index.ts`、`babel.config.cjs`、`project.config.json`、`package.json`（scripts: `dev:weapp`/`build:weapp`/`build:h5`/`typecheck`） |
| A2  | 路由抽象层 + 6 页小程序页面        | `src/nav/index.ts`（`navigate/back/useRouteParams`）、`src/nav/Link.tsx`、`src/pages/*.tsx`                                               |
| A3  | 样式适配说明                       | `STYLE_ADAPTATION.md`                                                                                                                     |
| A4  | 原生 tabBar 配置                   | `src/app.config.ts` 的 `tabBar`（4 tab，纯文字）                                                                                          |
| A5  | `Taro.request` 网络层（Mock 可跑） | `src/api/http.ts`、`src/api/index.ts`（`ApiClient` 接口方法仅新增、未改既有签名）                                                         |
| P0  | **新建行程**（用户验收反馈补齐）   | `src/pages/TripCreatePage.tsx`（标题 + 起止日期）、`TripsPage` 虚线入口条、`theme.css` 表单样式                                           |
| P1  | **添加物品**（用户验收反馈补齐）   | `ApiClient.createChecklistItem`（对齐后端 `POST /checklists/items`）、`mock.ts` 实现、`TripDetailPage` 清单 tab 行内添加表单              |

## 二、质量证据（可复现）

```bash
# 1) 类型：strict 0 错误
pnpm --filter @family-trip/client run typecheck      # exit 0

# 2) 构建：微信小程序产物
pnpm --filter @family-trip/client run build:weapp    # Compiled successfully, exit 0
#    ModuleDependencyWarning：0

# 3) Lint：0 error（29 warning 为 explicit-function-return-type，项目基线级别，非阻断）
pnpm exec eslint apps/client/src                      # 0 errors, 29 warnings, exit 0
```

产物 `apps/client/dist/`：`app.js` + `vendors.js` + `taro.js` + 6 个页面（`.js/.wxml/.json`）+ `app.json`（pages 6、tabBar 4）。

### H5 端到端验收（无头 Chrome，7/7 通过）

验证脚本与截图位于工作区 `.workbuddy/2026-10-12-11-01-27/`（`verify_h5.cjs` + `screenshots/`）：

| #   | 步骤                | 结果                                                    |
| --- | ------------------- | ------------------------------------------------------- |
| 1   | 首页渲染            | PASS                                                    |
| 2   | 行程 tab + 新建入口 | PASS（「新建行程」虚线条渲染）                          |
| 3   | 新建行程表单        | PASS（标题输入 + 起止日期选择器）                       |
| 4   | 创建并跳转详情      | PASS（新行程 id 生成，`#/pages/TripDetailPage?id=xxx`） |
| 5   | 清单 tab + 添加框   | PASS                                                    |
| 6   | 添加物品生效        | PASS（「防晒霜」即时入清单）                            |
| 7   | 列表出现新行程卡    | PASS（`useDidShow` 刷新生效）                           |

console 错误数 1（`favicon.ico` 404，无害）。

H5 本地预览：`python -m http.server 5199 --bind 127.0.0.1`（cwd = `apps/client/dist-h5`），入口 <http://127.0.0.1:5199>。
注意：`dist-h5` 与 weapp 的 `dist` 是两份独立产物，互不覆盖（`config/index.ts` 的 `outputRoot` 已还原为 `dist`）。

## 三、⚠️ 关键修复（必读）

1. **页面白屏**（迁移第一版遗留）：五个页面原为 named export，Taro `taro-loader` 取 default export 作页面组件 → `createPageConfig(undefined)` → 白屏。已补 `export default X;`，告警 5→0。
2. **详情页 404**（迁移第一版遗留，**小程序端同样存在**）：`nav` 层生成的 query 参数名是 `id`，而 `TripDetailPage` 读的是 `tripId` → 解构出 undefined → `getTrip('')` 404。已改为 `const { id: tripId = '' } = useRouteParams<{ id: string }>()`。此前无人真正点进详情页，H5 无头验收首次抓到。
3. **tab 页不刷新**：创建行程后返回列表看不到新卡（tab 页驻留缓存）。`TripsPage` 已加 `Taro.useDidShow(() => q.reload())`，小程序端对应 onShow，双端语义一致。

## 四、微信开发者工具验证步骤（M-Client-1 验收）

1. 打开微信开发者工具 → 导入项目 → 目录选 `apps/client/dist`（`miniprogramRoot` 已配 `dist/`）。
2. **AppID**：`project.config.json` 当前为 `"touristappid"`（游客号，可直接预览）。
   - 用测试号 AppID：把派发单 ①-1.1 拿到的测试号 AppID 填进 `project.config.json` 的 `appid`（该文件是配置、非源码；如需保密可 `git update-index --skip-worktree project.config.json` 后再改本地值）。
   - 真后端联调（A7）时勾选「详情 → 本地设置 → 不校验合法域名」。
3. 逐项打勾：
   - [ ] 首页 / 心愿池 / 行程 / 年度规划 **四页面均正常渲染**
   - [ ] 底部 4 个原生 tab 可切换、选中态变色
   - [ ] 行程列表点「＋ 新建行程」→ 填标题 → 创建 → **进入详情页**（不再 404）
   - [ ] 详情页「清单」tab → 输入物品名 → 点「添加」→ **新物品即时入列**
   - [ ] 返回行程列表 → **新行程卡可见**（useDidShow 刷新）
   - [ ] 心愿**投票**可交互、清单**勾选**可交互（Mock 数据）
   - [ ] 顶部徽标显示 **MOCK**（`process.env.API_BASE_URL` 为空 → 走 Mock，红线 #2）
   - [ ] 控制台 **0 error**
4. **截图 4 张**（首页 / 心愿池 / 行程 / 年度规划）随验收回传。H5 端 7 张流程截图已由无头浏览器产出（见第二节），小程序端截图仍需在开发者工具内人工截取（待补项）。

## 五、红线自查

| 红线                                     | 状态                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| #1 `ApiClient` 接口不改                  | ✅ 既有方法签名一字未动；仅**新增** `createChecklistItem`（后端 `POST /checklists/items` 已存在，属补齐契约，非单方面改签名） |
| #2 全程 Mock，不发真实请求               | ✅ `API_BASE_URL` 为空走 Mock                                                                                                 |
| #3 组件不 fork                           | ✅ 6 页 + shared/Loading/Icon 统一 `View/Text`，无双份                                                                        |
| #4 `apps/server/**` 不动，单独 commit    | ✅ 提交仅含 `apps/client` + 根 `package.json`/`pnpm-lock.yaml`（client 使能），未含 `apps/server`                             |
| #5 AppID 走配置不写死                    | ✅ `project.config.json` 承载，默认 `touristappid`                                                                            |
| #6 TS strict / ESLint 0 error / Prettier | ✅ typecheck 0 错误、eslint 0 error                                                                                           |

## 六、后续依赖（不在本次范围）

- **照片回忆**（用户点名）：后端已有 `media` 域（presign→confirm 直传对象存储）与 `memory` 域（自动生成回忆快照，不可变）。小程序端需 `Taro.chooseMedia` + `Taro.uploadFile` 走预签名直传，Mock 层需模拟整条链。**产品定义待确认**：是「用户上传照片」（media）还是「自动生成回忆」（memory），两者是不同功能。
- **A6 登录**：依赖派发单 ① 的测试号 AppID；`wx.login` 链路待排期。
- **A7 联调**：依赖派发单 ④ 后端就绪 + CORS 放行 + 「不校验合法域名」开关。注意后端 checklist 列表返回 `{items, meta, ...}` 且行字段为 `name/checked`，与前端 `ChecklistItem`（`title/done`）有既有字段差，联调时需统一适配层（`listChecklist`/`createChecklistItem`/`toggleChecklistItem` 同批处理）。
- **H5 二期**：`build:h5` 已可用（`dev:h5`/`build:h5` 脚本就绪），同构无需再改。
