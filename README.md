# wcode

一个极简但完整的 coding agent CLI，支持**自定义模型 / 厂商配置**。零运行时依赖（Node ≥ 18 原生 `fetch`），交互式 REPL 与一次性 print 模式，内置文件读写、编辑、shell、联网、子代理与 MCP 工具。

设计参考了 [earendil-works/pi](https://github.com/earendil-works/pi)；压缩 / 插话队列 / 命令面板 / 会话选择器等机制参考了 [opencode](https://github.com/anomalyco/opencode)。

## 功能

- **可插拔模型厂商**：`~/.wcode/config.json` 里任意添加厂商，支持三种协议：`openai-completions`（Chat Completions）、`anthropic-messages`（Anthropic Messages）、`openai-responses`（Responses API）；内置 anthropic / openai / zhipu / deepseek / moonshot / dashscope / openrouter / google / ollama 目录，可覆盖、可扩展
- **API Key 灵活解析**：字面量、`${ENV}` 环境变量、`!command` 执行命令取输出（如 `!op read ...`、`!pass show ...`）
- **Agent 循环**：流式采样 → 收集 tool_call → 执行（只读工具并行、写工具串行）→ 结果回灌 → 直到模型不再调用工具；连接级重试（指数退避 2s→10s、最多 5 次、尊重 Retry-After，UI 实时显示 retrying 提示）；**流中断自动重试**（传输中途断流/卡死等瞬态错误自动重发该轮，最多 2 次，硬错误如 4xx 不重试）；**输出截断续写**（连续两次 length 截断即报错，不死循环）；**优雅步数收尾**（达到 60 轮上限后关闭工具，让模型文字总结收尾而非硬报错）；**反应式溢出恢复**（provider 报上下文超限时先 prune、再 compact，自动重试该轮）
- **提示词缓存**（anthropic-messages 协议默认开启）：请求自动附带 `cache_control` 断点——工具列表末尾、system、最后一条消息各一个；agent 每轮重发全量前缀，命中部分按 ~10% 计价（写入 1.25×），首 token 更快、长会话显著省成本、限流更少；成本统计按协议语义分别计价（Anthropic 缓存 token 独立报告、OpenAI 系折叠进 prompt_tokens）；厂商配置 `"promptCaching": false` 可关闭（兼容不接受未知字段的代理）
- **内置工具**：`read`（行号 + 分页 + 2000 字符/行截断 + EOF 提示 + 图片）、`write`、`edit`（唯一精确匹配 + **多级 fallback**：行 trim / 块锚点相似度 / 缩进灵活 / 转义容错，附带防呆守卫 + `replace_all`）、`bash`（超时 + 输出截断 + 全量落盘）、`grep`（优先 ripgrep，内置回退）、`glob`、`ls`
- **联网工具**：`webfetch`（抓取 URL → 纯文本，HTML 剥离、3MB 上限、head+tail 截断）、`websearch`（DuckDuckGo 检索，返回标题/链接/摘要）
- **子代理**：`task` 工具把聚焦的调研/独立任务委托给拥有独立上下文窗口的子代理——`explore`（只读、可并行、免询问）回收的是报告而非过程，主上下文不被探索噪音撑爆；`general` 拥有除 `task` 外的全套工具，写操作仍走权限流
- **MCP**：`mcpServers` 配置（用户 config.json + 项目 `.mcp.json`）接入 stdio MCP 服务器，工具以 `mcp__<server>__<tool>` 命名暴露给模型；服务器进程崩溃后**下次调用自动重启并重连**；`/status` 查看连接与工具数
- **自定义斜杠命令**：`.wcode/commands/*.md`（项目）与 `~/.wcode/commands/*.md`（用户）放 markdown 模板即可——frontmatter 写 `description` / `argument-hint`，正文用 `$ARGUMENTS` 接收参数；补全菜单与 `/help` 自动收录，print 模式同样生效
- **权限规则**：`~/.wcode/settings.json` 与 `.wcode/settings.json` 的 `permissions.allow / deny`（如 `"bash(git *)"`、`"bash(rm -rf *)"`），`--allowed-tools` / `--disallowed-tools` 追加；**deny 在任何模式下都生效（含 --yolo）**，allow 跳过询问；权限询问支持三答——`y` 放行一次、`a` **总是允许**（按调用主体生成规则，bash 取首词如 `bash(npm *)`，并写入项目 `.wcode/settings.json`，后续会话免询问）、`n` 拒绝
- **TUI**：底部边框输入框 + 状态栏（模型 · 目录 · token · **上下文剩余量**（绿→黄→红） · **累计成本** · 排队计数）、斜杠命令菜单（↑↓ 选择）、`/models` 交互式模型切换器、`/sessions` **交互式会话选择器**、`@文件` 补全菜单、粘贴长文本折叠为 `[Pasted ~N lines]` 占位符（发送时自动展开）、动画 loading（随机动词 + 计时）、流式 Markdown 渲染（diff 按行 +绿/−红 着色、thinking 流结束时显示耗时）、**Toast 轻通知**（重试/规则保存/标题生成等 5 秒即逝，不刷屏转录）、**命令面板**（`ctrl+p` 模糊搜索所有命令）、`ctrl+o` 在 `$EDITOR` 中编写当前输入、输入历史持久化（`~/.wcode/history.jsonl`，跨会话 ↑/↓ 翻阅）、抗闪烁重绘（光标隐藏 + 同步输出）、回合结束的**文件变更汇总行**（`Changed 1 file: app.py +3 -3`）；工具卡片 `⏺ 工具(参数)` + 结果 `⎿ 输出`；模式常驻提示行（edit/plan/yolo 激活时显示在输入框上方，`shift+tab` 循环即见）；空输入时提示 `? 快捷键 · ctrl+p 面板 · ! bash · # memory · / 命令 · @ 文件`
- **主题系统**：`/theme` 即时切换 `wcode-dark` / `wcode-light` / `mono`（按 COLORFGBG 自动检测亮暗），选择持久化到 `~/.wcode/settings.json`；`NO_COLOR` / `TERM=dumb` 自动退为无色
- **插话与排队**（opencode inbox 语义）：忙碌时继续输入 **Enter 默认插话（steer）**——消息在下一个工具回合边界注入当前运行，模型立刻看到；`alt+enter` 或 `/`、`!`、`#` 命令则进入队列，当前任务结束后逐条执行（状态栏显示 `⏎n` 排队计数）
- **输入前缀**：`! <命令>` 直接执行 shell 命令并回显输出（输出同时注入对话上下文，模型下一轮可引用）；`# <笔记>` 追加一行到项目记忆文件 `WCODE.md`；`?`（空输入时）打开快捷键面板；`wcode "任务"` 启动即自动开跑首个任务
- **会话模式**（`shift+tab` 循环 build → edit → plan）：**build** 默认，写操作逐个询问；**edit** 自动接受文件编辑（bash 仍询问）；**plan** 只读调研，write/edit/bash 在工具层硬门控（`--yolo` 也绕不过），模型用 `exit_plan` 提交计划——自动存档到 `.wcode/plans/`，`y` 批准立即切回 build 实现，`n` 继续打磨；`/mode [build|edit|plan]`、`--edit`、`--plan` 均可切换；`yolo` 保持独立开关（全放行）
- **任务清单**（TodoWrite 风格）：模型对多步任务用 `todo_write` 维护清单——TUI 状态栏实时显示 `n/m tasks`，工具卡片渲染 ☐/◐/☑ 清单，`/todos` 随时查看，清单随会话持久化、`/resume` 自动恢复
- **上下文管理**：`/compact` + `/prune [threshold]` 与自动 **prune 式压缩**（60% 窗口自动清老工具输出）+ **自动 compact v2**（预留制触发线：窗口 − max(15%, 16k)，接近上限自动摘要续命；摘要按 结构化模板（目标/决策/工作状态/下一步/相关文件）生成，**最近 ~12k tokens 的对话原文保留**、在 user 回合边界锚定（工具配对不拆散）；print 模式同样生效）
- **会话操作**：`/rewind`（列出用户回合，`/rewind <n>` 回滚到该轮之前，文件不动）、`/export`（导出 markdown 记录）、`/init`（分析仓库生成 WCODE.md）、`/status`（模型/权限/MCP/配置总览）
- **安全**：交互中写文件 / 执行命令默认询问（y/N），`--yolo` 或 `/yolo` 跳过（deny 规则仍拦截）；**内建密钥文件防护**——yolo/edit 模式下读 `.env` / `*.env` 类文件仍强制询问（`.env.example` 豁免，settings 显式 allow 优先）；print 模式默认拒绝写操作
- **会话**：JSONL 追加式持久化，`-c` 继续上次会话、`/resume` 恢复历史会话、`/compact` 压缩上下文；首轮问答后自动生成**会话标题**（≤100 字符，失败静默），`/sessions`、TUI 窗口标题与 `wcode sessions` 显示
- **配置热重载**：`config.json`、两级 `settings.json`、`.mcp.json` 变更自动重载（100ms 去抖）——权限规则即时生效、厂商/模型列表即时更新，无需重启；解析失败给出可见警告而非静默忽略
- **脚本化**：`-p --output-format json` 输出 `{result, model, is_error, inputTokens, outputTokens, cost}` 结构化结果；`--append-system-prompt` 追加系统提示词
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
  },

  // MCP stdio 服务器（也可放项目根目录 .mcp.json，项目配置按名覆盖）
  "mcpServers": {
    "fetch": { "command": "npx", "args": ["-y", "mcp-server-fetch"] },
    "my-tools": { "command": "node", "args": ["server.js"], "env": { "TOKEN": "${MY_TOKEN}" }, "timeout": 60000 }
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
wcode -p "..." --output-format json
                               结构化输出（result/model/is_error/tokens/cost）
wcode -p "..." --append-system-prompt "始终用中文回复"
                               系统提示词追加
wcode --allowed-tools "bash(git *),read"
                               追加 allow 规则（--disallowed-tools 为 deny）
wcode -m provider/model        指定模型
wcode --yolo                   跳过权限询问（deny 规则仍生效）
wcode --edit                   以 edit 模式启动（文件编辑自动接受，bash 仍询问）
wcode --plan                   以 plan 模式启动（只读调研 + 计划审批）
wcode -c                       继续当前目录上次的会话
wcode -r <n>                   恢复第 n 个会话
wcode models                   列出所有模型（✓ = key 可用）
wcode key <provider> <key>     保存某厂商的 API key
wcode sessions                 列出会话
```

REPL 内命令：`/help` `/model [provider/id]` `/models` `/mode [build|edit|plan]` `/plan [on|off]` `/init` `/todos` `/clear` `/compact` `/prune [threshold]` `/rewind [n]` `/export [file]` `/status` `/sessions` `/resume <n>` `/theme [name]` `/yolo` `/cost` `/exit`，外加 `~/.wcode/commands` 与 `.wcode/commands` 里的全部自定义命令

TUI 快捷操作：`Enter` 发送（忙碌时**插话**进当前任务） · `alt+enter` 排队到当前任务之后 · `Ctrl+J` 换行（`\` + `Enter` 软换行也可，多行输入） · 粘贴多行文本自动成段 · `↑/↓` 历史输入（持久化，光标在行首即可翻阅） · `Tab` 补全斜杠命令 · **`Shift+Tab` 循环 build ↔ edit ↔ plan 模式**（模式提示行常驻输入框上方） · **`Esc` `Esc` 双击打断当前任务**（5 秒窗口内按两次，防误触） · `Ctrl+C` 清空输入（空时再按退出；忙碌时立即打断） · **`Ctrl+P` 命令面板**（模糊搜索全部命令） · **`Ctrl+O` 在 `$EDITOR` 中编写当前输入** · `Ctrl+L` 清屏（会话保留，重绘首页） · `?` 快捷键面板（空输入时） · 输入 `/` 时实时过滤命令菜单、`@` 补全文件路径。

## 会话模式

三档模式控制"模型可以动什么"，`Shift+Tab` 随时循环切换：

- **build**（默认）：每次写文件 / 跑命令都询问（y/N）
- **edit**（`--edit` / `/mode edit`）：文件编辑自动接受，**bash 仍然询问**——改代码省手，跑命令把关；工具层的 `mutation: "file" | "shell"` 类别决定归属
- **plan**（`--plan` / `/mode plan`）：只读调研。模型只看得到 `read / grep / glob / ls / webfetch / websearch / task / todo_write / exit_plan`（`task` 在 plan 模式强制为只读子代理），即使尝试写操作也会被拦截并收到解释性错误（`--yolo` 不能绕过）；调研完成后模型用 `exit_plan` 提交计划 → 计划存档到 `.wcode/plans/<时间戳>.md` → 审批框 `y` 批准：立即切回 build 模式开始实现，`n` 拒绝：留在 plan 模式按反馈继续打磨

`yolo`（`--yolo` / `/yolo`）是独立于三档的全放行开关（bypass permissions 的同构物，deny 规则仍然生效）；优先级为 **plan > yolo > edit > ask**。

## 自定义斜杠命令

把常用工作流固化成命令模板——`.wcode/commands/*.md`（项目）与 `~/.wcode/commands/*.md`（用户级，同名时项目优先）：

```markdown
---
description: Review the current diff
argument-hint: [pr-number]
---
Review $ARGUMENTS against our coding standards. Focus on correctness and edge cases.
```

- `$ARGUMENTS` 替换为命令后的全部文本；模板没有占位符时参数追加为 `<arguments>` 段
- 输入 `/` 时命令进入补全菜单（显示 description），`/help` 一并收录
- 交互模式与 `-p` print 模式均可用（`wcode -p "/review 42"`）

## 权限规则

`~/.wcode/settings.json`（用户级）与 `.wcode/settings.json`（项目级）：

```jsonc
{
  "permissions": {
    "allow": ["bash(git *)", "bash(npm run *)", "read"],   // 免询问
    "deny":  ["bash(rm -rf *)", "bash(sudo *)"]            // 硬拦截，任何模式生效
  }
}
```

- 规则格式：`tool`（匹配该工具全部调用）或 `tool(pattern)`，`*` / `?` 通配；匹配对象是命令文本（bash）、相对路径（文件工具）、URL（webfetch）
- 优先级：**deny > allow > 询问**；deny 即便在 `--yolo` / edit 模式下也会拦截（模型会收到解释性错误并自行换路线）
- CLI 追加：`--allowed-tools "bash(git *)"`、`--disallowed-tools "bash(curl *)"`（逗号分隔）

## MCP

配置 stdio MCP 服务器（config.json 的 `mcpServers` 或项目根 `.mcp.json`，见上文示例），wcode 启动时连接并握手，工具以 `mcp__<server>__<tool>` 命名进入工具集：

- 权限语义未知 → 默认走询问流（可用 allow 规则放行，如 `"mcp__fetch(*)"`）
- 单个服务器崩溃 / 超时只影响自己，会话照常进行；`/status` 查看每个服务器的连接状态与工具数

## 任务清单

模型面对多步任务时用 `todo_write` 维护一份结构化清单（整表替换）：

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
├── jsonc.ts          共享 JSONC 注释剥离
├── settings.ts       settings.json 加载（用户 + 项目合并）
├── permissions.ts    权限规则解析/匹配/裁决（deny > allow > ask）
├── commands.ts       自定义斜杠命令发现 + $ARGUMENTS 展开
├── ai/
│   ├── sse.ts             手写 SSE 解析
│   ├── adapter-base       重试 / 错误整形 / 事件队列
│   ├── anthropic.ts       Anthropic Messages 协议适配器
│   ├── openai.ts          OpenAI Chat Completions 协议适配器（兼容各家方言）
│   ├── openai-responses.ts OpenAI Responses API 协议适配器
│   └── index.ts           协议名 → 适配器注册表
├── agent/
│   ├── agent.ts      主循环：流式采样、tool_call 收集、并行/串行调度、steer 队列、溢出恢复、优雅步数收尾
│   ├── prune.ts      60% 窗口的老工具输出清理
│   └── compact.ts    压缩 v2：预留制触发（窗口−max(15%,16k)）、结构化摘要、近期原文尾部保留
├── mcp/
│   ├── client.ts     stdio MCP 客户端（NDJSON JSON-RPC、握手、超时、崩溃自动重连）
│   └── index.ts      服务器发现（config + .mcp.json）、工具包装 mcp__server__tool
├── tools/            read/write/edit/bash/grep/glob/ls/webfetch/websearch/task/exit_plan/todo_write + 注册表（plan/edit/规则/密钥文件门控在这里）
├── session/store.ts   JSONL 会话持久化（含 rewind 用整表重写、标题行）
├── session/title.ts   会话标题一次性生成（≤100 字符，失败静默）
├── system-prompt.ts   系统提示词组装 + 项目指令注入 + append 追加
├── ui/
│   ├── session.ts     SessionController：会话状态 + 斜杠命令 + agent 接线 + 配置热重载 + 插话/排队池（前端共享）
│   ├── tui.ts         TTY 前端：边框输入框、状态栏、命令面板、对话框选择器、Toast、流式 Markdown、原始模式编辑器
│   ├── keys.ts        终端输入序列解析器（移植自 opentui parse.keypress，MIT）
│   ├── fuzzy.ts       零依赖模糊匹配（命令面板）
│   ├── theme.ts       主题系统（wcode-dark / wcode-light / mono，COLORFGBG 自动检测）
│   ├── plain.ts       非 TTY 前端：readline 管道模式（脚本/测试用）
│   └── render.ts      ANSI 渲染助手（主题在此打补丁生效）
└── cli.ts             参数解析、print 模式（JSON 输出、权限门、MCP、task）
```

借鉴的几个关键设计：

- **模型是纯数据记录，协议是适配器**（pi）：新厂商 = 配置里的一条记录，不是代码
- **循环退出看消息里有无 tool_call 块，而非 stop_reason**（stop_reason 不可靠）
- **edit 用唯一 old_string 精确替换**，截断的 tool_call 不执行而是让模型重发
- **会话是 append-only JSONL**，可安全恢复；rewind 用整表重写实现回滚
- **Plan 模式是两层门控**（pi/opencode）：工具集切换（plan 模式模型看不到写工具）+ 执行层拦截（被拦调用以带原因的错误结果回灌，模型能自行调整路线）；批准流是 exit_plan 工具 + 对话框，批准即切回 build 连续执行
- **子代理 = 一次性 Agent 实例**：独立消息数组、独立上下文，只把最终报告回灌主循环；explore 子代理的工具集在构造时就裁剪掉写工具，plan 模式下进一步强制 explore
- **权限是三层过滤**（deny 规则 → plan/yolo/edit 模式门 → allow 规则），deny 与 allow 都在工具执行前裁决，被拒调用以错误结果回灌

## 测试

```bash
npm test     # 单元测试 + 四个 mock 服务器（OpenAI / Anthropic / Responses 协议 + stdio MCP）的端到端测试
```

端到端测试覆盖：流式输出、跨 chunk 的 tool_call 参数拼装、工具结果回灌、写文件、权限拒绝、`!command`/`${ENV}` key 解析、配置合并、会话持久化、**plan 模式完整审批流**（exit_plan 批准→切 build 实现 / 拒绝→保持只读）、**MCP 工具往返**（stdio 握手 → tools/list → tools/call 回灌）、**task 子代理**（父循环 → explore 子循环 → 报告回灌）、**deny 规则在 --yolo 下拦截**、**自定义命令展开**、**--output-format json**、**重试策略**（退避/取消被拒 body/上限 5 次）、**错误停止时丢弃半截 tool_call**、**连续截断保护**、**上下文溢出→prune→重试恢复**、**插话 steer**（忙碌中注入下一请求）、**压缩 v2**（预留制触发线 + 尾部 user 边界锚定 + 摘要重写 + 标题生成）、**配置热重载**（会话中写 deny 规则即时生效）、**密钥文件防护**（yolo 下读 .env 仍询问）。三种协议均已用智谱 GLM 真实端点实测验证。

## License

MIT
