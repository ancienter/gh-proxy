# gh-proxy

## 简介

github release、archive以及项目文件的加速项目，支持clone，部署在 Cloudflare Workers 上

## 演示

[https://gh.api.99988866.xyz/](https://gh.api.99988866.xyz/)

演示站为公共服务，如有大规模使用需求请自行部署，演示站有点不堪重负

![imagea272c95887343279.png](https://img.maocdn.cn/img/2021/04/24/imagea272c95887343279.png)

当然也欢迎[捐赠](#捐赠)以支持作者

## 使用

直接在copy出来的url前加`https://gh.api.99988866.xyz/`即可

也可以直接访问，在input输入

***大量使用请自行部署，以上域名仅为演示使用。***

访问私有仓库可以通过

`git clone https://user:TOKEN@ghproxy.com/https://github.com/xxxx/xxxx` [#71](https://github.com/hunshcn/gh-proxy/issues/71)

以下都是合法输入（仅示例，文件不存在）：

- 分支源码：https://github.com/hunshcn/project/archive/master.zip

- release源码：https://github.com/hunshcn/project/archive/v0.1.0.tar.gz

- release文件：https://github.com/hunshcn/project/releases/download/v0.1.0/example.zip

- 分支文件：https://github.com/hunshcn/project/blob/master/filename

- commit文件：https://github.com/hunshcn/project/blob/1111111111111111111111111111/filename

- gist：https://gist.githubusercontent.com/cielpy/351557e6e465c12986419ac5a4dd2568/raw/cmd.py

## cf worker版本部署

本项目是标准的 Cloudflare Workers 项目（TypeScript + Wrangler），入口为 `src/index.ts`，构建配置为 `wrangler.jsonc`。主页静态文件内置在 `public/`，通过 Workers Static Assets 提供，不依赖外部站点。

### Git 仓库自动部署（推荐）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 `Workers & Pages`，点击 `Create`，选择 `Import a repository`（首次需要授权 GitHub 账号）。
2. 选择本仓库和部署分支（本仓库为 `master`）。
3. Build command 留空，Deploy command 保持默认的 `npx wrangler deploy`，点击 `Deploy`。
4. 之后每次 push 到该分支都会自动构建部署。Wrangler 版本取自 `package.json`。

免费套餐包含每月 3000 分钟构建时长。

### 手动部署

有 Node.js 环境时本地执行：

```
npm install
npm run deploy
```

入口是 TypeScript 且依赖内置静态资源，不再支持复制单文件到 Dashboard 在线编辑器。

### 配置

配置项写在 `wrangler.jsonc` 的 `vars` 中（也可在 Dashboard 的 Worker 设置里修改），本地开发可放在 `.dev.vars`：

- `ASSET_URL`：主页地址。留空（默认）使用内置 `public/` 资源；填写外部地址则回源该地址，例如 `https://hunshcn.github.io/gh-proxy/`
- `PREFIX`：前缀，默认（根路径情况为"/"），如果自定义路由为 example.com/gh/*，请将 PREFIX 改为 '/gh/'。请求路径不匹配前缀时返回 404
- `JSDELIVR`：分支文件使用 jsDelivr 镜像的开关，`"1"` 开启，`"0"` 关闭
- `WHITE_LIST`：白名单，逗号分隔，路径中包含任一字符才通过，留空表示不限制

### 行为说明

- 上游白名单：仅 `github.com`、`*.github.com`、`*.githubusercontent.com`（含 `objects.`/`codeload.`/`raw.`/`gist.`/`api.`），且必须为 https；其他目标返回 403，跳转目标同样受限
- 缓存：`/releases/download/` 资产与 tag archive 长期缓存（单个对象上限 400MB，超过则只流式转发不缓存）；`.db` 等滚动资产短 TTL，配合 `If-None-Match`/`If-Modified-Since` 条件请求（未变化返回 304）；带 `Authorization` 的私有仓库请求绕过缓存；错误响应不缓存
- 响应头 `x-proxy-cache: HIT|MISS|BYPASS` 可观察缓存状态；Range/断点续传命中缓存时由边缘直接切片返回 206，HEAD 返回与 GET 相同的头
- `GET /healthz`：健康检查，不访问上游（不受 PREFIX 影响）
- 限流：代理路径 per-IP 60 请求/分钟，使用 Rate Limiting binding。该限流是尽力而为的近似值（计数器按机器本地缓存、异步同步，突发流量可能被分散到多台机器），需要严格限流可在 Cloudflare 控制台加 WAF Rate limiting rule
- Smart Placement：Worker 尽量调度到靠近 GitHub 的位置，降低回源 RTT
- 日志：代理请求与错误响应记录路径、方法、状态码、耗时、缓存状态；静态资源流量不记日志，不记录请求头

### 开发与测试

- `npm run dev`：本地开发（需要能运行 workerd 的环境）
- `npm test`：Vitest + `@cloudflare/vitest-plugin`，测试运行在真实 Workers 运行时里，出站请求全部 mock
- `npm run typecheck`：TypeScript 类型检查
- `npm run cf-typegen`：按 `wrangler.jsonc` 重新生成 `worker-configuration.d.ts`（绑定类型）。使用 `--include-runtime false`，runtime 类型由 `@cloudflare/workers-types` 提供；升级 `compatibility_date` 时同步升级该依赖

CI（GitHub Actions）执行类型生成一致性检查、`typecheck`、`test` 和 `wrangler deploy --dry-run`。

## Cloudflare Workers计费

到 `overview` 页面可参看使用情况。免费版每天有 10 万次免费请求，并且有每分钟1000次请求的限制。

如果不够用，可升级到 $5 的高级版本，每月可用 1000 万次请求（超出部分 $0.5/百万次请求）。

## Changelog

* 2020.04.10 增加对`raw.githubusercontent.com`文件的支持
* 2020.03.23 新增了clone的支持
* 2020.03.22 初始版本

## 链接

[我的博客](https://hunsh.net)

## 参考

[jsproxy](https://github.com/EtherDream/jsproxy/)

## 捐赠

![wx.png](https://img.maocdn.cn/img/2021/04/24/image.md.png)
![ali.png](https://www.helloimg.com/images/2021/04/24/BK9vmb.md.png)
