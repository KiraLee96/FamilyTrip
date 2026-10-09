# 业务域目录（v1.3 §1.1 · 按域组织）

技术方案 v1.3 §1.1 明确**按域组织**而非按层组织，共 14 个域。本目录现为**骨架占位**：
各域 handler 依赖 v1.4 的最终数据模型（表结构 / 外键 / 索引 / 权限矩阵 82 格），v1.4 出后逐个落地。

| #   | 域（目录）  | 职责                                                   | 依赖 v1.4                                  |
| --- | ----------- | ------------------------------------------------------ | ------------------------------------------ |
| 1   | `auth`      | 登录鉴权、openid/token、会话                           | 是（users 表）                             |
| 2   | `family`    | 家庭集合、成员、角色                                   | 是                                         |
| 3   | `trip`      | 出行（行程容器）、访问级别                             | 是                                         |
| 4   | `itinerary` | 日程 / 行程明细                                        | 是                                         |
| 5   | `expense`   | 花费、金额（BIGINT 最小单位 + decimal.js）             | 是（含 `spend.owner_member_id`，N11 之一） |
| 6   | `checklist` | 物品清单                                               | 是                                         |
| 7   | `wish`      | 心愿单                                                 | 是                                         |
| 8   | `item-sync` | item 增量同步（游标分页）                              | 是                                         |
| 9   | `outfit`    | 穿搭 / 行装                                            | 是                                         |
| 10  | `notify`    | 提醒 / 订阅消息                                        | 是                                         |
| 11  | `media`     | 媒体资产（M6 EXIF 剥离落 `media_assets.exifStripped`） | 是                                         |
| 12  | `holiday`   | 节假日                                                 | 可提前（字典数据，弱依赖）                 |
| 13  | `fx`        | 汇率（M4 口径 `SPOT_SELL`，缓存键含档位）              | 部分（缓存层可先行）                       |
| 14  | `memory`    | 回忆                                                   | 是                                         |

## 约定

- 每个域内按需放 `<domain>.controller.ts` / `<domain>.service.ts` / `<domain>.schema.ts`（Zod）。
- 域 handler **统一经 8 段中间件链**（`common/middleware/chain.ts`），出口一律走 `responseEnvelope`。
- 公共能力（鉴权 / 加解密 / 幂等 / 错误码 / 分页 / 汇率精度 / 事务）一律复用 `common/`，域内不重复造。
- 已完成、可先行：`fx`（M3/M4 已在 `common/fx` 落地）、`media`（M6 已在 `common/media` 落地）、`holiday`（纯字典）。
