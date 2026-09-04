# 云端版：把人情债跑到你自己的云上

把人情债（或任何自包含的静态页）部署到**你自己的 Cloudflare 账号**，前面挡一道用户名密码，账本存在你自己的 KV 里。

按词表（`vibe-everyting/CONTEXT.md`）：你照着这套方法部署的那份，仍属于**自托管态**——拿得走、跑得起，只是数据放在了你自己的云上。**私有云态**指的是作者自己那一份实例。**方法公开，实例私有。**

跑起来之后你会得到：

- 一道登录墙，路人连里面有什么都看不出来
- 一张自己的登录页（想做多少设计是你的事），而不是浏览器那个丑弹框
- 一张 120 天的会话票，手机上不必每次手输密码
- 账本存云端，手机记的电脑上就有
- 两台设备撞车时**停下来问你**，绝不自动合并
- 每次保存自动留旧版（最近 20 版），误删能找回

## 需要什么

- 一个 Cloudflare 账号（免费版够用）
- Node.js 18+
- 十分钟

免费额度：KV 每天 10 万次读 / 1000 次写、存储 1 GB，Workers 每天 10 万次请求。一个人记一辈子人情账都碰不到。

## 从零到跑起来

### 1. 拿到代码

```bash
git clone https://github.com/whtjl1988-long/vibe-apps.git
cd vibe-apps/renqing-debt/cloud
npm install
npx playwright install chromium   # 想跑测试才需要
npx wrangler login                # 授权 wrangler 访问你的 Cloudflare
```

你还可以在 `public/` 放两张自己的页面，Worker 会自动用它们；不放就回退到内置的极简版：

| 文件 | 什么时候出现 | 需要保留的钩子 |
|---|---|---|
| `login.html` | 未登录访问页面时 | `<form method="post" action="/login">`、`input[name=user]`、`input[name=password]`、`input[name=next]`（Worker 会填）、`[data-login-error]`（密码错时保留，否则被删掉） |
| `logged-out.html` | 访问 `/logout` 之后 | 无 |

### 2. 把要跑的页面放进 public/

```bash
cp ../index.html ../logo-mushroom.webp ../qr.png public/
cp -R ../static public/
```

`qr.png` 别漏——分享浮层引用它，少了那张二维码是碎的。这几条会覆盖掉 `public/` 里原来的占位页，那正是我们要的。

### 3. 配置

```bash
cp wrangler.example.toml wrangler.toml
```

打开 `wrangler.toml`，把 `name` 改成你自己的 Worker 名（比如 `my-renqing`）。

**`run_worker_first = true` 这一行别删** —— 不开它，静态资源会先于 Worker 命中，**整道登录墙形同虚设**，而首页看起来完全正常，你不会察觉。

### 4. 建账本存储

```bash
npx wrangler kv namespace create LEDGER
```

它会打印一段 `[[kv_namespaces]]` 配置，把里面的 `id` 填到 `wrangler.toml` 对应的位置（模板里已经留好了那一段，binding 必须是 `LEDGER`——Worker 只认这个名字）。

### 5. 先部署一次

```bash
npx wrangler deploy
```

**顺序是有讲究的**：secret 要设到一个已经存在的 Worker 上，所以先部署。

这时凭据还没配，Worker 会**拒绝所有人**（包括你）——这是故意的，先部署再设密码就没有任何暴露窗口。

### 6. 设凭据

三条命令，**交互式输入，值不落任何文件、也不进命令历史**：

```bash
npx wrangler secret put AUTH_USER        # 随便定，它不是秘密
npx wrangler secret put AUTH_PASSWORD    # 你的密码
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
```

`SESSION_SECRET` 是会话票的签名密钥，让它在你机器上生成、直接进 Cloudflare。不配也能跑，只是退回「每次都输密码」——**门不会因此敞开**。

设完打开 `*.workers.dev` 地址，应该弹出登录框。

### 7.（可选）绑自己的域名

域名在同一个 Cloudflare 账号下的话，在 `wrangler.toml` 里加：

```toml
workers_dev = false
routes = [{ pattern = "ledger.example.com", custom_domain = true }]
```

再 `npx wrangler deploy`。`workers_dev = false` 会关掉那个可枚举的 `*.workers.dev` 入口，只留你自己的域名。

## 验证

这两件事是分开的，别混：

### 代码有没有走样 —— `npm test`

```bash
npm test
```

Playwright 起本地实例跑全套 e2e（登录墙、会话票、账本读写、冲突护栏、历史版本、子路径部署）。

**它验的是代码，不是你的部署。** 测试用的是仓库自带的几份测试配置，**从不读你的 `wrangler.toml`**——你删掉 `run_worker_first`、忘了设 secret、KV 没绑上，`npm test` 照样全绿。改过 `src/` 之后跑它，别拿它当上线检查。

