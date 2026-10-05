# wcode

一个极简但完整的 coding agent CLI，支持**自定义模型 / 厂商配置**。零运行时依赖（Node ≥ 18 原生 `fetch`），交互式 REPL 与一次性 print 模式，内置文件读写、编辑、shell 等工具。

设计参考了 [earendil-works/pi](https://github.com/earendil-works/pi)。

## 功能

- **可插拔模型厂商**：`~/.wcode/config.json` 里任意添加厂商，支持三种协议：`openai-completions`（Chat Completions）、`anthropic-messages`（Anthropic Messages）、`openai-responses`（Responses API）；内置 anthropic / openai / zhipu / deepseek / moonshot / dashscope / openrouter / google / ollama 目录，可覆盖、可扩展
- **API Key 灵活解析**：字面量、`${ENV}` 环境变量、`!command` 执行命令取输出（如 `!op read ...`、`!pass show ...`）
- **Agent 循环**：流式采样 → 收集 tool_call → 执行（只读工具并行、写工具串行）→ 结果回灌 → 直到模型不再调用工具
- **内置工具**：`read`（行号 + 分页 + 2000 字符/行截断 + EOF 提示 + 图片）、`write`、`edit`（唯一精确匹配 + **多级 fallback**：行 trim / 块锚点相似度 / 缩进灵活 / 转义容错，附带防呆守卫 + `replace_all`）、`bash`（超时 + 输出截断 + 全量落盘）、`grep`（优先 ripgrep，内置回退）、`glob`、`ls`
- **TUI**：Claude Code 式界面——底部边框输入框 + 状态栏（模型 · 目录 · token · **上下文占比** · **累计成本**）、斜杠命令菜单（↑↓ 选择）、`/models` 交互式模型切换器、`@文件` 补全菜单、粘贴长文本折叠为 `[Pasted ~N lines]` 占位符（发送时自动展开）、动画 loading（计时 + esc×2 打断）、流式 Markdown 渲染、回合结束的**文件变更汇总行**（`Changed 1 file: app.py +3 -3`）
- **会话模式**（`shift+tab` 循环 build → edit → plan，参考 claude-code 三态 / opencode 的 build/plan agent）：**build** 默认，写操作逐个询问；**edit** 自动接受文件编辑（bash 仍询问）；**plan** 只读调研，write/edit/bash 在工具层硬门控（`--yolo` 也绕不过），模型用 `exit_plan` 提交计划——自动存档到 `.wcode/plans/`，`y` 批准立即切回 build 实现，`n` 继续打磨；`/mode [build|edit|plan]`、`--edit`、`--plan` 均可切换；`yolo` 保持独立开关（全放行）
- **任务清单**（claude-code TodoWrite 风格）：模型对多步任务用 `todo_write` 维护清单——TUI 状态栏实时显示 `n/m tasks`，工具卡片渲染 ☐/◐/☑ 清单，`/todos` 随时查看，清单随会话持久化、`/resume` 自动恢复
- **上下文管理**：`/compact`（LLM 摘要）+ `/prune` 与自动 **prune 式压缩**（上下文超窗口 60% 时自动清掉老工具输出，保留最近一段的完整结果，参照 opencode）
- **安全**：交互中写文件 / 执行命令默认询问（y/N），`--yolo` 或 `/yolo` 跳过；print 模式默认拒绝写操作
- **会话**：JSONL 追加式持久化，`-c` 继续上次会话、`/resume` 恢复历史会话、`/compact` 压缩上下文
- **REPL**：流式输出、thinking 流（DeepSeek R1 等）、工具卡片、token/费用统计、斜杠命令

## 安装

```bash
npm install        # 安装 dev 依赖（typescript/tsx）
npm run build      # 编译到 dist/
npm link           # 可选：全局注册 wcode 命令
```

未构建时 `bin/wcode.js` 会自动回退到 `tsx src/cli.ts`（需要 `npm install`）。

## 快速开始

```bash
# 1. 保存一个厂商的 key（写入 ~/.wcode/config.json）
wcode key zhipu "$ZHIPU_API_KEY"

# 2. 交互模式
wcode

# 3. 一次性模式
wcode -p "这个仓库是做什么的？"

# 指定模型 / 继续上次会话
wcode -m deepseek/deepseek-chat
wcode -c
```

配置了任一厂商 key 的环境变量（如 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`）即可直接使用，无需配置文件。

## 自定义厂商

`~/.wcode/config.json`（支持 `//` 注释；路径可用 `WCODE_DIR` 覆盖）：

```jsonc
{
  // 默认模型，格式 "provider/model-id"
  "defaultModel": "zhipu/glm-4.6",

  "providers": {
    // 覆盖内置厂商：只需写要改的字段，内置模型目录保留
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com"   // 指向代理
    },

    // 全新厂商：OpenAI 兼容协议（DeepSeek/GLM/Kimi/Ollama/vLLM/OneAPI...）
    "zhipu": {
      "api": "openai-completions",
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "apiKey": "${ZHIPU_API_KEY}",
      "models": [
        { "id": "glm-4.6", "name": "GLM-4.6", "contextWindow": 200000, "maxTokens": 128000,
          "cost": { "input": 0.6, "output": 2.2 } }
      ]
    },

    // OpenAI Responses 协议的厂商（新版 /v1/responses 端点）
    "my-responses": {
      "api": "openai-responses",
      "baseUrl": "https://open.bigmodel.cn/api/v1",   // 适配器自动拼 /responses
      "apiKey": "${ZHIPU_API_KEY}",
      "models": [{ "id": "glm-5.3-flash" }]
    },

    // Anthropic 协议的厂商
    "my-anthropic": {
      "api": "anthropic-messages",
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",  // 适配器自动拼 /v1/messages
      "apiKey": "!pass show anthropic",          // 从密码管理器取
      "headers": { "x-custom": "value" },
      "models": [{ "id": "glm-5.3-flash" }]
    }
  }
}
```

规则：

- `models` 数组按 `id` **upsert** 进内置目录（同 id 覆盖、新 id 追加）；设为 `[]` 可清空内置列表
- `apiKey` / `headers` 的值支持三种解析：`"sk-xxx"` 字面量、`"${VAR}"/"$VAR"` 环境变量、`"!cmd"` 命令输出（`$$` 转义字面 `$`）
- OpenAI 兼容厂商的方言差异用 `compat` 消化：

```jsonc
{
  "api": "openai-completions",
  "baseUrl": "https://api.openai.com/v1",
  "compat": {
    "maxTokensField": "max_completion_tokens",   // o 系 / gpt-5 需要
    "supportsUsageInStreaming": false,           // 老网关不认 stream_options 时关掉
    "reasoningField": "reasoning",               // 推理内容的字段名（默认 reasoning_content）
    "disableSystemRole": false                   // 个别端点不吃 system role
  }
}
```

## CLI

```
wcode                          交互会话（TTY 下进入 TUI：边框输入框 + 状态栏 + 流式渲染）
wcode --plain                  简易 readline 界面（管道/脚本场景自动启用）
wcode "任务描述"                交互会话并附带初始任务
wcode -p "一次性问题"           打印答案后退出
wcode -m provider/model        指定模型
wcode --yolo                   跳过权限询问
wcode --edit                   以 edit 模式启动（文件编辑自动接受，bash 仍询问）
wcode --plan                   以 plan 模式启动（只读调研 + 计划审批）
wcode -c                       继续当前目录上次的会话
wcode -r <n>                   恢复第 n 个会话
wcode models                   列出所有模型（✓ = key 可用）
wcode key <provider> <key>     保存某厂商的 API key
wcode sessions                 列出会话
```

REPL 内命令：`/help` `/model [provider/id]` `/models` `/mode [build|edit|plan]` `/plan [on|off]` `/todos` `/clear` `/compact` `/sessions` `/resume <n>` `/yolo` `/cost` `/exit`

TUI 快捷操作：`Enter` 发送 · `\` + `Enter` 软换行（多行输入） · 粘贴多行文本自动成段 · `↑/↓` 历史 · `Tab` 补全斜杠命令 · **`Shift+Tab` 循环 build ↔ edit ↔ plan 模式** · `Esc`/`Ctrl+C` 打断当前任务（输入框为空时 `Ctrl+C` 退出） · 输入 `/` 时实时过滤命令菜单。

## 会话模式

三档模式控制"模型可以动什么"，`Shift+Tab` 随时循环切换：

- **build**（默认）：每次写文件 / 跑命令都询问（y/N）
- **edit**（`--edit` / `/mode edit`）：文件编辑自动接受，**bash 仍然询问**——改代码省手，跑命令把关；工具层的 `mutation: "file" | "shell"` 类别决定归属
- **plan**（`--plan` / `/mode plan`）：只读调研。模型只看得到 `read / grep / glob / ls / todo_write / exit_plan`，即使尝试写操作也会被拦截并收到解释性错误（`--yolo` 不能绕过）；调研完成后模型用 `exit_plan` 提交计划 → 计划存档到 `.wcode/plans/<时间戳>.md` → 审批框 `y` 批准：立即切回 build 模式开始实现，`n` 拒绝：留在 plan 模式按反馈继续打磨

`yolo`（`--yolo` / `/yolo`）是独立于三档的全放行开关，与 claude-code 的 bypass permissions 同构；优先级为 **plan > yolo > edit > ask**。

## 任务清单

模型面对多步任务时用 `todo_write` 维护一份结构化清单（claude-code TodoWrite 风格，整表替换）：

- **给模型**：工具卡回显进度（`todos 1/3`），系统提示词约定"3 步以上就用、同时只有一个 in_progress、完成即标记"
- **给你**：TUI 状态栏常驻 `· 1/3 tasks` 计数，工具卡片渲染 ☐ 待办 / ◐ 进行中 / ☑ 完成清单，`/todos` 随时打印
- **持久化**：清单以独立行追加进会话 JSONL，`/resume` 恢复上次进度；`/clear` 一并清空

## 项目指令

工作目录下的 `WCODE.md` / `AGENTS.md` / `CLAUDE.md` 会自动注入系统提示词（优先按此顺序）。

## 架构

```
src/
├── types.ts          统一消息 / 内容块 / 流事件 / Model / Provider 类型
├── config.ts         配置加载、内置厂商目录、${ENV}/!command 值解析
├── ai/
│   ├── sse.ts             手写 SSE 解析
│   ├── adapter-base       重试 / 错误整形 / 事件队列
│   ├── anthropic.ts       Anthropic Messages 协议适配器
│   ├── openai.ts          OpenAI Chat Completions 协议适配器（兼容各家方言）
│   ├── openai-responses.ts OpenAI Responses API 协议适配器
│   └── index.ts           协议名 → 适配器注册表
├── agent/agent.ts    主循环：流式采样、tool_call 收集、并行/串行调度
├── tools/            read/write/edit/bash/grep/glob/ls/exit_plan/todo_write + 注册表（plan/edit 门控在这里）
├── session/store.ts   JSONL 会话持久化
├── system-prompt.ts   系统提示词组装 + 项目指令注入
├── ui/
│   ├── session.ts     SessionController：会话状态 + 斜杠命令 + agent 接线（前端共享）
│   ├── tui.ts         TTY 前端：边框输入框、状态栏、流式 Markdown、原始模式编辑器
│   ├── keys.ts        终端输入序列解析器（移植自 opentui parse.keypress，MIT）
│   ├── plain.ts       非 TTY 前端：readline 管道模式（脚本/测试用）
│   └── render.ts      ANSI 渲染助手
└── cli.ts             参数解析、print 模式
```

借鉴的几个关键设计：

- **模型是纯数据记录，协议是适配器**（pi）：新厂商 = 配置里的一条记录，不是代码
- **循环退出看消息里有无 tool_call 块，而非 stop_reason**（claude-code：stop_reason 不可靠）
- **edit 用唯一 old_string 精确替换**，截断的 tool_call 不执行而是让模型重发
- **会话是 append-only JSONL**，可安全恢复
- **Plan 模式是两层门控**（pi/opencode）：工具集切换（plan 模式模型看不到写工具）+ 执行层拦截（被拦调用以带原因的错误结果回灌，模型能自行调整路线）；批准流是 exit_plan 工具 + 对话框，批准即切回 build 连续执行（claude-code 的 approve→proceed 流）

## 测试

```bash
npm test     # 单元测试 + 三个 mock 服务器（OpenAI / Anthropic / Responses 协议）的端到端测试
```

端到端测试覆盖：流式输出、跨 chunk 的 tool_call 参数拼装、工具结果回灌、写文件、权限拒绝、`!command`/`${ENV}` key 解析、配置合并、会话持久化、**plan 模式完整审批流**（exit_plan 批准→切 build 实现 / 拒绝→保持只读）。三种协议均已用智谱 GLM 真实端点实测验证。

## License

MIT
