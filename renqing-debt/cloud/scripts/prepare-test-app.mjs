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

for (const f of ["index.html", "logo-mushroom.webp", "static"]) {
  const from = join(src, f);
  if (!existsSync(from)) {
    console.error(`缺少 ${from}`);
    process.exit(1);
  }
  cpSync(from, join(app, f), { recursive: true });
}
console.log("test-app 已就绪（人情债本体 + 依赖）");
