-- bot 对用户本人的称呼(bot_tag),per-(chat,user)。优先于学来的群里外号(sender_tag)。
-- 私聊"叫我X / 别叫我Y"指令(call_me)写入;DM 行(chat_id=uid)作跨群默认,
-- 群行(chat_id=群id)可覆盖。读取时:当前 chat 的 bot_tag → 回退 DM 默认行。
ALTER TABLE user_profiles ADD COLUMN bot_tag TEXT;
