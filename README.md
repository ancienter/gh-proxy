# gh-proxy

## 简介

github release、archive以及项目文件的加速项目，支持clone，有Cloudflare Workers无服务器版本以及Python版本

## 演示

[https://gh.api.99988866.xyz/](https://gh.api.99988866.xyz/)

演示站为公共服务，如有大规模使用需求请自行部署，演示站有点不堪重负

![imagea272c95887343279.png](https://img.maocdn.cn/img/2021/04/24/imagea272c95887343279.png)

当然也欢迎[捐赠](#捐赠)以支持作者

## python版本和cf worker版本差异

- python版本支持进行文件大小限制，超过设定返回原地址 [issue #8](https://github.com/hunshcn/gh-proxy/issues/8)

- python版本支持特定user/repo 封禁/白名单 以及passby [issue #41](https://github.com/hunshcn/gh-proxy/issues/41)

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

本项目是标准的 Cloudflare Workers 项目，包含 `wrangler.toml`、`package.json`，入口为 ES module 语法的 `index.js`。

### Git 仓库自动部署（推荐）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 `Workers & Pages`，点击 `Create`，选择 `Import a repository`（首次需要授权 GitHub 账号）。
2. 选择本仓库和部署分支（本仓库为 `master`）。
3. Build command 留空，Deploy command 保持默认的 `npx wrangler deploy`，点击 `Deploy`。
4. 之后每次 push 到该分支都会自动构建部署。Wrangler 版本取自 `package.json`。

免费套餐包含每月 3000 分钟构建时长。

### 手动部署

1. 首页：https://workers.cloudflare.com

2. 注册，登陆，`Start building`，取一个子域名，`Create a Worker`。

3. 复制 [index.js](https://cdn.jsdelivr.net/gh/ancienter/gh-proxy@master/index.js) 到左侧代码框，`Save and deploy`。如果正常，右侧应显示首页。代码不配置任何变量也能跑，读取默认值；如需自定义，见下方配置说明。

4. 有 Node.js 环境也可以在本地执行 `npm install && npm run deploy`。

### 配置

配置项写在 `wrangler.toml` 的 `[vars]` 中（也可在 Dashboard 的 Worker 设置里修改），本地开发可放在 `.dev.vars`：

- `ASSET_URL`：静态资源的 url（实际上就是现在显示出来的那个输入框单页面）
- `PREFIX`：前缀，默认（根路径情况为"/"），如果自定义路由为 example.com/gh/*，请将 PREFIX 改为 '/gh/'
- `JSDELIVR`：分支文件使用 jsDelivr 镜像的开关，`"1"` 开启，`"0"` 关闭
- `WHITE_LIST`：白名单，逗号分隔，路径中包含任一字符才通过，留空表示不限制

本地开发：`npm install && npm run dev`。

## Python版本部署

### Docker部署

```
docker run -d --name="gh-proxy-py" \
  -p 0.0.0.0:80:80 \
  --restart=always \
  hunsh/gh-proxy-py:latest
```

第一个80是你要暴露出去的端口

### 直接部署

安装依赖（请使用python3）

```pip install flask requests```

按需求修改`app/main.py`的前几项配置

*注意:* 可能需要在`return Response`前加两行
```python3
if 'Transfer-Encoding' in headers:
    headers.pop('Transfer-Encoding')
```

### 注意

python版本的机器如果无法正常访问github.io会启动报错，请自行修改静态文件url

python版本默认走服务器（2021.3.27更新）

## Cloudflare Workers计费

到 `overview` 页面可参看使用情况。免费版每天有 10 万次免费请求，并且有每分钟1000次请求的限制。

如果不够用，可升级到 $5 的高级版本，每月可用 1000 万次请求（超出部分 $0.5/百万次请求）。

## Changelog

* 2020.04.10 增加对`raw.githubusercontent.com`文件的支持
* 2020.04.09 增加Python版本（使用Flask）
* 2020.03.23 新增了clone的支持
* 2020.03.22 初始版本

## 链接

[我的博客](https://hunsh.net)

## 参考

[jsproxy](https://github.com/EtherDream/jsproxy/)

## 捐赠

![wx.png](https://img.maocdn.cn/img/2021/04/24/image.md.png)
![ali.png](https://www.helloimg.com/images/2021/04/24/BK9vmb.md.png)
