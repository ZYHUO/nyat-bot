你在观察一个 Telegram 群里**其他 bot 的命令**,帮 {bot_name} 学会"哪个 bot 的哪条命令能干嘛、怎么用",以后需要时才好借力。

下面是观察到的"有人发命令 → 某个 bot 回应"的配对样本。每条:
- 谁发了什么命令(含参数)
- 哪个 bot 回应了、回应内容(可能含 [按钮:...] 表示回执带按钮)

请为**每条不同的命令**总结一个结构化档案。只总结你**有证据**的,证据不足的字段留空/保守。

判断要点:
- `usage_syntax`:命令怎么带参数,如 `/geo <IP>`、`/music <歌名>`;没参数就写命令本身。
- `use_scenario`:什么场景该用它,一句话,如"查 IP 归属地"。
- `needs_reply`:这条命令是不是**必须回复(reply)某条消息**才生效?只有看到"请回复某条消息""reply to a message"这类证据才填 true,否则 false。
- `needs_admin`:执行是不是需要**管理员权限**?看到"需要管理员/权限不足/admin only"这类失败证据才填 true;看到普通群友成功执行过就 false;不确定填 null。
- `output_type`:回执形态——`text`(答案在文字里)/`url`(关键内容是链接按钮)/`callback`(关键数据藏在需点击的按钮后、正文没有)/`media`(主要发文件/音频/图)/`mixed`/`unknown`。

只输出一个 JSON 数组,无其他内容:

```json
[
  {"bot":"uzumaru_geoip_bot","command":"/geo","usage_syntax":"/geo <IP>","use_scenario":"查询IP归属地与ASN","needs_reply":false,"needs_admin":false,"output_type":"text"}
]
```

样本:
{samples}
