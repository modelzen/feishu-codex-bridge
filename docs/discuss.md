# Discuss 群聊参与模式

项目设置中的 Discuss 默认关闭，只允许 Codex 单会话群。在 Web 项目设置、私聊项目设置和群内 `/settings` 均可开关。开启期间接管普通消息的免 @ 路由及上下文策略；关闭后恢复原来的 noMention 和 contextBriefing 设置值。现有多话题群不受影响。

## 消息与上下文

- 鉴权后，按 bot、群和既有 admin/guest 会话分区记录入站消息。原始身份、时间、引用和附件元数据保存在 `sessions.json.discuss.json.messages.jsonl`；队列、摘要、版本及回执在 `sessions.json.discuss.json`。文件权限为 0600。
- 普通消息采用 1 秒防抖、最长 3 秒一批。批次编号持久化；判断与 Luna 分别串行处理各批，互不等待，各最多 2 个并发任务，不占主 Agent 并发槽。
- @ 立即废弃在途判断，并接管当前分区尚未判断/排队的消息，将原文、投递 ID 和附件放入本次消息简史后直接交给主 Agent，不等待 Luna。准备简史前先添加处理表情，启动主轮次时复用，完成后移除；单独 @ 也带明确的处理指令。已有命令直接走原路由。普通消息逐条判断 IGNORE、FOLLOW_UP 或 STEER。FOLLOW_UP 等主会话空闲；STEER 只投向判断时的同一个活动 turn。正式 goal 的既有外部输入规则保留。
- 主 Agent 与判断器使用相同模型和 reasoning effort。判断 fork 不续做继承任务，不具有原生执行、修改、网络、MCP、插件或委派能力。必要查询通过结构化 lookup 交给宿主：本项目内普通文件、本群历史；最多 3 次、返回总量最多 64 KiB，拒绝路径和符号链接逃逸。
- 主轮次结束后废弃判断 fork，下批从最新主线程重新建立。主线程运行期间从当前 turn 之前分叉，并附当前 turn ID。压缩、清空、恢复、权限变更或模型变更会使旧判断失效。判断上下文累积 64 批或 64,000 字符后也重建；字符阈值是保守的长度预算，并非精确 token 数。
- 消息简史默认 `gpt-5.6-luna` / `low`，项目设置可独立开关、选择模型及 Fast；关闭时不调用消息总结模型，主 Agent 使用原文。开启时使用独立持续对话逐批维护完整摘要，包括主题、未结请求、约束、决定、结果与不确定性，每项带消息 ID。主 Agent 的结束文本也进入摘要队列。首次最多取近 24 小时中最近 100 条历史，历史缺口随摘要保留。
- 主 Agent 只取已完成的摘要版本和其后未注入的原文，不等待 Luna、不临时再调用 Luna。摘要和原文游标在模型确认接受后推进。Discuss 下跳过旧的一次性简报路径；其他项目保留旧行为。

## 生命周期与恢复

判断和摘要单次任务最多 60 秒，失败最多重试两次，随后冷却 60 秒。摘要故障时主线程继续使用原文。Luna 正常运行期间复用对话，依赖 Codex 自动压缩；Luna 会话 ID 和隔离 Codex home 持久化在每个分区自己的辅助目录；进程重建优先 resume 原会话，无法恢复时才用持久摘要和未覆盖批次重建，不替换模型。

投递前先写 unknown，收到 turn_started 或 steer 成功后才写 accepted。重启时 unknown 只通过主历史的投递标记核对，不盲目重发；无法确认的输入继续保留 unknown。停止或关闭会取消未提交工作，新输入可重新进入；取消不删除原始日志。权限分区改变后，旧分区的工作不会投向新分区。

隔离 fork 同时支持 legacy 与 paginated 历史：把源 rollout 原样复制到临时 Codex home 的 sessions 目录，让原生索引识别源会话，并指定 excludeTurns，避免要求 ephemeral paginated fork 返回完整历史。复制不修改主会话或共享数据库，临时目录随判断器关闭清理。全新线程在首轮前尚无 rollout，此时判断器先用空背景独立线程；首次主回复后改为真正 fork。临时 fork 不设置不兼容的 deferGoalContinuation。

## 验证与观测

`npm run typecheck`、`npm test`、`npm run build`。`DISCUSS_LIVE=1 npx vitest run test/discuss-live.test.ts` 使用真实 Codex 验证继承上下文与辅助会话续轮，不发送飞书消息，结束时归档测试主线程并关闭辅助进程。

