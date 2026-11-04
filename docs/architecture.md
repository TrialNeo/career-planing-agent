# 模块与接口边界

后端以 `module`、`platform`、`workflow` 组织业务与基础能力，独立的 `http` 层负责请求适配。`app.ts` 只装配依赖、恢复用户工作区并管理资源关闭；`http/index.ts` 装配 Express 应用，`http/router.ts` 挂载 API 与认证中间件，`http/routes/` 按健康检查、认证、会话、运行和交互分组处理路由。`platform/http` 仅提供通用请求防护、错误转换与静态页面服务，不导入业务模块。

HTTP 路由通过注入的账号工作区调用模块公开入口与顶层 workflow。认证中间件在所有私有路由前绑定账号上下文，运行/SSE 路由复用该身份验证订阅与重放。各业务模块仅依赖平台与本模块，workflow 通过模块 `index.ts` 跨模块编排；platform、module 和 workflow 都不反向依赖 HTTP 适配层。`tests/architecture.test.ts` 检查这些方向与内部依赖环。

`conversation` 保存消息、运行、事件、卡片与幂等记录；`learner` 保存画像、目标草案和能力证据；`planning` 管理版本化计划、里程碑和近期任务；`learning` 登记成果原消息与逐项评估；`knowledge` 导入和检索本地工作簿；`settings` 读取服务端模型配置文件；`auth` 管理账号与登录会话。长期画像、目标与学习记录属于登录账号，跨会话保留。

SQLite 初始化执行版本化 schema_migrations，运行表以部分唯一索引限制每个账号同时只能有一个 queued/running/cancelling 运行，不同账号可以并行。同步 savepoint 事务可嵌套，禁止将 Promise/模型请求放入事务。事务通知在最外层提交后发出；回滚时事件与通知一起丢弃。

服务端以账号创建独立的业务服务实例、SQLite 数据库、运行控制器与事件订阅。账号身份从随机会话 Cookie 获取，不接受客户端指定身份来取得权限。每次请求先校验会话，再将业务入口绑定到所属账号；他人的会话、运行、卡片和成果 ID 在当前数据库中不存在，统一返回 404。岗位知识库和服务端模型配置实例共用。首个账号在事务中取得旧数据所有权，不复制原数据；其他账号使用服务端生成 UUID 的独立目录。

LLM 配置只在启动时从 `.local/model.json` 读取，使用 `baseUrl`、`model`、`apiKey` 三个字段；不读取其他用户的模型文件或环境变量。所有账号均没有模型配置页面、配置读取/修改接口或在线配置测试接口；旧 `/api/settings/model` 与 `/api/settings/model/test` 返回 404。API 基址、模型名称和 Token 不传给浏览器或注入模型上下文。维护者修改文件后重启服务，并通过服务端 `test:live` 验证。原有全局文件继续使用，旧用户配置文件保持原样但不再生效。配置文件格式错误时只报告固定错误，不回显原始配置值。

密码使用随机盐和 scrypt 派生后保存；7 天登录会话使用 HttpOnly、SameSite=Strict Cookie，数据库只保存会话令牌的 SHA256 摘要。退出撤销当前会话并关闭其 SSE 连接，过期会话不能请求或重放数据。HTTPS 下 Cookie 自动增加 Secure。前端按用户 ID 保存会话选择，并在退出、账号切换、会话失效时清空视图；跨标签页同步身份。客户端请求额外携带预期账号标识，仅用于拒绝旧页面的延迟请求，不能用于授权。

对话 workflow 组装系统规则、业务状态、近期 40 条消息与有限历史摘要；完整聊天仍保存用于追溯。摘要只是截取的历史片段，不能覆盖已确认事实。工具身份由运行上下文注入，模型参数不包含用户、会话或运行 ID。

确认目标/计划需要服务端绑定的目标提案 ID 或计划 ID+版本。普通消息只启动新对话，不能批准提案。新提案使旧卡失效；新目标确认后停用旧计划及未完成任务；新计划确认会替代旧任务。已完成学习记录保留。任务采用 expectedRevision 乐观并发控制，滚动任务预算不得超过当前计划周投入分钟数。

成果登记和任务待评估状态在一个事务中写入；评估、能力证据与任务结果也在一个事务中写入。完成标准必须全部覆盖，结论只用「符合/未符合/证据不足」。原消息引用、任务版本与评估重复提交均被校验。写工具以 runId+toolCallId 保存结果，重复调用返回原结果；相同标识使用不同参数返回冲突。

浏览器仅使用以下接口，DTO、卡片与 SSE 事件类型在 `packages/contracts`：

| HTTP | 用途 |
| --- | --- |
| GET /api/health | 数据库与模型配置状态 |
| GET /api/auth/me | 当前账号或未登录状态、是否尚无账号 |
| POST /api/auth/register | username/password 注册，建立登录会话 |
| POST /api/auth/login | username/password 登录 |
| POST /api/auth/logout | 撤销当前登录会话并清除 Cookie |
| GET/POST /api/conversations | 分页会话历史/新会话 |
| GET /api/conversations/:id | 消息分页、待处理卡片、运行、到期提醒 |
| POST /api/conversations/:id/messages | clientRequestId+text，返回 202 和 messageId/runId |
| GET /api/runs/:id | 运行状态、lastSequence 和脱敏错误 |
| GET /api/runs/:id/events | SSE；Last-Event-ID 或 after 恢复 |
| POST /api/runs/:id/cancel | 停止后续执行 |
| POST /api/interactions/:id/answer | answers 或 decision；确认/修改/拒绝 |

SSE 事件为 run.started、message.delta、message.completed、tool.started、tool.completed、interaction.requested、interaction.updated、run.finished。事件含 runId、递增 sequence、timestamp 与 data，重连只重放数据库事件。状态包括 queued/running/waiting_input/completed/cancelling/cancelled/failed/interrupted。

健康检查与账号接口可在未登录时访问，其他 API 必须登录。健康检查在未登录时不返回任何账号的模型配置状态。账号为 3–32 位文字、数字、下划线或短横线，采用 NFKC 规范化且不区分大小写；密码为 8–128 位。注册和登录按来源限制尝试频率，错误不包含密码或令牌。

工具入口为 knowledge_search、user_state_get、profile_update、goal_propose、plan_save、task_upsert、submission_save、submission_get、review_save、interaction_request。使用 Zod 统一校验，JSON Schema 交给 pi，模块公开入口再次执行业务校验。pi 平台适配器不包含职业规划规则；规则与工具组合在 workflow/dialogue。

知识工作簿导入重新计算 115 条岗位中的 Java 覆盖 71/115、后端方向 61/115，纠正原统计页错误比例。学习路径可见表头与数据错位，导入依据公司、岗位、学历和方向对齐明细，再将第 5/6/7 列映射为加分材料/核心课程路径/毕业项目。实际课程 105 条，只作为培养方案参考。来源保留 SHA256 数据版本、工作表、Excel 行号、来源代号；原本没有的链接和采集时间为空。

应用默认仅监听回环地址，拒绝非本机 Host 和跨源请求，不提供画像/任务独立页面或通用 CRUD。错误统一为 code/message/retryable；不向客户端暴露原始模型异常和 Key。
