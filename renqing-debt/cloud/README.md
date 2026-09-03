# 云端版：给自托管的那份加一道登录墙

把人情债（或任何自包含静态页）跑到自己的 Cloudflare 上，前面挡一道用户名密码。

按词表（`vibe-everyting/CONTEXT.md`）：你照着这套方法自己部署的那份，仍属于**自托管态**——
拿得走、跑得起，只是数据放在了你自己的云上。**私有云态**指的是培然同学自己那一份实例。
方法公开，实例私有。

> 完整的自建部署文档在 T6 补齐。这里先记住两件事：
> 一是凭据走 secret、不落文件；二是 `run_worker_first` 那一行不能删。

## 本地跑测试

```bash
npm install
npm test          # Playwright 打本地 wrangler dev，用 wrangler.test.toml 的假凭据
```

## 部署（简版）

```bash
cp wrangler.example.toml wrangler.toml   # 填自己的 Worker 名
npx wrangler secret put AUTH_USER        # 交互式输入，不落任何文件
npx wrangler secret put AUTH_PASSWORD
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

把要跑的静态页放进 `public/`。

## 进门有两条路

1. **会话 cookie** —— 免输密码，日常走这条
2. **Basic Auth** —— 第一次、或会话过期时走这条，成功后自动换一张 cookie（120 天）

第一条不是为了省事，是为了这东西能被真的用起来：**iOS Safari 的 Basic Auth 弹框是原生对话框，密码 App 的自动填充在它上面不生效**——只有 Basic 的话，强密码等于每次都在手机上手输一遍。

cookie 是 `__Host-` 前缀 + `HttpOnly` + `Secure` + `SameSite=Lax`，内容用 HMAC-SHA256 签名。
验签在解析之前，签名不对就直接出局，绝不去 `JSON.parse` 一段来路不明的内容。

`SESSION_SECRET` 不配也能跑，只是退回「每次都输密码」——**门不会因此敞开**。

## 怎么踢下线（重要，别搞错）

| 你做的事 | 效果 |
|---|---|
| `/logout` | **只让这台设备丢票**。签名 cookie 是无状态的，服务端没有「已注销」名单——抄走过 cookie 原文的人重放它，在有效期内仍然管用 |
| 改 `AUTH_PASSWORD` | **踢不掉任何已发出的票**。cookie 那条路根本不看密码，改了密码，老设备照样进得来 |
| 换 `SESSION_SECRET` | ✅ **所有设备立刻下线**。全部票验签失败，人人都得重新输密码 |

所以：**手机丢了、或怀疑凭据外泄，去换 `SESSION_SECRET`，光改密码没用。**

```bash
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

`/logout` 返回 200 而不是 401，是故意的：401 会召唤浏览器的登录弹框，而浏览器多半还缓存着 Basic 凭据，会静默重发、立刻又换到一张新票——那样退出等于没退。至于浏览器自己缓存的 Basic 凭据，那不归 Worker 管，要清得关掉浏览器。

## 一个不能省的配置

`wrangler.toml` 里的 `run_worker_first = true`：**不开它，静态资源会先于 Worker 命中，
整道登录墙形同虚设**——而且首页看起来完全正常，你不会察觉。
`tests/auth.spec.ts` 最后一条测试就是钉这个的。
