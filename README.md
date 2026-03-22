# 🛡️ MoodSpace 后端 API (Node.js)

本仓库是 MoodSpace 平台的核心中枢系统（CQRS 架构中的“写入端”）。
它负责处理所有复杂业务：校验用户权限、同步 GitHub 模板、向 Cloudflare R2 保存模板源文件、向 Cloudflare KV 写入防碰撞的用户路由，并对接 Supabase 数据库管理用户配额。

> **小白提示**：这里的代码**不直接面临用户的海量高并发访问**。所有的前台高并发都由 Worker 挡在前面，只有当用户需要“新生成一个网页”或平台要“同步一个新模板”时，才会调用这里的接口。

---

## 🏗️ 核心技术栈
- **运行时环境**: Node.js (v20+)
- **后端引擎**: Express.js
- **存储对象库**: `@aws-sdk/client-s3` (用于连接 Cloudflare R2，因为 R2 兼容 S3 标准)
- **缓存与路由**: Cloudflare KV REST API
- **CDN 联动**: Cloudflare Cache Purge API (负责一键清理全网节点缓存)
- **业务数据库**: Supabase (用于用户认证、管理账号注册和使用额度)

---

## 💻 开发者：本地运行指南

如果你想在本地开发修改后端代码：

1. **克隆代码到本地**：
   ```bash
   git clone https://github.com/XShen-Jason/MoodSpace-Backend.git
   cd MoodSpace-Backend
   ```
2. **安装依赖**：
   ```bash
   npm install
   ```
2. **准备环境变量**：
   ```bash
   cp .env.example .env
   ```
   *对照下方的“环境变量保姆级配置详解”填入你的测试配置。*
3. **启动热更新服务**：
   ```bash
   npm run dev
   ```
   服务默认会在本地 `http://localhost:3000` 启动。

---

## ⚙️ 环境变量保姆级配置详解 (.env)

小白最容易卡在找这些长串密钥上，请严格按照以下步骤去相应的控制台寻找并填写：

### 1. 基础服务器属性
- `PORT=3000`：本地或 VPS 运行的端口，保持默认即可。
- `APP_NAME="Mood Space"`：你的网站品牌名。这个名字会动态显示在用户生成的网页底部的“引流小尾巴”上。
- `FRONTEND_URL=https://www.moodspace.xyz`：你的前端主站网址。由于生成的分享链接带你的域名，后端需要知道。
- `FRONTEND_DIST_PATH=/opt/MoodSpace-Frontend/dist`：前端静态文件在 VPS 上的**绝对路径**。万一 Nginx 失效，后端能够顶上，临时充当前端静态文件的分发服务器。

### 2. 超级管理员防盗刷密码
- `ADMIN_KEY=（自己创造一串英文字母+数字的强密码）`
- **作用**：全平台所有的“写入”操作的唯一通行证。你必须把这个密码填在这里，**同时再去 Cloudflare Worker 的 Settings 里添加同名的 Secret**，防止别人滥用接口恶意发包。

### 3. Supabase 数据库（管理用户及使用次数）
去 Supabase 你的项目里，左侧栏点击 ⚙️ **Project Settings -> API**。
- `SUPABASE_URL=（你的 Project URL，形如 https://xxx.supabase.co）`
- `SUPABASE_SERVICE_ROLE_KEY=（在这个页面里找到名为 service_role 的超长密钥）`
- 🚨 **警告**：`service_role_key` 拥有无视一切数据安全规则的“神权”，**这串钥匙只能存在于后端的 `.env` 里，绝对绝对不能出现在前端代码里！**

