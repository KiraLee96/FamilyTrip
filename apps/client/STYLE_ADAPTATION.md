# 样式适配说明（A3 交付物）

> 范围：`apps/client/src/styles/theme.css` 在「H5 原型 → Taro 同构（微信小程序首发）」下的适配。
> 原则：**组件与 H5 共用，不 fork**；能靠构建期转换解决的一律不手改源码。

## 1. 根选择器：`:root` / `html` 在小程序不存在

微信小程序（WXSS）没有 `:root` 也没有 `html` 元素，根节点是 `page`。
原 H5 把设计变量挂在 `:root`，小程序读不到。

| 原（H5）                  | 改后（同构）                            | 说明                                                                  |
| ------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| `:root { --primary: … }`  | `page, :root { --primary: … }`          | 变量同时挂到 `page`（小程序根）和 `:root`（H5 根），一套 CSS 双端生效 |
| `body { … }`              | `body, page { … }`                      | 字体/底色/字号挂在 `page` 上，组件才能继承                            |
| `html, body { margin:0 }` | 保留（`html` 在小程序被忽略，无副作用） | —                                                                     |

> 设计变量（颜色、圆角、阴影、`--safe-b` 等）全部集中于这一处，换主题只改这份文件。

## 2. px → rpx：交给构建期，不手改

- `config/index.ts` 设 `designWidth: 375`，与 H5 的 375 逻辑宽容器一致。
- 开启 `mini.postcss.pxtransform` 与 `h5.postcss.pxtransform`：**源码里继续写 `px`，Taro 自动换算成 `rpx`**（375 基准下 1px → 2rpx）。
- 例外：`h5` 下对 `page` 选择器做了 `selectorBlackList: ['page']`，避免 `page` 根上的 `px` 被转换导致 H5 端错位。
- 结论：**禁止在源码里手写 `rpx`**，保持 `px` 即可双端同构。

## 3. 安全区 `env(safe-area-inset-*)`

- 小程序支持 `env(safe-area-inset-bottom, 0px)`（iPhone 底部 Home 指示条区域）。
- 在 `page, :root` 上定义 `--safe-b: env(safe-area-inset-bottom, 0px)`，`--tabbar-h` 配合。
- 滚动容器 `.screen` 用 `padding: 14px 14px calc(20px + var(--safe-b))` 自动避让底部安全区与原生 tabBar。

## 4. 内联 `<svg>`：小程序不支持 → 改用 emoji

小程序 WXML 不能内联 `<svg>`。原 `Icon.tsx` 的内联图标改为 **emoji 字形映射**（`GLYPH`），用 `<Text>` 渲染。

- 收益：零图片资源、零体积、跨端一致。
- 约束：tabBar 图标也受此限制（见第 6 节）。

## 5. 已知的小程序「忽略型」样式（无害，非阻塞）

以下写法小程序会静默忽略或不完全支持，不影响渲染与验收：

| 写法                                             | 状态               | 影响                               |
| ------------------------------------------------ | ------------------ | ---------------------------------- |
| `backdrop-filter: blur(12px)`（.tabbar 毛玻璃）  | 小程序不支持，忽略 | 仅视觉少一层毛玻璃，不影响布局     |
| `position: sticky`（.navbar / .day__head）       | 部分基础库支持有限 | 标题栏吸顶可能不生效，不影响内容   |
| `.phone` 的 `@media (min-width: 420px)` 桌面外壳 | 小程序恒不触发     | 仅 H5 桌面预览用，小程序无影响     |
| `.phone { max-width:375px; margin:0 auto }`      | 小程序下等于满宽   | 容器框在真机上与屏幕同宽，无副作用 |

> 说明：小程序原生 `tabBar` 已接管底部栏（见第 6 节），H5 自绘的 `.tabbar` 不再进入渲染路径，上面 `backdrop-filter` 实际已不可见。

## 6. 底部 TabBar：H5 自绘 → 小程序原生

- 删除 H5 自绘 `.tabbar` 的渲染路径，改由 `app.config.ts` 的 `tabBar` 配置驱动**原生 tabBar**。
- 四个 tab（首页 / 心愿池 / 行程 / 年度规划）用**纯文字**，刻意不配 `iconPath`。
  - 原因：小程序 `tabBar` 图标**必须是本地图片文件**（不支持 emoji / 网络图），原型期引入 PNG 会增加资源维护面，故先用文字 tab。
  - 后续要图标：在 `app.config.ts` 的 `list[].iconPath/selectedIconPath` 补本地 PNG（建议 81×81px）即可，页面代码无需改动。
- 安全区：原生 tabBar 自身已处理底部安全区，`.screen` 的 `calc(20px + var(--safe-b))` 仅用于内容区不与其重叠。

## 7. 适配后视觉对齐结论

- 配色、圆角、卡片、字体层级、状态色、进度条、时间轴、清单、记账、年度规划 hero 等**全部沿用 H5 同一份 `theme.css`，视觉与 H5 一致**。
- 仅「毛玻璃 / sticky 吸顶 / 桌面外壳」三处小程序静默忽略，属已知非阻塞偏差。
