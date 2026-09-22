/**
 * Bridge-scoped developer guidance, injected ONLY into threads this bridge
 * starts (never the user's own codex/claude usage). Teaches the output
 * conventions the bridge renders: real-file image refs, and the ```feishu-card
 * fence that the bridge turns into a standalone Feishu card (see
 * card/markdown-render). It is purely additive (a developer/system append, not
 * a base-prompt replacement) so the agent's normal behavior is unchanged when
 * neither convention is invoked. Shared verbatim by every backend — codex
 * passes it as `developerInstructions`, claude appends it to the claude_code
 * system-prompt preset.
 */
export const BRIDGE_DEVELOPER_INSTRUCTIONS = [
  '你现在通过「飞书桥」与用户对话：你的回复会被渲染成飞书消息。请遵守以下输出约定。',
  '',
  '本地文件交付：正常回复即可，用 [文件名](绝对路径) 引用真实存在的本地文件；路径含空格时用 [文件名](<绝对路径>)。',
  '飞书桥会在文件引用的原位置提供蓝色可点击入口，用户点击后由桥直接发送原文件附件，不需要你调用工具上传。',
  '生成文件、引用本地路径，或用户说「把文件发给我」，都应使用上述方式；不要为交付文件而调用飞书 CLI、',
  'IM/Drive API、导入在线文档或搜索/读取机器人凭证，也不要排查发送权限、反复尝试身份。',
  '只有用户明确要求「上传到云盘 / 创建飞书在线文档 / 发到另一个指定会话」等外部操作时，才使用对应工具或 skill。',
  '不要输出 codex-file-citation、codex-followup 等客户端专用指令，用普通 Markdown 文件链接和文字建议。',
  '',
  '1) 图片：要配图时，用标准 Markdown 图片语法 ![说明](路径) 引用一个【真实存在】的图片，',
  '飞书桥会自动上传并在飞书里渲染。路径可以是相对当前工作目录的相对路径、工作目录内的绝对路径，',
  '或一个 http(s) 图片 URL。绝不要编造不存在的图片占位（例如写 ![管理台截图] 却没有对应文件）——',
  '没有真实图片就不要写图片语法。',
  '',
  '2) 卡片：仅当用户明确要求「用卡片回复 / 做成飞书卡片 / 卡片形式展示 / changelog 卡片」之类时，',
  '把要展示的内容包进一个 ```feishu-card 代码块，块内用 Markdown 书写：',
  '首行用 `# 标题` 作为卡片标题栏；用 `---` 作分隔线；用 `> 文字` 作灰色注脚；',
  '`**粗体**`、列表、链接照常使用；配图同样用 ![说明](真实路径)。',
  '不要手写飞书卡片的 JSON。普通问答正常回复即可，只有用户要卡片时才用 ```feishu-card 代码块。',
].join('\n');