### 4. Cloudflare 全局账户与边缘缓存清理
- `CF_ACCOUNT_ID=(1)`：登录 CF -> 随便点进一个你的域名概览页 -> 右下角找 "Account ID"（账户 ID）。
- `CF_ZONE_ID=(2)`：在同一个页面，找到 "Zone ID"。
- `CF_API_TOKEN=(3)`：去右上角点头像 -> My Profile -> API Tokens -> Create Token (Custom)。
  - **权限列表** (严格只给这两个，不要多也不要少)：`Workers KV Storage: Edit` 加 `Zone: Cache Purge: Purge`。
  - **重要性**：没有这个权限，后台功能在更新黑名单或删除用户页面时，无法联动刷新全球节点网络，会导致修改不生效！

### 5. Cloudflare 存储桶配置 (KV & R2)
- `CF_KV_NAMESPACE_ID=(4)`：去 CF 左侧边栏 -> Workers & Pages -> KV，找到你为项目创建的 `MOODSPACE_KV`，复制旁边那一串 32 位的 Namespace ID。
- `CF_R2_BUCKET=moodspace-templates`：必须和你在 CF R2 里创建的存储桶名字一个字不差。
- `CF_R2_ENDPOINT=https://你的_CF_32位_账户ID.r2.cloudflarestorage.com`
- `CF_R2_ACCESS_KEY_ID` & `CF_R2_SECRET_ACCESS_KEY`：这需要回到 CF R2 主页面，点击右侧的 "Manage R2 API Tokens"。申请一组只能操作 R2 增删改查的专用 S3 小秘钥。

---

## 🚀 生产环境全景部署 (VPS)

如果这是你第一次在全新的 Ubuntu VPS 上部署：

### 1. Node.js 与 PM2 安装包
```bash
sudo apt update && sudo apt install -y git curl npm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 2. 拉取代码并启动守护进程
```bash
cd /opt
sudo git clone https://github.com/XShen-Jason/MoodSpace-Backend.git
cd MoodSpace-Backend
sudo npm install
cp .env.example .env
sudo nano .env  # 填入上方讲解过的所有变量