### 你的部署对不对 —— 打线上

```bash
HOST=https://你的地址

curl -s -o /dev/null -w '%{http_code}\n' "$HOST/"            # 期望 401（脚本走这条）
curl -s -o /dev/null -w '%{http_code}\n' "$HOST/index.html"  # 期望 401 ← 最要紧的一条
curl -s -o /dev/null -w '%{http_code}\n' -u '你的用户名' "$HOST/"  # 输密码，期望 200
```

`-u '用户名'` 不带密码，curl 会提示你输入——**别把密码写进命令行**，那会进 shell 历史。

**第二条最要紧**：它要是 200，说明 `run_worker_first` 没生效，静态资源绕过了登录墙——首页看起来完全正常，你不会察觉。

浏览器那条路单独确认一下：

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H 'Sec-Fetch-Dest: document' "$HOST/"
# 期望 302，跳到 /login——浏览器该被领到登录页，而不是弹原生框
```

**两条入口是并存的**：浏览器走登录页拿会话票，`curl -u` 这类脚本仍然直接带凭据进来。同一对凭据、同一道墙。

账本这一层再确认三条（都要先输密码）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -u '你的用户名' "$HOST/api/ledger"
# 200（已有账本）或 204（还没记过）；501 说明 KV 没绑上

curl -s -o /dev/null -w '%{http_code}\n' -u '你的用户名' -X PUT \
  -H 'Content-Type: application/json' --data '{}' "$HOST/api/ledger"
# 期望 428：不说明「基于第几版」的写入一律拒绝，这是冲突护栏的门

curl -s -o /dev/null -w '%{http_code}\n' -u '你的用户名' "$HOST/api/ledger/history"
# 期望 200：历史版本读得到
```

最踏实的验证还是手上这台机器：**记一笔，换台设备打开，看看在不在。**

## 怎么踢下线（重要，别搞错）

| 你做的事 | 效果 |
|---|---|
| `/logout` | **只让这台设备丢票**。签名 cookie 是无状态的，服务端没有「已注销」名单——抄走过 cookie 原文的人重放它，在有效期内仍然管用 |
| 改 `AUTH_PASSWORD` | **踢不掉任何已发出的票**。cookie 那条路根本不看密码，改了密码老设备照样进得来 |
| 换 `SESSION_SECRET` | ✅ **所有设备立刻下线**。全部票验签失败，人人都得重新输密码 |

所以：**手机丢了、或怀疑凭据外泄，去换 `SESSION_SECRET`，光改密码没用。**

```bash
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

## 同一份源码，三种形态

`../index.html` 一个字节都不用改，跑在哪就是哪一态：

| 怎么打开 | 形态 | 数据在哪 |
|---|---|---|
| 双击本地文件（`file://`） | **自托管态** | 这台机器的浏览器里，断网也能用 |
| 作品墙上的试玩页 | **试玩态** | 只在内存里，刷新即还原 |
| 部署到这套 Worker 后面 | **自托管态**（云端版） | 你自己的 KV |

三种跑法，两种形态——因为「你自己部署的那一份」按词表仍属自托管态。
**私有云态**专指作者自己长期在用的那一份实例，它不进这个仓库的分发范围。

形态由**托管方式**决定：Worker 会给页面注入一个标记（连同账本接口的地址），软件据此切换。公开分发的那一份没有这个标记，所以行为不变——不需要第二份代码，也不需要改任何配置。

## 你该知道的两个限制

**1. 冲突护栏挡不住「同一分钟内的两次写入」。** Cloudflare KV 没有原子的 compare-and-swap，而且它的读是最终一致的——同一个 key 的写入可能要几十秒才在所有节点可见。所以护栏的窗口是**分钟级**而非毫秒级：它挡住了真正高频的那类事故（开了几小时的旧标签页、两台设备隔几小时各记各的），但两台设备在同一分钟内先后写同一本账时仍可能有一方被覆盖。消灭它要上 Durable Objects，对一本一年几十条的账是过度设计。

**2. 账本在 KV 里是明文。** 谁能登进你的 Cloudflare 账号，谁就能看到它。所以**请给你的 Cloudflare 账号开双因素**。

## 出问题时先看这几条

| 症状 | 多半是 |
|---|---|
| 不输密码就能进 | `run_worker_first` 没开 |
| 密码明明是对的却进不去 | 密码里有非 ASCII 字符且你用的是旧版本代码（已修，见 git 历史） |
| 记了账，刷新就没了 | 页面没拿到云端标记——多半是 HTML 缺 `<head>`，注入无处可去 |
| 账本读不出来、页面被挡住 | KV 没绑上（`env.LEDGER` 缺失），Worker 会明说而不是假装成功 |

## 许可

MIT，跟这个仓库其余部分一样。
