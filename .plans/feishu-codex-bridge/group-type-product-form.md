# 群类型 + 免@ — 产品形态 & 方案

> 分支 `group-type-selection`。讨论稿,未定稿前不进 docs/design。

## 一、两类群（用户视角）

类型2「话题群」已砍（飞书 API 建不了严格话题模式群）。只剩两类,**建群参数完全相同**（`im.v1.chat.create`,group+chat），区别全在应用层 session 模型。

### A. 多话题群 `multi`（= 现状,默认）
- **形态**:一个群里可以同时开多个话题,每个话题是一个独立 codex 会话(session)。
- **开话题**:在群主区 `@bot 干点啥` → bot 用 `reply_in_thread` 造一个话题并跑起来。
- **续话题**:进到某个话题里 `@bot 继续` → 在该话题的 session 里续跑。
- **适合**:多人 + 人机协作。人可以在群里/话题里互相沟通,也可以拉 bot 进来干活。
- **session key** = `threadId`(飞书话题 id)。

### B. 单会话群 `single`（新增）
- **形态**:整个群就是**一个** codex 会话。不开话题,所有对话在群主时间线里平铺。
- **跑**:群里 `@bot 干点啥` → 在群里**引用回复**(reply API,replyTo=触发消息)并跑,**不造话题**。后续消息都喂给同一个 session。
- **/resume 不支持**(没有话题列表);`/model` 仍可调本群会话的模型。
- **适合**:自己单独和 bot 干活,或几个人共享同一段上下文。
- **session key** = `chatId`(群 id)。整群串行(一个 run 在跑时,新消息走引导/排队,不并行)。

## 二、免@（noMention）

- **是什么**:开启后,群里不用 `@bot` 也能让 bot 接话。
- **硬依赖(必须开通)**:应用级高敏感权限 `im:message.group_msg`(接收群内全部消息)列为**必需 scope**,onboarding 一定要开通(新部署需企业管理员审批,已确认接受)。没开通 → 飞书不推非@消息 → 自动退化为"要@"(不报错);settings 卡的红字提示仅作防御兜底,不做运行时探测拦截。
- **存储**:`project.noMention`,逐群独立,**默认 `true`(不要@)**。缺省/旧数据也按免@处理(`noMention ?? true`)。
- **可随时改**:行为性开关,改它零成本,不在建群时定死。
- **作用域按群类型不同**:

| | 群主区(没在话题里) | 话题内 / 群会话 |
|---|---|---|
| **多话题群** | 始终要@(开新话题必须@,否则群里随便聊都触发太吵) | 免@ 开启后,话题内所有消息都喂给 bot |
| **单会话群** | —(没有话题概念) | 免@ 开启后,整群所有消息都喂给 bot |

> ⚠️ 多话题群开了免@的副作用:那个话题就变成"bot 专属"了——两个人想在话题里单纯对话也会触发 bot。这是"人机协作"的预期形态,确认可接受。

## 三、建群时选类型（新建项目卡片）

私聊管理台 `➕ 新建项目` 卡片:填项目名/路径后,底部由**单个**`✅ 创建` 改成**两个提交按钮**:
- `👥 创建·多话题群`
- `💬 创建·单会话群`

一步提交,既不锁卡(飞书 select_static 点过即锁的坑)也不丢已填输入(按钮 value 带 `kind`,表单值随提交一起上来)。`/new` 命令不变,默认建 multi。

项目列表 / 创建完成卡里显示群类型标签(`👥 多话题群` / `💬 单会话群`)。

## 四、群内改免@（@bot /settings）

- **入口**:在项目群里 `@bot /settings` → 弹一张设置卡片。
- **卡片内容**:
  - 群类型(只读标签,建群时定、不可改)
  - 免@ 开关(按钮 on/off,当前值高亮——复用现有 optionRow,按钮永不锁卡)
  - 文案按群类型自动区分作用域说明
  - 若检测到没开通 `group_msg` scope → 顶部红字提示"需先在开放平台开通『接收群内所有消息』权限"
- **权限**:仅项目 owner 或全局 admin 可改(复用 `ownerOpenId === op || isAdmin`);普通成员点了无效。
- 触发这条命令本身要@(没免@前 bot 只收@消息),没问题。

## 五、数据模型

```ts
interface Project {
  // ...现有字段...
  kind?: 'multi' | 'single';  // 缺省/旧数据 = multi(向后兼容,无需迁移)
  noMention?: boolean;        // 缺省 = true(不要@);读取用 noMention ?? true
}
```

## 六、改动文件（5 个,纯增量、向后兼容）

| 文件 | 改动 |
|---|---|
| `config/scopes.ts` | 加 `im:message.group_msg`(必需 scope) |
| `project/registry.ts` | `Project` 加 `kind` / `noMention` |
| `project/lifecycle.ts` | `CreateProjectInput` 加 `kind`,写入 registry(建群参数两类相同,chat.create 不变) |
| `card/dm-cards.ts` | 新建卡片改双提交按钮;群内 `/settings` 设置卡(免@开关+类型标签);列表/完成卡加类型标签 |
| `bot/handle-message.ts` | ① `onMessage` @门改为按 kind+noMention 判断;② single 群路由(chatId=session,主区直接跑、不造话题、串行);③ `/settings` 命令弹卡 + 免@开关回调 handler |

> `lifecycle.ts` 的建群 API 调用本身不变——两类群飞书参数相同。`/new`(dm-console.ts)不动,默认 multi。

## 七、@门改造（关键逻辑）

现 `handle-message.ts:190` 是一刀切 `if (!msg.mentionedBot) return;`。改成:

```
if (!msg.mentionedBot) {
  const project = await getProjectByChatId(msg.chatId);
  if (!project) return;                       // 非项目群,忽略非@
  if (!shouldRespondWithoutMention(project, msg)) return;
}
// shouldRespondWithoutMention (noMention 缺省视为 true):
//   single: (project.noMention ?? true)
//   multi:  (project.noMention ?? true) && msg.threadId 存在(话题内)
```

非@消息能不能到达这一步,还取决于 SDK 是否订阅到非@事件(依赖 group_msg scope 已开通)。

## 八、已定决策（全部锁定）

1. **单会话群回复位置**:整群平铺,**引用回复**(replyTo=触发消息),不造话题,session=chatId,整群串行。
2. **单会话群 /resume**:不支持;`/model` 仍可调。
3. **群类型不可事后切换**(结构性);免@ 可随时切。
4. **`group_msg` scope 必须开通**(列为必需 scope);没开通则自动退化为要@,settings 红字提示作兜底,不做运行时拦截。
5. **免@ 默认开**(`noMention ?? true`);多话题群开新话题始终要@,免@只在话题内生效;单会话群整群免@。