# 使用大写开头的进程名，与后期的自动化 CI 严格匹配！
pm2 start src/app.js --name "MoodSpace-api"
pm2 save
pm2 startup
```

### 3. 自动化部署 (CI/CD)
本项目已配置了精准触发的 GitHub Actions。只要你在本地向 GitHub 推送代码，GitHub 服务器就会通过 SSH 自动连进你的 VPS，帮你完成拉取并 `pm2 restart MoodSpace-api`。
- **你需要做的是**：去项目的 GitHub 页面 -> Settings -> Secrets and variables -> Actions，配置 `SSH_HOST` (IP地址)、`SSH_USER` (通常为 root) 以及 `SSH_KEY` (你的私钥)。

---

## 🛠️ KV 初始数据配置 (核心步骤！必须做)

既然你已跑通后台，要激活项目自带的**域名黑名单**和**动态会员收费权限**功能，请顺手移步到 Cloudflare DashBoard -> KV -> `MOODSPACE_KV` -> Add entry 进行手工填写：

1. **录入系统黑名单 (防止用户乱起名顶掉系统关键骨架)**：
   - Key (键)：`__sys__blocklist`
   - Value (值，必须是 JSON 数组)：`["spam", "admin", "www", "api"]`

2. **录入全局会员等级套餐属性**：
   - Key (键)：`__sys__quotas`
   - Value (值，严格粘贴以下完整架构，注意标点，可以动态增加或减少)：
     ```json
     {"free": {"limit": 1, "dailyLimit": 3, "minDomainLen": 3, "allowHideFooter": false, "label": "🌟 体验用户"}, "pro": {"limit": 5, "dailyLimit": 10, "minDomainLen": 3, "allowHideFooter": true, "label": "💎 高级会员"}}
     ```

---

## 🌟 核心企业级架构特性 (L5 Level)

本后端系统实现了多项企业级高可用基础设施设计，旨在以**最低的 Cloudflare 成本（零冗余 A 类操作）**支撑千万级用户流量：
1. **纯 KV 动态配置源 (Decoupled Sync)**：修改 JSON 配置（价格/字段/废弃状态）瞬间生效并在 R2 就地只读覆盖，**不再触发 HTML 和多媒体文件的重复打版上传**，消除一切存储与带宽浪费。
2. **CDN 死缓防白屏 (24h GC Queue)**：上传新模板时，旧版静态文件会被推入自带 24 小时存活期的垃圾回收队列 (`__sys_gc_`)。清扫器只对该队列进行 `O(1)` 定向爆破清理，彻底摒弃全盘扫描，同时保障全网迟滞边缘节点的平滑过渡。
3. **四维发布状态控制 (Logical Deletion)**：使用 `active`, `offline`, `pending`, `rejected` 来代替纯物理删除，保证历史生成的 C 端页面不受管理端下架影响。

---

## 📡 核心极客专区：开放 API 端点清单

如果你打算二次开发其他客户端，可直接调用此服务：

| 分类 | Method | Path | Auth 鉴权 | 功能描述 |
| :--- | :--- | :--- | :--- | :--- |
| **基础** | GET | `/health` | — | 系统心跳检查，供云监控确保服务存活 |
| **模板** | GET | `/api/template/list` | — | 前端获取“模板大厅”列表（支持 CDN 缓存） |
| | GET | `/api/template/preview/:name` | — | 渲染带默认参数的演示预览页面 |
| | POST | `/api/template/refresh-gallery` | `Admin` | 重写 `templates.json` 并刷新全网 CDN |
| | POST | `/api/template/upload` | `Admin` | 手动强制上传本地模板文件到 R2 存储桶 |
| | POST | `/api/template/sync-local` | `Admin` | 一键从本地或 GitHub Sync 所有模板源 |
| | POST | `/api/template/prune` | `Admin` | 存储优化：清理 R2 中 24h 前的冗余旧版文件 |
| **项目** | POST | `/api/project/render` | — | **核心**：执行网页渲染流程并注册 KV 域名路由 |
| | GET | `/api/project/status/:userId` | — | 获取用户当前等级、配额及今日修改剩余次数 |
| | GET | `/api/project/check-domain` | — | 域名实时可用性校验（带 5min 内存缓存） |
| | GET | `/api/project/:subdomain` | `Admin` | 精确查询并提取 KV 路由内存储的用户原始配置 |
| | POST | `/api/project/config/sync-all` | `Admin` | 运维整合：同步刷新 VPS 内存中的配额与黑名单 |
| **支付** | GET | `/api/payment/pricing` | — | 获取当前生效的会员等级定价方案（含优惠态） |
| | POST | `/api/payment/create` | — | 发起支付：创建系统订单并获取支付网关链接 |
| | ALL | `/api/payment/notify` | — | 支付回调：对接第三方网关 (ZhifuFM) 异步通知 |
| | GET | `/api/payment/query` | — | 轮询接口：检查特定订单是否已支付成功 |
| | GET | `/api/payment/admin/pricing` | `Admin` | 获取完整的定价配置清单（含已下架项） |
| | POST | `/api/payment/admin/pricing` | `Admin` | 管理端逻辑：新增或修改定价策略内容 |
| | POST | `/api/payment/admin/compensate`| `Admin` | 特权操作：手动为特定用户发放/补偿会员等级 |
### [附录] 终端 API 调用范例
**上传模板 (`POST /api/template/upload`)：**
```bash
curl -X POST http://localhost:3000/api/template/upload \
  -H "X-Admin-Key: 你的超神密钥" \
  -F "templateName=love_letter" \
  -F "index.html=@./index.html" \
  -F "config.json=@./config.json"
```

**触发渲染建立专属网页 (`POST /api/project/render`)：**
```bash
curl -X POST http://localhost:3000/api/project/render \
  -H "X-Admin-Key: 你的超神密钥" \
  -H "Content-Type: application/json" \
  -d '{"subdomain":"sweeties","type":"love_letter","data":{"title":"Hello Darling"}}'
```
*(响应会返回包含直接存有生成网页全球访问 CDN 地址的 JSON 体)*
