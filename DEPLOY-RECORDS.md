# 云端同步阅读记录

在 [DEPLOY.md](DEPLOY.md) 的纯静态部署之上，把阅读记录从 localStorage 移到云端（Cloudflare D1），
让电脑和手机共享同一份「已读 / 未读」状态。`/api/plots` 仍然由 `scripts/static-api-shim.js`
在页面内用内联的 `Plotline.json` 应答，**不走网络**。

前端（`web/src/`）一行未改：应用本来就有「刷新数据」按钮会重新拉记录。

部署配置（Pages 项目、D1 绑定）**全部在 Cloudflare dashboard 里**：仓库里没有 `wrangler.toml`
之类的配置文件，也没有改动任何上游已跟踪的文件 —— 和 `deploy` 分支「只增不改」的性质一致。

## 新增 / 改动的文件

| 文件 | 作用 |
| --- | --- |
| `functions/api/records.ts` | 唯一的后端：`GET` 返回全部记录，`PUT` 逐键 upsert |
| `scripts/d1-schema.sql` | D1 建表语句 |
| `scripts/static-api-shim.js` | **已改动**：记录改走云端，localStorage 降级为离线镜像 + 待补传队列 |
| `scripts/test-static-api-shim.mjs` | 同步语义的回归测试（改 shim 后必跑） |

## 首次部署

### 1. 建 Pages 项目

**必须建 Pages 项目**（Workers & Pages → Create → 切到 **Pages** 标签 → Connect to Git），
不要建 Worker 项目：

- `functions/` 目录只在 Pages 里生效。Worker 不认这个结构 —— 官方迁移指南要求先把
  `functions/` 编译成单个 Worker 脚本、再把 `main` 指过去；照 Worker 的方式建，
  `/api/records` 会匹配不到资源、落到 SPA fallback 上返回 HTML，前端报 502。
- Worker 的静态资源目录只能由 wrangler 配置里的 `assets.directory` 指定，dashboard 里
  没有对应字段 —— 会逼你把部署配置放回仓库。

按 `DEPLOY.md` 建，构建配置不变：

| 设置 | 值 |
| --- | --- |
| Production branch | `cloud` |
| Root directory | 留空（仓库根） |
| Build command | `cd web && npm install && npm run build && node ../scripts/build-static.mjs` |
| Build output directory | `web/dist` |

项目名决定访问域名 `<name>.pages.dev`（当前用 `arkplots`）。仓库里没有 `wrangler.toml`，
所以 dashboard 里所有字段都可编辑。

### 2. 建 D1 数据库

```sh
npx wrangler login          # 只需一次，会打开浏览器授权
npx wrangler d1 create arkplots-records
```

输出的 `database_id` 不用写进仓库的任何地方 —— 下一步在 dashboard 里按库名选就行。

### 3. 绑 D1 并建表

**绑定**：Workers & Pages → 项目 → Settings → Functions → **D1 database bindings** → 新增一条：

| 字段 | 值 |
| --- | --- |
| Variable name | `DB` |
| D1 database | `arkplots-records` |

`DB` 必须和 `functions/api/records.ts` 里的 `env.DB` 一字不差。绑定改动后要**重新部署**才生效。

**建表**：项目 → 该 D1 数据库 → **Console**，把 `scripts/d1-schema.sql` 的内容粘进去执行。
（也可以走 wrangler：在仓库根临时放一份 `wrangler.toml` 填上 `database_id`，再跑
`npx wrangler d1 execute arkplots-records --remote --file=scripts/d1-schema.sql`。这份文件不进仓库。）

### 4. 推送并部署

```sh
git push -u origin cloud
```

Production branch 为 `cloud`，Cloudflare 会自动构建部署。

### 5. 用 Cloudflare Access 挡住别人

Pages 项目 Settings 里那个 "Enable access policy" 开关**只保护 preview 部署，不保护生产
`*.pages.dev`**。完整做法：

1. Workers & Pages → 项目 → Settings → **Enable access policy**
2. 对 preview 生成的那条 policy 点 **Manage** → Access → Applications → 选该项目 → **Configure**
3. 在 **Public hostname** 里把 Subdomain 的通配符 `*` **删掉**保存（可能需顺手改 Application name 才不报错）
4. 回到项目 Settings 再点一次 Enable access policy，确认现在有两条 policy：一条管 `*.pages.dev`，
   一条管 `*.<项目>.pages.dev`（preview）

