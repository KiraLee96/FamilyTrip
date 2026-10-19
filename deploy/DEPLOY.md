# FamilyTrip 生产部署 Runbook

**目标机器**：腾讯云轻量 lhins-lhvlecwc（82.156.30.50，2C/2G/50G/4Mbps，Ubuntu）
**共机注意**：机器上跑着 XLFamily（pm2 family-space）——所有步骤以「不碰它」为前提
**本目录文件**：`ecosystem.config.js.example`（pm2 模板）/ `mysql-lightsail.cnf`（MySQL 降配）/ `nginx-family-trip.conf`（站点模板）

---

## 0. 前置检查（缺任何一项就停，不要带着缺口往下走）

| #   | 项                                               | 状态 | 卡点后果                                                            |
| --- | ------------------------------------------------ | ---- | ------------------------------------------------------------------- |
| 1   | 云硬盘**自动快照**已开                           | ☐    | 盘坏 = XLFamily + FamilyTrip 数据全没                               |
| 2   | `WECHAT_SECRET` 已从 mp.weixin.qq.com 拿到       | ☐    | 生产拒绝启动（半配置也拒绝）                                        |
| 3   | `JWT_SECRET` 已生成（`openssl rand -base64 48`） | ☐    | 生产拒绝启动                                                        |
| 4   | 域名已备案 + 已解析到 82.156.30.50               | ☐    | 无 HTTPS = 小程序无法连接（备案 7-20 个工作日，最迟启动）           |
| 5   | FX 授权源决策已定（接 or 本期下线）              | ☐    | **当前代码生产必然拒绝启动**（M3 守卫，有意设计，勿删守卫勿填假源） |

> 第 5 项是产品决策不是技术项。若决定「本期不做 FX」：需要摘掉 FX 相关域后再部署——这是代码改动，不是配置能绕过的。

**登录服务器**：腾讯云轻量控制台 → 实例 → 登录（OrcaTerm 浏览器登录最稳，不依赖本机 SSH 密钥）。

---

## 1. 服务器基线（约 5 分钟）

```bash
# swap 兜底：2G 内存 + MySQL，OOM 一次就全挂
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # 验证 Swap 出现 2G

# 确认共机现状（应看到 family-space 在跑，别动它）
pm2 list
```

## 2. MySQL 安装 + 降配 + 建库（约 10 分钟）

```bash
sudo apt update && sudo apt install -y mysql-server nginx
sudo cp <本目录>/mysql-lightsail.cnf /etc/mysql/mysql.conf.d/99-family-trip.cnf
sudo systemctl restart mysql

# 最小权限账号：只授 family_trip 单库，禁止跨库/超级权限
sudo mysql <<'SQL'
CREATE DATABASE family_trip CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'family_trip'@'127.0.0.1' IDENTIFIED BY '<设一个强密码>';
GRANT ALL PRIVILEGES ON family_trip.* TO 'family_trip'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
```

> 密码只进第 4 步 ecosystem 的 `DATABASE_URL`，不落文件、不进 bash history（用 `mysql -p` 交互输入而非命令行带密码）。

## 3. 代码上服务器 + 构建（约 10 分钟）

```bash
# 源码上服务器（二选一）：
#   A. git clone <仓库地址> /home/ubuntu/family-trip
#   B. 本地打包源码 scp 上去（不含 node_modules——Windows 二进制不能直接用）
cd /home/ubuntu/family-trip

# Node 20+（轻量 Ubuntu 源版本可能旧，必要时 nodesource）
node -v

# 装依赖 + 构建（pnpm monorepo，--frozen-lockfile 保证与本地一致）
pnpm install --frozen-lockfile
pnpm --filter @family-trip/server build

# Prisma：生成 client + 建表（migrate deploy 不创建库，库已在第 2 步建好）
cd apps/server
npx prisma migrate deploy
```

> ⚠️ 若 `migrate deploy` 报「no migration found」：说明 migrations 目录没进仓库——本地先 `prisma migrate dev` 生成迁移文件并提交，再上服务器。

## 4. pm2 起服务（约 5 分钟）

```bash
cd /home/ubuntu/family-trip/apps/server
cp <本目录>/ecosystem.config.js.example ecosystem.config.js
vim ecosystem.config.js   # 填第 0 节全部占位符

# 预期行为（不是 bug！）：占位符没填全 → 启动即退出并打印原因
pm2 start ecosystem.config.js
pm2 logs family-trip --lines 50
```

看到 `family-trip server listening on :3000` 才算成。常见退出原因对照：

| 日志关键字                       | 含义                      | 处理                   |
| -------------------------------- | ------------------------- | ---------------------- |
| `WECHAT_APPID` / `WECHAT_SECRET` | 缺配置或半配置            | 补齐                   |
| `JWT_SECRET`                     | 缺签名密钥                | 补齐                   |
| `FxSourceMisconfigured`          | FX 授权源未注入           | 回到第 0 节第 5 项决策 |
| `data driver`                    | 驱动类型（memory/prisma） | 出现 `prisma` 才对     |

```bash
curl -s http://127.0.0.1:3000/health   # 本机自测：{"code":0,"data":{"status":"up"},...}
pm2 save   # 开机自启（XLFamily 的 pm2 save 不受影响，各自进程独立）
```

## 5. nginx + 证书（约 15 分钟，依赖域名备案）

```bash
sudo cp <本目录>/nginx-family-trip.conf /etc/nginx/sites-available/family-trip
sudo ln -s /etc/nginx/sites-enabled/family-trip /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 证书：先确保 80 段可达（备案解析生效后）
sudo certbot --nginx -d api.<你的域名>
```

> certbot 自动续期已装 timer（`systemctl list-timers | grep certbot` 确认）。

## 6. 小程序后台配合法域名

mp.weixin.qq.com → 开发管理 → 服务器域名 → request 合法域名添加 `https://api.<你的域名>`
（合法域名有月修改次数限制，一次填对）。

## 7. 端到端验证

```bash
# 1. 链路：外网 → nginx → NestJS
curl -s https://api.<你的域名>/health

# 2. 真实登录（需要小程序端发起 wx.login，本步在开发者工具里点登录看「我的」页）
#    验收点：昵称不再每次变；改名后刷新仍在

# 3. 内存复盘（跑 24h 后看，目标：total 稳定在 75% 以下）
free -h && pm2 monit
```

## 8. 回滚（任一环节翻车）

```bash
pm2 stop family-trip && pm2 delete family-trip   # 摘服务（数据不动）
sudo rm /etc/nginx/sites-enabled/family-trip && sudo systemctl reload nginx  # 摘流量
sudo systemctl stop mysql                        # 仅当 MySQL 本身出问题
# XLFamily 全程不受以上操作影响（独立 pm2 进程 + 独立目录）
```

---

## 附：本 runbook 不覆盖的事

- **FX 授权源接入**：商务采购流程，接入时把源实例注入 main.ts 的 `guardFxSource` 调用处（代码注释已标位置）
- **数据库备份策略**：依赖第 0 节自动快照；数据重要度升级后再考虑 mysqldump 定时任务
- **升级路径**：日活 5000+ 时 MySQL 拆 RDS、机器升 4G——扩容命令届时按新环境重写