日志记录判断数量、耗时、摘要积压、查询字节和 Codex 报告的输入/缓存输入/输出 token，不记录消息正文。fork 复用的是会话历史；是否命中服务端缓存以 cachedInputTokens 为准，不保证共享 KV 或固定成本下降。

生产默认关闭。本次代码验证不自动重启 daemon，也不自动为群启用 Discuss。

## 项目消息简史设置

群内 `/settings`、私聊「项目设置」及 Web 项目设置均提供「消息简史」开关和模型 / Fast 配置。使用 `contextBriefing`、`contextBriefingModel`、`contextBriefingFast` 持久化，独立于 `discuss` 和主 Agent 模型。默认模型为 `gpt-5.6-luna`，Fast 默认关闭。

修改模型或 Fast 后，简史工作会话按新配置恢复，保留已有摘要；旧配置下未完成的摘要不再提交。关闭后停止摘要生成和摘要注入，继续提供原文。Fast 显式传入 Codex `serviceTier: "fast"`，关闭传 `null` 清除旧会话档位；服务实际支持情况由模型和账号决定，参见 [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 输入准备与上下文预算

非 @ 语音先按会话顺序转写，再交给判断器；降级卡片先补全正文。清理、权限变更、显式 @ 接管会取消尚未完成的准备，迟到结果不会进入判断。

主线程背景原文最多 64 KiB，单条正文最多 16 KiB，摘要最多 32 KiB；超限摘要整份不注入，回退到预算内原文，不推进摘要版本或借用其覆盖范围跳过历史。优先本次消息与最近记录，并标注省略/截断；原文游标只跨过实际完整注入的连续记录，不把跳过的历史冒充已消费。完整资料仍留在历史日志中，按需查询。预算不替代日志归档策略。

自动回复、steer 与 @ 接管的最终文本（含检索内容）统一限制为 256 KiB。超限时整批拒绝提交并保留待处理状态，不截断后接受；@ 路径提示用户分批，自动路径只记录日志。此限制保护单次模型输入，不会自动拆分积压批次。

### 已终结历史归档与 checkpoint

每个 lane 的已终结条目（accepted / ignored / cancelled）热状态最多保留 256 条且总序列化大小不超过 2 MiB；超过任一限制即从最旧条目开始归档。pending / followup / unknown 不参与淘汰，也不会仅因年代久远自动重投。消息内容、原始字段与最终状态完整保存在 `<state文件>.archive/<sha256>.json`，其中哈希输入为 `JSON.stringify([laneKey, messageId])`。归档可由 `Discuss.readArchived(laneKey, messageId)` 查询；判断器的 `around` 查询会优先返回同 lane 的归档原文（仅该条，不承诺相邻历史）。search / before 仍查询原有群历史源，不会全文扫描本地归档。运维也可直接读取归档 JSON；归档目录只供当前机器人本地使用。

归档先 fsync 文件与目录，再提交 checkpoint。checkpoint 原子更新 state，使其指向新的 UUID journal；旧 `.messages.jsonl` / `.messages.<UUID>.jsonl` 原样保留，可供人工审计，但重启不会回放旧代。新 journal 不存在表示该代尚无新 ingress。迁移兼容无 journal 字段的旧 state。每累计 256 条 ingress（含重启时当代回放计数），或终结热历史超出上限时触发 checkpoint，不会每条消息轮转。归档失败不会移除热条目或切换 journal；后续 tick 重试。如果归档已落盘而 checkpoint 未完成，重启会使用归档的终结状态纠正旧快照，避免 accepted 复活为 pending。磁盘归档同时作为历史 messageId 的去重索引，无需把所有 ID 常驻内存。

这不是全系统内存／磁盘硬上限：未决工作必须保留，pending / followup / unknown 大量积压仍会增加热状态、快照大小与重启成本；lane 数量、已知 host 游标及磁盘历史也未在此实现中自动清除。判断器继续按现有每批最多 100 条与模型并发限制消费，**未实现入口拒收或自动丢弃式背压**。持续积压需运维恢复模型／投递服务，或明确停止产生新输入；不得删除 unknown 来减压。历史归档与旧 journals 无自动过期删除，磁盘容量需独立监测。摘要停用或滞后时，归档内容不保证已经进入摘要；注入明确提示早期终结历史已归档，不能声称完整覆盖。
