# 云端形态：给自托管的那份加一道登录墙

把人情债（或任何自包含静态页）跑到自己的 Cloudflare 上，前面挡一道用户名密码。
数据仍是你自己的——这套代码公开，**实例是私有的**。

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
npx wrangler deploy
```

把要跑的静态页放进 `public/`。

## 一个不能省的配置

`wrangler.toml` 里的 `run_worker_first = true`：**不开它，静态资源会先于 Worker 命中，
整道登录墙形同虚设**——而且首页看起来完全正常，你不会察觉。
`tests/auth.spec.ts` 最后一条测试就是钉这个的。
