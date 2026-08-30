# 开发日志（DEVLOG）

## #3 · 2026-08-31 · DSH 后端完成首版实现并锁定 rc.2
- **落地**：新增可见但非默认的 `dsh-sdk` 后端；通过官方 JSON-RPC stdio 运行 `dsh-jsonrpc-agent`，同一飞书话题复用一个进程和稳定 `sessionId`，模型 / effort 切换或 Bridge 恢复时换进程但保留会话历史。
- **版本裁定**：空目录安装探针确认 19 个直接引用包均可精确锁定为 `0.1.1-rc.2`；真实 keyless profile 冒烟完成 `initialize` / `shutdown`，且子进程未监听 TCP 端口。复验命令：`node scripts/check-dsh-profile.mjs <backend-install-dir>`。
- **安全边界**：首版仅 `full`，`qa` / `write` 在启动前 fail closed；固定 native tools、关闭 telemetry、禁止 Code/PTC，不实现图片、goal、steer、compact、审批或历史选择器。provider key 由 DSH credentials provider 解析，Bridge 不读取 key 值。
- **验证**：协议传输、事件去重、安装回滚、跨 runtime 恢复、并发拒绝、中止与进程组回收均有独立 harness；真实 provider prompt 留给维护者在独立测试机器人中人工验证。

## #2 · 2026-08-22 · DSH 后端模型层改走 pi-ai 多 provider 路线
- **背景**：dsh-backend-design.md 假设 DeepSeek 官方 adapter + `DEEPSEEK_API_KEY`，但实际可用的是 MiniMax / Kimi / GLM 的 API key（另有 Grok 等订阅认证）；部署目标为远程机上 Bridge + 同机 DSH 子进程。
- **决策**：统一采用官方通用适配器 `@deepseek-ai/dsh-llm-pi-ai`（内建 MiniMax/Kimi/GLM/DeepSeek 目录路由，零代码接入），API key 走 `$DSH_HOME/.credentials.yaml`；订阅插件 `dsh-plugin-subscriptions` 降为 P4 可选。设计文档已就地修订（§4/§5.2/§6/§8.3/§10）。
- **理由**：pi-ai 一个适配器覆盖全部 provider（含 DeepSeek），端点/协议/思维链方言全部预置；订阅插件为第三方且 OAuth 依赖回环+浏览器，对无头远程机不友好（有 auth.json 迁移绕法但不宜进首版验收）。否掉的备选：保留 `dsh-llm-deepseek` 双适配器并存（profile 更厚、事件路径分叉）；自写 OpenAI 兼容适配器（pi-ai 已覆盖，无必要）。
- **教训**：effort 支持逐模型差异大（kimi-k3/glm-5.x 支持分档，kimi-k2.7-code/MiniMax 仅开关），`supportedEfforts` 必须逐模型声明，统一映射表会造成静默降级。详见 [dsh-backend-research.md](./design/dsh-backend-research.md)。

## #1 · 2026-08-20 · 选定 SDK JSON-RPC stdio 作为 DSH 后端协议
- **背景**：把 DeepSeek Harness（DSH）接入为 Bridge 第三种后端，需在 Headless CLI / ACP / Web API / SDK JSON-RPC 四种程序化接入面中选型。
- **决策**：采用 SDK JSON-RPC stdio 子进程（后端 id `dsh-sdk`），每飞书话题一进程一稳定 sessionId，中止=杀进程组、恢复靠 JSONL 持久化；仅 `full` 权限模式。
- **理由**：Headless 一次性无流式；ACP rc.8 不能 resume；Web API 引入未认证本地端口。详见 [dsh-backend-design.md](./design/dsh-backend-design.md)。
