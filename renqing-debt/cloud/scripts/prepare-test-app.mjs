// 把人情债本体复制成 e2e 用的静态资源目录。
//
// 为什么要复制而不是直接指过去：wrangler 的 assets 目录会被整个投递出去，
// 直接指 renqing-debt/ 会把 cloud/ 自己（含 node_modules）也当成静态资源。
// test-app/ 进 .gitignore，是产物不是源码。
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..", "test-app");
const src = join(here, "..", ".."); // renqing-debt/

rmSync(app, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

// 两种部署形态都摆出来，因为两种都真的存在：
//   /          粉丝自建时人情债就在根目录
//   /renqing/  自留地里它住在子路径下（根是卡片墙）
// 只测根部署的话，子路径下那条相对路径的坑就永远测不到。
for (const dest of [app, join(app, "renqing")]) {
  mkdirSync(dest, { recursive: true });
  // qr.png 也得拷：index.html 的分享浮层引用它，漏了粉丝那边二维码是碎的
  for (const f of ["index.html", "logo-mushroom.webp", "static", "qr.png"]) {
    const from = join(src, f);
    if (!existsSync(from)) {
      console.error(`缺少 ${from}`);
      process.exit(1);
    }
    cpSync(from, join(dest, f), { recursive: true });
  }
}
console.log("test-app 已就绪（根部署 + /renqing/ 子路径部署）");