这样生产域名就套上 Access 了，不需要买自定义域名。

## 本地验证

改动 shim 或合并朋友的更新之后，**务必跑一遍**：

```sh
# 1. 构建前端 + 后处理（内联 Plotline.json、注入 shim）
cd web && npm install && npm run build && node ../scripts/build-static.mjs && cd ..

# 2. 同步语义回归测试（需要先完成第 1 步；不需要 Cloudflare 配置，也不用登录）
node scripts/test-static-api-shim.mjs
```

第 2 步覆盖：补齐未知章节、只提交差异键、两台设备互不覆盖、断网入队与恢复补传、
从未同步过且断网时返回 503、服务端报错如实上抛、刷新页面后同步、离线优先级。

想把 Functions + D1 也在本地跑起来再验证（这步才需要 wrangler 和一份本地配置）：

```sh
# 临时本地配置。写进 .git/info/exclude（不进仓库）就不会出现在 git status 里
cat > wrangler.toml <<'EOF'
name = "arkplots"
pages_build_output_dir = "web/dist"
compatibility_date = "2026-09-01"

[[d1_databases]]
binding = "DB"
database_name = "arkplots-records"
database_id = "<你的 database_id>"
EOF

npx wrangler d1 execute arkplots-records --local --file=scripts/d1-schema.sql
npx wrangler pages dev web/dist        # 默认 http://127.0.0.1:8788
```

不打算本地调试就整段跳过 —— 在 preview 部署里验证更接近真实环境。

## 行为说明

- **跨设备**：手机上标记后，电脑上点一次「刷新数据」（或重新加载页面）即可看到。
  应用只在挂载和点该按钮时拉取记录，没有实时推送 —— 做自动刷新要改 `App.tsx`（上游文件），
  会破坏「rebase 上游零冲突」这个性质，故不做。
- **只提交差异键**：前端每次保存都会提交整份映射，shim 会与已知状态做差，只把改动的键发给服务端
  （后端逐键 upsert）。因此两台设备各标各的章节互不覆盖；同一章节同时改则后写的赢。
  这是「真同步」和「整份覆盖」的分界。
- **离线**：网络不可达时，读走 localStorage 镜像；标记先入本地队列（`arkplots.records.pending`），
  下次加载时自动补传。从未同步过且断网 → 返回 503，而不是假装一份空记录。
- **服务端真报错时如实上抛**（错误横幅），不会假装存上了。

## 维护注意

- **`scripts/` 被上游 `.gitignore` 忽略**（第 219 行，上游把它当一次性脚本目录）。
  在这个目录下新增文件、甚至修改**已跟踪**的文件，普通 `git add` 都会被拒绝，
  必须走 `-f`，否则改动会被静默漏掉：
  ```sh
  git add -f scripts/d1-schema.sql scripts/test-static-api-shim.mjs
  ```
  `functions/` 和 `DEPLOY-RECORDS.md` 不在忽略范围内，正常 `git add` 即可。
- **仓库的 `.gitignore` 保持与上游一致**，所以本地 wrangler 产生的状态（`.wrangler/`）和临时配置
  （`wrangler.toml`）不会被忽略。不想让它们出现在 `git status` 里，就写进 `.git/info/exclude`
  （只影响本机，不产生提交）。
- 若朋友之后更新了 `scripts/static-api-shim.js`，合并后重跑「本地验证」第 2 步。

## 排错

- 页面报 `no such table: records` → 第 3 步建表没跑，或跑到了另一个数据库。
- 写记录一直 500 / 日志里报 `env.DB` 相关错误 → dashboard 的 D1 绑定没配，或 Variable name
  不是 `DB`；绑定改完要重新部署。
- 另一台设备看不到记录 → 先确认点过「刷新数据」；再看云端：
  `npx wrangler d1 execute arkplots-records --remote --command "SELECT * FROM records LIMIT 10"`
- 如果以后真往仓库里放了 `wrangler.toml`，它就成了「唯一真相」：dashboard 里对应的构建/绑定字段会
  变成只读，两边不一致会直接构建失败。本方案刻意不放它
