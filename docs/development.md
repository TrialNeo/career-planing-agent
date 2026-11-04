# 开发与验收

要求 Node.js 24；`.nvmrc` 与 `.node-version` 声明主版本。Windows 可用已安装的 Node 版本管理器切换，使用 `node --version` 确认后运行命令。安装锁定依赖使用 `npm ci --legacy-peer-deps`；根目录 `package-lock.json` 是依赖锁。

开发启动：`npm run dev`，访问 `http://127.0.0.1:5173`；Vite 将 `/api` 转发到 `127.0.0.1:3001`。生产构建后 `npm start` 在 `127.0.0.1:3001` 同时提供页面与 API。`PORT` 可更改生产端口；开发代理使用默认端口。

默认启动即按工作簿 SHA256 幂等导入知识。也可单独运行 `npm run import:knowledge`。CLI 支持工作簿和数据库路径两个位置参数；Windows 路径含括号时必须使用引号。原文件保留，缺失招聘链接和采集时间为 `null`。

使用前先注册账号并登录。首次注册的账号接收旧版本的本机数据，不移动原文件。注册前请确认本机已有数据应归属哪个账号；后续账号从空白状态开始。账号与会话索引保存在根 `.local/career.sqlite`，后续用户的数据在 `.local/users/<用户ID>/`。备份与恢复应包含整个 `.local/`，以同时保留账号索引和各用户数据。当前不提供密码找回界面。

模型配置由维护者直接编辑服务端 `.local/model.json`。首次部署参考根目录 `model.example.json`，创建包含 `baseUrl`、`model`、`apiKey` 的 JSON 文件；已有文件直接沿用，不覆盖。应用只使用这一个文件，不读取 `CAREER_MODEL_*` 环境变量或用户目录中的旧模型文件。配置在服务启动时载入，修改后需重启。所有账号共用同一份配置，前端完全没有配置入口，HTTP 也不返回服务地址、模型名称或 Token。不要把真实文件写入 Git、测试输出或客户端构建产物。

运行验证：

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:live
```

Playwright 默认使用已安装的 Microsoft Edge；其他环境可设置 `PLAYWRIGHT_CHANNEL=chromium` 并通过 `npx playwright install chromium` 安装浏览器。端到端测试自动启动仅供测试的内存数据库后端，端口 `3002`；包含界面隔离测试与真实 HTTP/SSE/业务工具闭环，模型决策由明确的测试载体提供。生产入口始终使用 pi。

`npm run test:live` 由维护者在服务端运行，使用统一的 `.local/model.json`，实际检查文本流、工具调用及随机 token 工具结果回传。未配置时退出码为 `2`，不把缺少服务当成通过。该检查会向配置的服务发出少量模型请求，不提供浏览器调用入口。

服务保存事件后再传输，SSE 使用序号恢复；取消保留已经提交的业务操作。重启会将未结束运行标记为 interrupted，并保存已有部分回复。生产入口使用独立 SQLite 锁数据库，持有进程级独占事务，进程退出后操作系统自动释放，以防两个进程同时恢复和使用业务数据库。关闭后可备份整个 `.local/`；不要在数据库仍有写入时只复制主 SQLite 文件。

提交成果支持文字、代码片段与链接。应用不获取链接内容、不执行代码；评估仅依据原消息内容，未实际运行的代码不能被记为运行通过。
