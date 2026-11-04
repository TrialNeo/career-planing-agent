# 职业规划 Agent

一个支持独立账号的职业规划与学习陪伴助手。通过聊天探索职业方向、确认目标和计划、安排每周行动，再根据成果与反馈调整下一步。每个账号的聊天、长期画像、已确认目标和学习记录独立保存；新建对话会保留当前账号的长期记忆，重要选择通过对话中的卡片确认。

知识库来自项目保留的岗位与课程工作簿，支持按方向、学历、经验和关键词查询，并追溯到工作表与行号。导入会重新计算统计比例，培养方案仅作为课程参考。

LLM 只使用服务端的 `.local/model.json`，所有用户共用且无法通过界面或 API 读取、修改。首次部署可参照 [model.example.json](model.example.json) 创建该文件，填写 `baseUrl`、`model`、`apiKey`；已有配置直接沿用。地址填写支持 **Responses API** 的 API 基址，例如 `https://example.com/v1`，由后端追加 `/responses`。修改配置后重启服务。

使用 Node.js 24，在项目根目录执行：

```powershell
npm install --legacy-peer-deps
npm run build
npm start
```

打开 <http://127.0.0.1:3001>，注册账号并登录即可使用。维护者可在服务端运行 `npm run test:live` 检查已配置服务的文本流、工具调用和工具结果回传。

首次注册的账号接收本机已有数据，继续使用 `.local/career.sqlite`。后续账号的数据保存在 `.local/users/<用户ID>/career.sqlite`，岗位知识库共用，整个 `.local/`（包括模型配置）均被 Git 忽略。旧版本的各用户模型配置文件不再读取。服务仍默认仅监听本机地址。保留原始静态演示 `index.html`，应用源码位于 `apps/`；运行、接口与验收说明见 [开发说明](docs/development.md) 和 [架构与边界](docs/architecture.md)。
