// ────────────────────────────────────────
// Sticker system types
// ────────────────────────────────────────

export type AnalysisStatus = 'pending' | 'ready' | 'failed' | 'waiting_for_preview';
export type AssetStatus = 'missing' | 'raw_ready' | 'preview_required' | 'preview_ready';
export type StickerFormat = 'static_webp' | 'animated_tgs' | 'video_webm' | 'unknown';

export interface StickerItem {
  fileUniqueId: string;
  latestFileId: string | null;
  setName: string | null;
  emoji: string | null;
  stickerFormat: StickerFormat;
  usageCount: number;
  sampleCount: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  analysisStatus: AnalysisStatus;
  analysisReason: string | null;
  analysisUpdatedAt: number | null;
  assetStatus: AssetStatus;
  rawAssetPath: string | null;
  previewAssetPath: string | null;
  emotionTags: string[] | null;
  moodMap: Record<string, number> | null;
  personaFit: boolean | null;
  description: string | null;
}

export interface StickerSample {
  id?: number;
  fileUniqueId: string;
  chatId: number;
  messageId: number;
  date: number;
  fromUserId: number | null;
  username: string | null;
  replyToMessageId: number | null;
  replyTargetText: string | null;
  contextBefore: string | null;
}

export interface StickerMeta {
  fileUniqueId: string;
  fileId: string | null;
  setName: string | null;
  emoji: string | null;
  stickerFormat: StickerFormat;
}

export type StickerIntent =
  // ── 基础情绪 (Basic Emotions) ──
  | 'cute' | 'happy' | 'sad' | 'angry' | 'surprised' | 'scared' | 'disgusted'
  | 'excited' | 'nervous' | 'shy' | 'proud' | 'embarrassed' | 'confused'
  | 'bored' | 'relieved' | 'grateful' | 'jealous' | 'guilty' | 'hopeful'
  | 'lonely' | 'nostalgic' | 'content' | 'anxious' | 'frustrated' | 'peaceful'
  | 'melancholy' | 'euphoric' | 'tender' | 'bitter' | 'hollow'
  // ── 开心细分 (Happy Variants) ──
  | 'laughing' | 'giggling' | 'grinning' | 'beaming' | 'cheerful' | 'joyful'
  | 'elated' | 'gleeful' | 'tickled' | 'radiant'
  // ── 难过细分 (Sad Variants) ──
  | 'crying' | 'sobbing' | 'weeping' | 'heartbroken' | 'gloomy' | 'moping'
  | 'dejected' | 'despairing' | 'wistful' | 'crying_happy'
  // ── 生气细分 (Angry Variants) ──
  | 'rage' | 'irritated' | 'fuming' | 'grumpy' | 'seething' | 'snappy'
  | 'resentful' | 'livid' | 'huffy' | 'cranky'
  // ── 惊讶细分 (Surprise Variants) ──
  | 'shocked' | 'astonished' | 'stunned' | 'flabbergasted' | 'mindblown'
  | 'startled' | 'speechless' | 'awestruck' | 'dumbfounded' | 'gasp'
  // ── 害怕细分 (Fear Variants) ──
  | 'terrified' | 'spooked' | 'trembling' | 'panicked' | 'creeped_out'
  | 'dread' | 'paranoid' | 'jumpy' | 'frozen_fear' | 'uneasy'
  // ── 社交场景 (Social) ──
  | 'greeting' | 'farewell' | 'thanking' | 'apologizing' | 'complimenting'
  | 'encouraging' | 'congratulating' | 'welcoming' | 'introducing' | 'inviting'
  | 'comforting' | 'sympathizing' | 'cheering_up' | 'roasting' | 'flirting'
  | 'rejecting' | 'forgiving' | 'begging' | 'persuading' | 'gossiping'
  // ── 回应/反应 (Reactions) ──
  | 'agreeing' | 'disagreeing' | 'facepalm' | 'eyeroll' | 'shrugging'
  | 'nodding' | 'headshake' | 'clapping' | 'thumbs_up' | 'thumbs_down'
  | 'mind_blown' | 'cringe' | 'yikes' | 'oof' | 'bruh'
  | 'sus' | 'cap' | 'based' | 'ratio' | 'cope'
  // ── 吐槽/态度 (Attitude) ──
  | 'sarcastic' | 'smug' | 'annoyed' | 'unimpressed' | 'dismissive'
  | 'deadpan' | 'savage' | 'sassy' | 'petty' | 'passive_aggressive'
  | 'condescending' | 'mocking' | 'judging' | 'side_eye' | 'whatever'
  // ── 思考/认知 (Thinking) ──
  | 'thinking' | 'pondering' | 'wondering' | 'realizing' | 'eureka'
  | 'calculating' | 'skeptical' | 'suspicious' | 'analyzing' | 'daydreaming'
  | 'spacing_out' | 'brainstorming' | 'remembering' | 'forgetting' | 'mind_wandering'
  // ── 状态场景 (States) ──
  | 'sleepy' | 'eating' | 'drinking' | 'working' | 'studying'
  | 'exercising' | 'gaming' | 'cooking' | 'cleaning' | 'shopping'
  | 'traveling' | 'resting' | 'bathing' | 'dressing_up' | 'sick'
  | 'hungover' | 'caffeinated' | 'sugar_rush' | 'food_coma' | 'procrastinating'
  // ── 工作/学习 (Work/Study) ──
  | 'focused' | 'productive' | 'overwhelmed' | 'burned_out' | 'slacking'
  | 'deadline_panic' | 'meeting_mode' | 'braindead' | 'debugging' | 'eureka_work'
  | 'presenting' | 'multitasking' | 'on_break' | 'clocking_out' | 'monday_mood'
  // ── 摸鱼 (Slacking) ──
  | 'sneaky_slack' | 'alt_tab' | 'pretend_busy' | 'secret_browse' | 'stealth_mode'
  // ── 群聊场景 (Group Chat) ──
  | 'lurking' | 'popcorn' | 'instigating' | 'topic_change' | 'reviving_chat'
  | 'spamming' | 'shitposting' | 'flexing' | 'humble_brag' | 'venting'
  | 'ranting' | 'storytime' | 'hot_take' | 'unpopular_opinion' | 'thread_killer'
  | 'necro_post' | 'first' | 'tldr' | 'sauce' | 'repost'
  // ── 吃瓜/围观 (Spectating) ──
  | 'watching_drama' | 'eating_melon' | 'tea_sipping' | 'nosy' | 'rubbernecking'
  | 'plot_twist' | 'called_it' | 'told_you_so' | 'taking_notes' | 'screenshot'
  // ── 猫娘特色 (Cat Girl Specials) ──
  | 'nuzzling' | 'purring' | 'kneading' | 'tail_wagging' | 'ear_twitch'
  | 'curled_up' | 'stretching' | 'grooming' | 'pouncing' | 'hissing'
  | 'meowing' | 'chirping' | 'head_tilt' | 'belly_up' | 'zoomies'
  | 'knocking_things' | 'box_sitting' | 'sunbathing' | 'bird_watching' | 'catnip'
  // ── 撒娇/卖萌 (Acting Cute) ──
  | 'acting_cute' | 'puppy_eyes' | 'pouting' | 'whining' | 'clingy'
  | 'needy' | 'pampered' | 'spoiled' | 'baby_talk' | 'uwu'
  // ── 爱情/亲密 (Love/Intimacy) ──
  | 'love' | 'crushing' | 'blushing' | 'heart_eyes' | 'swooning'
  | 'cuddling' | 'hugging' | 'kissing' | 'holding_hands' | 'missing_you'
  | 'love_letter' | 'couple_goals' | 'friendzone' | 'heartbreak_recovery' | 'butterflies'
  // ── 温暖/治愈 (Warm/Healing) ──
  | 'comfort' | 'cozy' | 'warm_fuzzy' | 'healing' | 'soothing'
  | 'gentle_pat' | 'blanket_wrap' | 'hot_cocoa' | 'rainy_day' | 'sunset_mood'
  // ── 调皮/恶作剧 (Playful/Mischief) ──
  | 'playful' | 'tease' | 'mischievous' | 'pranking' | 'trolling'
  | 'baiting' | 'rickroll' | 'gotcha' | 'plot_armor' | 'chaos_mode'
  // ── 夸张/戏精 (Dramatic) ──
  | 'dramatic' | 'fainting' | 'dying_inside' | 'soul_leaving' | 'ascended'
  | 'imploding' | 'melting' | 'evaporating' | 'dramatic_exit' | 'curtain_call'
  // ── 庆祝/成就 (Celebration) ──
  | 'celebrating' | 'partying' | 'dancing' | 'fireworks' | 'champagne'
  | 'victory_lap' | 'level_up' | 'achievement' | 'milestone' | 'new_year'
  // ── 失败/翻车 (Failure) ──
  | 'failing' | 'tripping' | 'face_plant' | 'self_destruct' | 'task_failed'
  | 'error_404' | 'blue_screen' | 'rip' | 'game_over' | 'wasted'
  // ── 天气/环境 (Weather/Vibe) ──
  | 'sunny_mood' | 'rainy_mood' | 'snowy_mood' | 'stormy_mood' | 'windy'
  | 'hot_weather' | 'cold_weather' | 'autumn_vibes' | 'spring_vibes' | 'night_owl'
  // ── 时间相关 (Time) ──
  | 'good_morning' | 'good_night' | 'midnight_snack' | 'weekend_mood' | 'friday_feeling'
  | 'monday_blues' | 'lunch_time' | 'nap_time' | 'overtime' | 'vacation_mode'
  // ── 网络/梗 (Internet/Memes) ──
  | 'stonks' | 'not_stonks' | 'this_is_fine' | 'confused_math' | 'galaxy_brain'
  | 'npc_mode' | 'main_character' | 'glitch' | 'buffering' | 'loading'
  // ── 空白/无 (Blank/Null) ──
  | 'blank' | 'void' | 'dissociating' | 'numb' | 'empty'
  // ── 决心/力量 (Determination) ──
  | 'determined' | 'motivated' | 'pumped' | 'battle_ready' | 'lets_go'
  // ── 其他 (Misc) ──
  | 'pensive' | 'disappointed' | 'awkward' | 'wholesome' | 'chaotic';

export const ALLOWED_INTENTS: readonly StickerIntent[] = [
  // ── 基础情绪 ──
  'cute', 'happy', 'sad', 'angry', 'surprised', 'scared', 'disgusted',
  'excited', 'nervous', 'shy', 'proud', 'embarrassed', 'confused',
  'bored', 'relieved', 'grateful', 'jealous', 'guilty', 'hopeful',
  'lonely', 'nostalgic', 'content', 'anxious', 'frustrated', 'peaceful',
  'melancholy', 'euphoric', 'tender', 'bitter', 'hollow',
  // ── 开心细分 ──
  'laughing', 'giggling', 'grinning', 'beaming', 'cheerful', 'joyful',
  'elated', 'gleeful', 'tickled', 'radiant',
  // ── 难过细分 ──
  'crying', 'sobbing', 'weeping', 'heartbroken', 'gloomy', 'moping',
  'dejected', 'despairing', 'wistful', 'crying_happy',
  // ── 生气细分 ──
  'rage', 'irritated', 'fuming', 'grumpy', 'seething', 'snappy',
  'resentful', 'livid', 'huffy', 'cranky',
  // ── 惊讶细分 ──
  'shocked', 'astonished', 'stunned', 'flabbergasted', 'mindblown',
  'startled', 'speechless', 'awestruck', 'dumbfounded', 'gasp',
  // ── 害怕细分 ──
  'terrified', 'spooked', 'trembling', 'panicked', 'creeped_out',
  'dread', 'paranoid', 'jumpy', 'frozen_fear', 'uneasy',
  // ── 社交场景 ──
  'greeting', 'farewell', 'thanking', 'apologizing', 'complimenting',
  'encouraging', 'congratulating', 'welcoming', 'introducing', 'inviting',
  'comforting', 'sympathizing', 'cheering_up', 'roasting', 'flirting',
  'rejecting', 'forgiving', 'begging', 'persuading', 'gossiping',
  // ── 回应/反应 ──
  'agreeing', 'disagreeing', 'facepalm', 'eyeroll', 'shrugging',
  'nodding', 'headshake', 'clapping', 'thumbs_up', 'thumbs_down',
  'mind_blown', 'cringe', 'yikes', 'oof', 'bruh',
  'sus', 'cap', 'based', 'ratio', 'cope',
  // ── 吐槽/态度 ──
  'sarcastic', 'smug', 'annoyed', 'unimpressed', 'dismissive',
  'deadpan', 'savage', 'sassy', 'petty', 'passive_aggressive',
  'condescending', 'mocking', 'judging', 'side_eye', 'whatever',
  // ── 思考/认知 ──
  'thinking', 'pondering', 'wondering', 'realizing', 'eureka',
  'calculating', 'skeptical', 'suspicious', 'analyzing', 'daydreaming',
  'spacing_out', 'brainstorming', 'remembering', 'forgetting', 'mind_wandering',
  // ── 状态场景 ──
  'sleepy', 'eating', 'drinking', 'working', 'studying',
  'exercising', 'gaming', 'cooking', 'cleaning', 'shopping',
  'traveling', 'resting', 'bathing', 'dressing_up', 'sick',
  'hungover', 'caffeinated', 'sugar_rush', 'food_coma', 'procrastinating',
  // ── 工作/学习 ──
  'focused', 'productive', 'overwhelmed', 'burned_out', 'slacking',
  'deadline_panic', 'meeting_mode', 'braindead', 'debugging', 'eureka_work',
  'presenting', 'multitasking', 'on_break', 'clocking_out', 'monday_mood',
  // ── 摸鱼 ──
  'sneaky_slack', 'alt_tab', 'pretend_busy', 'secret_browse', 'stealth_mode',
  // ── 群聊场景 ──
  'lurking', 'popcorn', 'instigating', 'topic_change', 'reviving_chat',
  'spamming', 'shitposting', 'flexing', 'humble_brag', 'venting',
  'ranting', 'storytime', 'hot_take', 'unpopular_opinion', 'thread_killer',
  'necro_post', 'first', 'tldr', 'sauce', 'repost',
  // ── 吃瓜/围观 ──
  'watching_drama', 'eating_melon', 'tea_sipping', 'nosy', 'rubbernecking',
  'plot_twist', 'called_it', 'told_you_so', 'taking_notes', 'screenshot',
  // ── 猫娘特色 ──
  'nuzzling', 'purring', 'kneading', 'tail_wagging', 'ear_twitch',
  'curled_up', 'stretching', 'grooming', 'pouncing', 'hissing',
  'meowing', 'chirping', 'head_tilt', 'belly_up', 'zoomies',
  'knocking_things', 'box_sitting', 'sunbathing', 'bird_watching', 'catnip',
  // ── 撒娇/卖萌 ──
  'acting_cute', 'puppy_eyes', 'pouting', 'whining', 'clingy',
  'needy', 'pampered', 'spoiled', 'baby_talk', 'uwu',
  // ── 爱情/亲密 ──
  'love', 'crushing', 'blushing', 'heart_eyes', 'swooning',
  'cuddling', 'hugging', 'kissing', 'holding_hands', 'missing_you',
  'love_letter', 'couple_goals', 'friendzone', 'heartbreak_recovery', 'butterflies',
  // ── 温暖/治愈 ──
  'comfort', 'cozy', 'warm_fuzzy', 'healing', 'soothing',
  'gentle_pat', 'blanket_wrap', 'hot_cocoa', 'rainy_day', 'sunset_mood',
  // ── 调皮/恶作剧 ──
  'playful', 'tease', 'mischievous', 'pranking', 'trolling',
  'baiting', 'rickroll', 'gotcha', 'plot_armor', 'chaos_mode',
  // ── 夸张/戏精 ──
  'dramatic', 'fainting', 'dying_inside', 'soul_leaving', 'ascended',
  'imploding', 'melting', 'evaporating', 'dramatic_exit', 'curtain_call',
  // ── 庆祝/成就 ──
  'celebrating', 'partying', 'dancing', 'fireworks', 'champagne',
  'victory_lap', 'level_up', 'achievement', 'milestone', 'new_year',
  // ── 失败/翻车 ──
  'failing', 'tripping', 'face_plant', 'self_destruct', 'task_failed',
  'error_404', 'blue_screen', 'rip', 'game_over', 'wasted',
  // ── 天气/环境 ──
  'sunny_mood', 'rainy_mood', 'snowy_mood', 'stormy_mood', 'windy',
  'hot_weather', 'cold_weather', 'autumn_vibes', 'spring_vibes', 'night_owl',
  // ── 时间相关 ──
  'good_morning', 'good_night', 'midnight_snack', 'weekend_mood', 'friday_feeling',
  'monday_blues', 'lunch_time', 'nap_time', 'overtime', 'vacation_mode',
  // ── 网络/梗 ──
  'stonks', 'not_stonks', 'this_is_fine', 'confused_math', 'galaxy_brain',
  'npc_mode', 'main_character', 'glitch', 'buffering', 'loading',
  // ── 空白/无 ──
  'blank', 'void', 'dissociating', 'numb', 'empty',
  // ── 决心/力量 ──
  'determined', 'motivated', 'pumped', 'battle_ready', 'lets_go',
  // ── 其他 ──
  'pensive', 'disappointed', 'awkward', 'wholesome', 'chaotic',
] as const;

export const INTENT_SYNONYMS: Record<StickerIntent, readonly string[]> = {
  // ── 基础情绪 ──
  cute:         ['cute', 'adorable', 'gentle', 'soft', 'sweet'],
  happy:        ['happy', 'cheerful', 'joy', 'playful', 'lighthearted'],
  sad:          ['sad', 'pouty', 'gentle', 'soft', 'comforting'],
  angry:        ['annoyed', 'unimpressed', 'deadpan', 'playful', 'teasing'],
  surprised:    ['surprised', 'curious', 'playful', 'confused', 'flustered'],
  scared:       ['shy', 'nervous', 'confused', 'flustered', 'awkward'],
  disgusted:    ['unimpressed', 'annoyed', 'deadpan', 'smug', 'sarcastic'],
  excited:      ['playful', 'cheerful', 'joy', 'happy', 'curious'],
  nervous:      ['shy', 'flustered', 'awkward', 'confused', 'gentle'],
  shy:          ['shy', 'flustered', 'cute', 'gentle', 'soft', 'awkward'],
  proud:        ['smug', 'playful', 'cheerful', 'happy', 'confident'],
  embarrassed:  ['flustered', 'shy', 'awkward', 'blushing', 'cute'],
  confused:     ['confused', 'curious', 'deadpan', 'puzzled', 'playful'],
  bored:        ['sleepy', 'tired', 'deadpan', 'unimpressed', 'calm'],
  relieved:     ['calm', 'peaceful', 'gentle', 'soft', 'comforting'],
  grateful:     ['affectionate', 'gentle', 'warmth', 'soft', 'comforting'],
  jealous:      ['pouty', 'annoyed', 'playful', 'teasing', 'mischievous'],
  guilty:       ['shy', 'gentle', 'soft', 'sad', 'awkward'],
  hopeful:      ['hopeful', 'gentle', 'soft', 'warmth', 'cheerful'],
  lonely:       ['sad', 'gentle', 'soft', 'sleepy', 'calm'],
  nostalgic:    ['gentle', 'soft', 'warmth', 'calm', 'peaceful'],
  content:      ['calm', 'peaceful', 'gentle', 'cozy', 'soft'],
  anxious:      ['nervous', 'flustered', 'shy', 'confused', 'awkward'],
  frustrated:   ['annoyed', 'pouty', 'unimpressed', 'deadpan', 'playful'],
  peaceful:     ['peaceful', 'calm', 'gentle', 'soft', 'cozy'],
  melancholy:   ['sad', 'gentle', 'soft', 'calm', 'peaceful'],
  euphoric:     ['joy', 'happy', 'playful', 'cheerful', 'excited'],
  tender:       ['gentle', 'soft', 'affectionate', 'warmth', 'comforting'],
  bitter:       ['annoyed', 'unimpressed', 'deadpan', 'sad', 'pouty'],
  hollow:       ['deadpan', 'calm', 'sleepy', 'tired', 'blank'],
  // ── 开心细分 ──
  laughing:     ['playful', 'amused', 'cheerful', 'joy', 'lighthearted'],
  giggling:     ['playful', 'cute', 'amused', 'cheerful', 'shy'],
  grinning:     ['playful', 'smug', 'cheerful', 'happy', 'mischievous'],
  beaming:      ['cheerful', 'happy', 'joy', 'playful', 'warmth'],
  cheerful:     ['cheerful', 'playful', 'happy', 'lighthearted', 'joy'],
  joyful:       ['joy', 'cheerful', 'happy', 'playful', 'lighthearted'],
  elated:       ['joy', 'happy', 'cheerful', 'playful', 'excited'],
  gleeful:      ['playful', 'mischievous', 'cheerful', 'joy', 'amused'],
  tickled:      ['playful', 'amused', 'cute', 'cheerful', 'lighthearted'],
  radiant:      ['cheerful', 'happy', 'warmth', 'gentle', 'joy'],
  // ── 难过细分 ──
  crying:       ['sad', 'pouty', 'comforting', 'gentle', 'soft'],
  sobbing:      ['sad', 'pouty', 'comforting', 'gentle', 'warmth'],
  weeping:      ['sad', 'gentle', 'soft', 'comforting', 'warmth'],
  heartbroken:  ['sad', 'pouty', 'gentle', 'comforting', 'soft'],
  gloomy:       ['sad', 'sleepy', 'tired', 'calm', 'gentle'],
  moping:       ['sad', 'pouty', 'sleepy', 'tired', 'gentle'],
  dejected:     ['sad', 'pouty', 'tired', 'gentle', 'soft'],
  despairing:   ['sad', 'pouty', 'comforting', 'gentle', 'warmth'],
  wistful:      ['gentle', 'soft', 'calm', 'peaceful', 'sad'],
  crying_happy:  ['joy', 'warmth', 'affectionate', 'gentle', 'comforting'],
  // ── 生气细分 ──
  rage:         ['annoyed', 'unimpressed', 'deadpan', 'playful', 'teasing'],
  irritated:    ['annoyed', 'unimpressed', 'deadpan', 'pouty', 'grumpy'],
  fuming:       ['annoyed', 'unimpressed', 'deadpan', 'pouty', 'playful'],
  grumpy:       ['annoyed', 'pouty', 'unimpressed', 'sleepy', 'tired'],
  seething:     ['annoyed', 'unimpressed', 'deadpan', 'pouty', 'teasing'],
  snappy:       ['annoyed', 'teasing', 'playful', 'mischievous', 'sassy'],
  resentful:    ['annoyed', 'unimpressed', 'sad', 'pouty', 'deadpan'],
  livid:        ['annoyed', 'unimpressed', 'deadpan', 'pouty', 'playful'],
  huffy:        ['pouty', 'annoyed', 'cute', 'playful', 'flustered'],
  cranky:       ['annoyed', 'pouty', 'sleepy', 'tired', 'grumpy'],
  // ── 惊讶细分 ──
  shocked:      ['surprised', 'confused', 'curious', 'flustered', 'playful'],
  astonished:   ['surprised', 'curious', 'confused', 'playful', 'flustered'],
  stunned:      ['surprised', 'confused', 'deadpan', 'curious', 'flustered'],
  flabbergasted: ['surprised', 'confused', 'curious', 'flustered', 'playful'],
  mindblown:    ['surprised', 'confused', 'curious', 'playful', 'amused'],
  startled:     ['surprised', 'confused', 'shy', 'flustered', 'nervous'],
  speechless:   ['surprised', 'deadpan', 'confused', 'flustered', 'blank'],
  awestruck:    ['surprised', 'curious', 'gentle', 'hopeful', 'warmth'],
  dumbfounded:  ['surprised', 'confused', 'deadpan', 'curious', 'blank'],
  gasp:         ['surprised', 'curious', 'flustered', 'playful', 'confused'],
  // ── 害怕细分 ──
  terrified:    ['shy', 'confused', 'flustered', 'nervous', 'surprised'],
  spooked:      ['surprised', 'confused', 'shy', 'flustered', 'curious'],
  trembling:    ['shy', 'flustered', 'nervous', 'gentle', 'soft'],
  panicked:     ['confused', 'flustered', 'surprised', 'nervous', 'playful'],
  creeped_out:  ['confused', 'unimpressed', 'annoyed', 'deadpan', 'shy'],
  dread:        ['sad', 'tired', 'sleepy', 'deadpan', 'calm'],
  paranoid:     ['confused', 'curious', 'shy', 'nervous', 'flustered'],
  jumpy:        ['surprised', 'flustered', 'shy', 'playful', 'nervous'],
  frozen_fear:  ['shy', 'deadpan', 'confused', 'blank', 'flustered'],
  uneasy:       ['shy', 'confused', 'flustered', 'awkward', 'nervous'],
  // ── 社交场景 ──
  greeting:       ['cheerful', 'playful', 'cute', 'happy', 'warm'],
  farewell:       ['gentle', 'soft', 'affectionate', 'warmth', 'sad'],
  thanking:       ['affectionate', 'gentle', 'warmth', 'grateful', 'soft'],
  apologizing:    ['shy', 'gentle', 'soft', 'sad', 'flustered'],
  complimenting:  ['affectionate', 'playful', 'cheerful', 'gentle', 'warmth'],
  encouraging:    ['cheerful', 'hopeful', 'warmth', 'comforting', 'playful'],
  congratulating: ['cheerful', 'playful', 'joy', 'happy', 'excited'],
  welcoming:      ['cheerful', 'playful', 'affectionate', 'warmth', 'gentle'],
  introducing:    ['shy', 'playful', 'cute', 'cheerful', 'gentle'],
  inviting:       ['playful', 'cheerful', 'curious', 'mischievous', 'cute'],
  comforting:     ['comforting', 'gentle', 'soft', 'warmth', 'affectionate'],
  sympathizing:   ['comforting', 'gentle', 'soft', 'sad', 'warmth'],
  cheering_up:    ['cheerful', 'playful', 'comforting', 'warmth', 'hopeful'],
  roasting:       ['teasing', 'mischievous', 'playful', 'smug', 'amused'],
  flirting:       ['playful', 'teasing', 'shy', 'affectionate', 'mischievous'],
  rejecting:      ['unimpressed', 'deadpan', 'annoyed', 'smug', 'playful'],
  forgiving:      ['gentle', 'soft', 'affectionate', 'comforting', 'warmth'],
  begging:        ['cute', 'pouty', 'shy', 'playful', 'gentle'],
  persuading:     ['playful', 'cute', 'teasing', 'mischievous', 'cheerful'],
  gossiping:      ['curious', 'playful', 'mischievous', 'amused', 'teasing'],
  // ── 回应/反应 ──
  agreeing:       ['cheerful', 'playful', 'happy', 'gentle', 'calm'],
  disagreeing:    ['annoyed', 'unimpressed', 'deadpan', 'pouty', 'playful'],
  facepalm:       ['deadpan', 'unimpressed', 'annoyed', 'amused', 'tired'],
  eyeroll:        ['unimpressed', 'annoyed', 'deadpan', 'smug', 'sarcastic'],
  shrugging:      ['deadpan', 'calm', 'unimpressed', 'playful', 'confused'],
  nodding:        ['gentle', 'calm', 'cheerful', 'soft', 'playful'],
  headshake:      ['unimpressed', 'deadpan', 'annoyed', 'disappointed', 'sad'],
  clapping:       ['cheerful', 'playful', 'joy', 'amused', 'happy'],
  thumbs_up:      ['cheerful', 'playful', 'happy', 'smug', 'calm'],
  thumbs_down:    ['unimpressed', 'annoyed', 'deadpan', 'disappointed', 'sad'],
  mind_blown:     ['surprised', 'confused', 'curious', 'playful', 'amused'],
  cringe:         ['awkward', 'flustered', 'shy', 'unimpressed', 'confused'],
  yikes:          ['surprised', 'awkward', 'confused', 'flustered', 'shy'],
  oof:            ['deadpan', 'tired', 'sad', 'awkward', 'comforting'],
  bruh:           ['deadpan', 'unimpressed', 'annoyed', 'confused', 'amused'],
  sus:            ['curious', 'mischievous', 'suspicious', 'playful', 'smug'],
  cap:            ['unimpressed', 'deadpan', 'smug', 'teasing', 'playful'],
  based:          ['smug', 'playful', 'cheerful', 'amused', 'mischievous'],
  ratio:          ['smug', 'teasing', 'mischievous', 'playful', 'amused'],
  cope:           ['deadpan', 'unimpressed', 'smug', 'teasing', 'amused'],
  // ── 吐槽/态度 ──
  sarcastic:      ['deadpan', 'unimpressed', 'smug', 'teasing', 'amused'],
  smug:           ['smug', 'playful', 'teasing', 'mischievous', 'amused'],
  annoyed:        ['annoyed', 'unimpressed', 'deadpan', 'pouty', 'grumpy'],
  unimpressed:    ['unimpressed', 'deadpan', 'annoyed', 'smug', 'bored'],
  dismissive:     ['unimpressed', 'deadpan', 'annoyed', 'smug', 'calm'],
  deadpan:        ['deadpan', 'unimpressed', 'calm', 'blank', 'tired'],
  savage:         ['teasing', 'mischievous', 'smug', 'playful', 'amused'],
  sassy:          ['teasing', 'playful', 'smug', 'mischievous', 'cute'],
  petty:          ['pouty', 'annoyed', 'teasing', 'playful', 'mischievous'],
  passive_aggressive: ['deadpan', 'unimpressed', 'smug', 'teasing', 'annoyed'],
  condescending:  ['smug', 'unimpressed', 'deadpan', 'teasing', 'amused'],
  mocking:        ['teasing', 'mischievous', 'playful', 'smug', 'amused'],
  judging:        ['unimpressed', 'deadpan', 'smug', 'curious', 'annoyed'],
  side_eye:       ['unimpressed', 'curious', 'smug', 'mischievous', 'deadpan'],
  whatever:       ['unimpressed', 'deadpan', 'calm', 'bored', 'tired'],
  // ── 思考/认知 ──
  thinking:       ['curious', 'calm', 'gentle', 'confused', 'playful'],
  pondering:      ['curious', 'calm', 'gentle', 'confused', 'peaceful'],
  wondering:      ['curious', 'confused', 'playful', 'gentle', 'hopeful'],
  realizing:      ['surprised', 'curious', 'confused', 'playful', 'amused'],
  eureka:         ['surprised', 'cheerful', 'playful', 'joy', 'curious'],
  calculating:    ['curious', 'smug', 'mischievous', 'calm', 'deadpan'],
  skeptical:      ['curious', 'unimpressed', 'confused', 'deadpan', 'smug'],
  suspicious:     ['curious', 'mischievous', 'confused', 'playful', 'smug'],
  analyzing:      ['curious', 'calm', 'gentle', 'confused', 'deadpan'],
  daydreaming:    ['sleepy', 'gentle', 'soft', 'calm', 'peaceful'],
  spacing_out:    ['sleepy', 'confused', 'calm', 'gentle', 'deadpan'],
  brainstorming:  ['curious', 'playful', 'cheerful', 'confused', 'hopeful'],
  remembering:    ['gentle', 'soft', 'calm', 'warmth', 'nostalgic'],
  forgetting:     ['confused', 'flustered', 'awkward', 'playful', 'shy'],
  mind_wandering: ['sleepy', 'gentle', 'calm', 'curious', 'peaceful'],
  // ── 状态场景 ──
  sleepy:         ['sleepy', 'tired', 'calm', 'cozy', 'gentle'],
  eating:         ['playful', 'cute', 'cheerful', 'happy', 'cozy'],
  drinking:       ['cozy', 'calm', 'playful', 'cheerful', 'gentle'],
  working:        ['tired', 'calm', 'deadpan', 'sleepy', 'gentle'],
  studying:       ['curious', 'tired', 'calm', 'confused', 'sleepy'],
  exercising:     ['playful', 'cheerful', 'tired', 'happy', 'energetic'],
  gaming:         ['playful', 'mischievous', 'cheerful', 'curious', 'amused'],
  cooking:        ['playful', 'cheerful', 'cute', 'cozy', 'warm'],
  cleaning:       ['tired', 'annoyed', 'calm', 'playful', 'deadpan'],
  shopping:       ['playful', 'cheerful', 'cute', 'happy', 'curious'],
  traveling:      ['cheerful', 'curious', 'playful', 'happy', 'hopeful'],
  resting:        ['sleepy', 'cozy', 'calm', 'peaceful', 'gentle'],
  bathing:        ['cozy', 'calm', 'gentle', 'soft', 'peaceful'],
  dressing_up:    ['cute', 'playful', 'cheerful', 'shy', 'happy'],
  sick:           ['sleepy', 'tired', 'sad', 'gentle', 'comforting'],
  hungover:       ['sleepy', 'tired', 'deadpan', 'sad', 'confused'],
  caffeinated:    ['playful', 'cheerful', 'curious', 'mischievous', 'amused'],
  sugar_rush:     ['playful', 'cheerful', 'mischievous', 'cute', 'happy'],
  food_coma:      ['sleepy', 'cozy', 'tired', 'calm', 'gentle'],
  procrastinating: ['sleepy', 'playful', 'mischievous', 'deadpan', 'tired'],
  // ── 工作/学习 ──
  focused:        ['calm', 'gentle', 'curious', 'deadpan', 'peaceful'],
  productive:     ['cheerful', 'calm', 'happy', 'playful', 'smug'],
  overwhelmed:    ['confused', 'tired', 'flustered', 'sad', 'sleepy'],
  burned_out:     ['tired', 'sleepy', 'deadpan', 'sad', 'calm'],
  slacking:       ['playful', 'mischievous', 'sleepy', 'smug', 'amused'],
  deadline_panic: ['confused', 'flustered', 'nervous', 'tired', 'surprised'],
  meeting_mode:   ['deadpan', 'tired', 'calm', 'sleepy', 'unimpressed'],
  braindead:      ['deadpan', 'tired', 'sleepy', 'confused', 'blank'],
  debugging:      ['confused', 'curious', 'tired', 'annoyed', 'deadpan'],
  eureka_work:    ['surprised', 'cheerful', 'playful', 'joy', 'happy'],
  presenting:     ['nervous', 'shy', 'flustered', 'cheerful', 'calm'],
  multitasking:   ['confused', 'tired', 'playful', 'flustered', 'curious'],
  on_break:       ['cozy', 'calm', 'sleepy', 'playful', 'peaceful'],
  clocking_out:   ['cheerful', 'playful', 'happy', 'relieved', 'sleepy'],
  monday_mood:    ['tired', 'sleepy', 'deadpan', 'annoyed', 'sad'],
  // ── 摸鱼 ──
  sneaky_slack:   ['mischievous', 'playful', 'smug', 'teasing', 'amused'],
  alt_tab:        ['mischievous', 'flustered', 'playful', 'shy', 'nervous'],
  pretend_busy:   ['mischievous', 'deadpan', 'playful', 'smug', 'calm'],
  secret_browse:  ['mischievous', 'playful', 'curious', 'smug', 'teasing'],
  stealth_mode:   ['mischievous', 'playful', 'smug', 'curious', 'teasing'],
  // ── 群聊场景 ──
  lurking:        ['curious', 'shy', 'calm', 'mischievous', 'playful'],
  popcorn:        ['amused', 'playful', 'curious', 'mischievous', 'cheerful'],
  instigating:    ['mischievous', 'teasing', 'playful', 'smug', 'amused'],
  topic_change:   ['playful', 'confused', 'curious', 'mischievous', 'cheerful'],
  reviving_chat:  ['playful', 'cheerful', 'curious', 'cute', 'hopeful'],
  spamming:       ['playful', 'mischievous', 'cheerful', 'amused', 'chaotic'],
  shitposting:    ['playful', 'mischievous', 'amused', 'teasing', 'smug'],
  flexing:        ['smug', 'playful', 'cheerful', 'teasing', 'mischievous'],
  humble_brag:    ['smug', 'shy', 'playful', 'teasing', 'cute'],
  venting:        ['annoyed', 'sad', 'pouty', 'tired', 'flustered'],
  ranting:        ['annoyed', 'pouty', 'playful', 'teasing', 'amused'],
  storytime:      ['curious', 'playful', 'cheerful', 'amused', 'gentle'],
  hot_take:       ['smug', 'playful', 'teasing', 'mischievous', 'amused'],
  unpopular_opinion: ['smug', 'deadpan', 'playful', 'teasing', 'amused'],
  thread_killer:  ['deadpan', 'awkward', 'confused', 'shy', 'blank'],
  necro_post:     ['curious', 'playful', 'mischievous', 'confused', 'amused'],
  first:          ['playful', 'smug', 'cheerful', 'mischievous', 'amused'],
  tldr:           ['deadpan', 'tired', 'calm', 'unimpressed', 'playful'],
  sauce:          ['curious', 'playful', 'mischievous', 'teasing', 'smug'],
  repost:         ['deadpan', 'unimpressed', 'annoyed', 'amused', 'playful'],
  // ── 吃瓜/围观 ──
  watching_drama: ['curious', 'amused', 'playful', 'mischievous', 'teasing'],
  eating_melon:   ['curious', 'amused', 'playful', 'mischievous', 'cheerful'],
  tea_sipping:    ['smug', 'amused', 'playful', 'mischievous', 'curious'],
  nosy:           ['curious', 'playful', 'mischievous', 'amused', 'teasing'],
  rubbernecking:  ['curious', 'amused', 'playful', 'mischievous', 'surprised'],
  plot_twist:     ['surprised', 'amused', 'playful', 'curious', 'mischievous'],
  called_it:      ['smug', 'playful', 'amused', 'teasing', 'cheerful'],
  told_you_so:    ['smug', 'teasing', 'playful', 'amused', 'mischievous'],
  taking_notes:   ['curious', 'calm', 'playful', 'mischievous', 'amused'],
  screenshot:     ['mischievous', 'playful', 'smug', 'amused', 'curious'],
  // ── 猫娘特色 ──
  nuzzling:       ['affectionate', 'cute', 'gentle', 'soft', 'playful'],
  purring:        ['cozy', 'calm', 'gentle', 'soft', 'affectionate'],
  kneading:       ['cute', 'cozy', 'playful', 'affectionate', 'gentle'],
  tail_wagging:   ['playful', 'cheerful', 'cute', 'happy', 'curious'],
  ear_twitch:     ['curious', 'playful', 'cute', 'confused', 'shy'],
  curled_up:      ['cozy', 'sleepy', 'calm', 'gentle', 'soft'],
  stretching:     ['sleepy', 'playful', 'cute', 'cozy', 'calm'],
  grooming:       ['cute', 'calm', 'gentle', 'playful', 'soft'],
  pouncing:       ['playful', 'mischievous', 'cute', 'curious', 'cheerful'],
  hissing:        ['annoyed', 'playful', 'teasing', 'pouty', 'mischievous'],
  meowing:        ['cute', 'playful', 'affectionate', 'gentle', 'cheerful'],
  chirping:       ['cute', 'curious', 'playful', 'cheerful', 'amused'],
  head_tilt:      ['curious', 'cute', 'confused', 'playful', 'gentle'],
  belly_up:       ['playful', 'cute', 'cozy', 'affectionate', 'gentle'],
  zoomies:        ['playful', 'cheerful', 'mischievous', 'cute', 'happy'],
  knocking_things: ['mischievous', 'playful', 'smug', 'teasing', 'amused'],
  box_sitting:    ['cute', 'cozy', 'playful', 'calm', 'curious'],
  sunbathing:     ['cozy', 'calm', 'sleepy', 'peaceful', 'gentle'],
  bird_watching:  ['curious', 'playful', 'cute', 'calm', 'amused'],
  catnip:         ['playful', 'mischievous', 'cheerful', 'confused', 'cute'],
  // ── 撒娇/卖萌 ──
  acting_cute:    ['cute', 'playful', 'gentle', 'soft', 'affectionate'],
  puppy_eyes:     ['cute', 'pouty', 'shy', 'gentle', 'soft'],
  pouting:        ['pouty', 'cute', 'playful', 'annoyed', 'shy'],
  whining:        ['pouty', 'cute', 'sad', 'playful', 'gentle'],
  clingy:         ['affectionate', 'cute', 'playful', 'gentle', 'soft'],
  needy:          ['affectionate', 'cute', 'pouty', 'gentle', 'soft'],
  pampered:       ['cute', 'cozy', 'gentle', 'soft', 'affectionate'],
  spoiled:        ['cute', 'smug', 'playful', 'pouty', 'affectionate'],
  baby_talk:      ['cute', 'playful', 'gentle', 'soft', 'affectionate'],
  uwu:            ['cute', 'soft', 'gentle', 'playful', 'affectionate'],
  // ── 爱情/亲密 ──
  love:           ['affectionate', 'gentle', 'warmth', 'soft', 'comforting'],
  crushing:       ['shy', 'flustered', 'cute', 'playful', 'affectionate'],
  blushing:       ['flustered', 'shy', 'cute', 'gentle', 'soft'],
  heart_eyes:     ['affectionate', 'playful', 'cute', 'cheerful', 'warmth'],
  swooning:       ['affectionate', 'flustered', 'gentle', 'soft', 'shy'],
  cuddling:       ['affectionate', 'cozy', 'gentle', 'soft', 'warmth'],
  hugging:        ['affectionate', 'gentle', 'warmth', 'comforting', 'soft'],
  kissing:        ['affectionate', 'gentle', 'soft', 'playful', 'warmth'],
  holding_hands:  ['affectionate', 'gentle', 'shy', 'soft', 'warmth'],
  missing_you:    ['sad', 'gentle', 'affectionate', 'warmth', 'soft'],
  love_letter:    ['affectionate', 'shy', 'gentle', 'soft', 'warmth'],
  couple_goals:   ['affectionate', 'cheerful', 'playful', 'warmth', 'happy'],
  friendzone:     ['sad', 'deadpan', 'awkward', 'pouty', 'amused'],
  heartbreak_recovery: ['comforting', 'gentle', 'hopeful', 'warmth', 'soft'],
  butterflies:    ['shy', 'flustered', 'cute', 'playful', 'hopeful'],
  // ── 温暖/治愈 ──
  comfort:        ['comforting', 'gentle', 'soft', 'warmth', 'affectionate'],
  cozy:           ['cozy', 'calm', 'gentle', 'soft', 'warm'],
  warm_fuzzy:     ['warmth', 'gentle', 'soft', 'comforting', 'affectionate'],
  healing:        ['comforting', 'gentle', 'soft', 'warmth', 'hopeful'],
  soothing:       ['calm', 'gentle', 'soft', 'comforting', 'peaceful'],
  gentle_pat:     ['gentle', 'soft', 'affectionate', 'comforting', 'warmth'],
  blanket_wrap:   ['cozy', 'comforting', 'gentle', 'soft', 'warmth'],
  hot_cocoa:      ['cozy', 'warm', 'comforting', 'gentle', 'calm'],
  rainy_day:      ['calm', 'cozy', 'gentle', 'peaceful', 'sleepy'],
  sunset_mood:    ['calm', 'gentle', 'peaceful', 'warmth', 'soft'],
  // ── 调皮/恶作剧 ──
  playful:        ['playful', 'mischievous', 'teasing', 'cheerful', 'cute'],
  tease:          ['teasing', 'playful', 'mischievous', 'smug', 'amused'],
  mischievous:    ['mischievous', 'playful', 'teasing', 'smug', 'curious'],
  pranking:       ['mischievous', 'playful', 'teasing', 'amused', 'smug'],
  trolling:       ['mischievous', 'teasing', 'playful', 'smug', 'amused'],
  baiting:        ['mischievous', 'teasing', 'playful', 'smug', 'curious'],
  rickroll:       ['mischievous', 'playful', 'teasing', 'amused', 'smug'],
  gotcha:         ['mischievous', 'playful', 'smug', 'teasing', 'amused'],
  plot_armor:     ['smug', 'playful', 'amused', 'mischievous', 'cheerful'],
  chaos_mode:     ['mischievous', 'playful', 'cheerful', 'amused', 'teasing'],
  // ── 夸张/戏精 ──
  dramatic:       ['playful', 'surprised', 'confused', 'flustered', 'amused'],
  fainting:       ['surprised', 'sleepy', 'playful', 'flustered', 'cute'],
  dying_inside:   ['deadpan', 'tired', 'sad', 'amused', 'playful'],
  soul_leaving:   ['deadpan', 'tired', 'sleepy', 'confused', 'amused'],
  ascended:       ['calm', 'peaceful', 'amused', 'playful', 'deadpan'],
  imploding:      ['confused', 'flustered', 'tired', 'deadpan', 'amused'],
  melting:        ['sleepy', 'cute', 'soft', 'gentle', 'cozy'],
  evaporating:    ['deadpan', 'tired', 'sleepy', 'amused', 'confused'],
  dramatic_exit:  ['playful', 'pouty', 'smug', 'teasing', 'amused'],
  curtain_call:   ['playful', 'smug', 'amused', 'teasing', 'cheerful'],
  // ── 庆祝/成就 ──
  celebrating:    ['cheerful', 'joy', 'happy', 'playful', 'amused'],
  partying:       ['cheerful', 'playful', 'joy', 'happy', 'mischievous'],
  dancing:        ['playful', 'cheerful', 'joy', 'happy', 'cute'],
  fireworks:      ['cheerful', 'joy', 'surprised', 'playful', 'happy'],
  champagne:      ['cheerful', 'playful', 'smug', 'joy', 'happy'],
  victory_lap:    ['smug', 'cheerful', 'playful', 'joy', 'happy'],
  level_up:       ['cheerful', 'playful', 'smug', 'happy', 'joy'],
  achievement:    ['cheerful', 'smug', 'playful', 'happy', 'joy'],
  milestone:      ['cheerful', 'happy', 'hopeful', 'warmth', 'joy'],
  new_year:       ['cheerful', 'playful', 'joy', 'hopeful', 'happy'],
  // ── 失败/翻车 ──
  failing:        ['sad', 'deadpan', 'tired', 'confused', 'awkward'],
  tripping:       ['confused', 'awkward', 'flustered', 'playful', 'amused'],
  face_plant:     ['deadpan', 'awkward', 'confused', 'amused', 'tired'],
  self_destruct:  ['deadpan', 'tired', 'sad', 'amused', 'confused'],
  task_failed:    ['deadpan', 'sad', 'tired', 'confused', 'annoyed'],
  error_404:      ['confused', 'deadpan', 'blank', 'tired', 'amused'],
  blue_screen:    ['deadpan', 'confused', 'tired', 'blank', 'sad'],
  rip:            ['sad', 'deadpan', 'amused', 'playful', 'tired'],
  game_over:      ['sad', 'deadpan', 'tired', 'amused', 'playful'],
  wasted:         ['deadpan', 'tired', 'sleepy', 'sad', 'amused'],
  // ── 天气/环境 ──
  sunny_mood:     ['cheerful', 'happy', 'playful', 'warmth', 'joy'],
  rainy_mood:     ['calm', 'gentle', 'cozy', 'sleepy', 'peaceful'],
  snowy_mood:     ['cozy', 'gentle', 'calm', 'soft', 'peaceful'],
  stormy_mood:    ['annoyed', 'confused', 'flustered', 'surprised', 'playful'],
  windy:          ['playful', 'confused', 'flustered', 'cheerful', 'surprised'],
  hot_weather:    ['tired', 'sleepy', 'annoyed', 'playful', 'deadpan'],
  cold_weather:   ['cozy', 'sleepy', 'cute', 'gentle', 'soft'],
  autumn_vibes:   ['calm', 'gentle', 'cozy', 'peaceful', 'warmth'],
  spring_vibes:   ['cheerful', 'playful', 'hopeful', 'gentle', 'cute'],
  night_owl:      ['sleepy', 'calm', 'curious', 'mischievous', 'playful'],
  // ── 时间相关 ──
  good_morning:   ['sleepy', 'cheerful', 'gentle', 'cute', 'cozy'],
  good_night:     ['sleepy', 'cozy', 'gentle', 'calm', 'affectionate'],
  midnight_snack: ['mischievous', 'playful', 'sleepy', 'cozy', 'cute'],
  weekend_mood:   ['cheerful', 'playful', 'cozy', 'happy', 'calm'],
  friday_feeling: ['cheerful', 'playful', 'happy', 'joy', 'mischievous'],
  monday_blues:   ['tired', 'sleepy', 'sad', 'deadpan', 'annoyed'],
  lunch_time:     ['cheerful', 'playful', 'cute', 'happy', 'cozy'],
  nap_time:       ['sleepy', 'cozy', 'calm', 'gentle', 'cute'],
  overtime:       ['tired', 'annoyed', 'deadpan', 'sad', 'sleepy'],
  vacation_mode:  ['cheerful', 'playful', 'happy', 'cozy', 'calm'],
  // ── 网络/梗 ──
  stonks:         ['smug', 'playful', 'cheerful', 'amused', 'mischievous'],
  not_stonks:     ['sad', 'deadpan', 'disappointed', 'tired', 'amused'],
  this_is_fine:   ['deadpan', 'calm', 'amused', 'confused', 'tired'],
  confused_math:  ['confused', 'curious', 'deadpan', 'tired', 'amused'],
  galaxy_brain:   ['smug', 'playful', 'amused', 'mischievous', 'curious'],
  npc_mode:       ['deadpan', 'blank', 'calm', 'confused', 'tired'],
  main_character: ['smug', 'playful', 'cheerful', 'mischievous', 'amused'],
  glitch:         ['confused', 'surprised', 'deadpan', 'amused', 'playful'],
  buffering:      ['confused', 'deadpan', 'sleepy', 'tired', 'blank'],
  loading:        ['sleepy', 'calm', 'deadpan', 'confused', 'tired'],
  // ── 空白/无 ──
  blank:          ['deadpan', 'blank', 'calm', 'confused', 'tired'],
  void:           ['deadpan', 'blank', 'calm', 'sleepy', 'tired'],
  dissociating:   ['deadpan', 'sleepy', 'confused', 'calm', 'blank'],
  numb:           ['deadpan', 'blank', 'calm', 'tired', 'sleepy'],
  empty:          ['deadpan', 'blank', 'sad', 'calm', 'tired'],
  // ── 决心/力量 ──
  determined:     ['playful', 'cheerful', 'smug', 'calm', 'hopeful'],
  motivated:      ['cheerful', 'playful', 'hopeful', 'happy', 'smug'],
  pumped:         ['cheerful', 'playful', 'happy', 'joy', 'mischievous'],
  battle_ready:   ['playful', 'mischievous', 'smug', 'cheerful', 'teasing'],
  lets_go:        ['cheerful', 'playful', 'happy', 'joy', 'mischievous'],
  // ── 其他 ──
  pensive:        ['calm', 'gentle', 'soft', 'peaceful', 'sad'],
  disappointed:   ['sad', 'pouty', 'deadpan', 'annoyed', 'tired'],
  awkward:        ['awkward', 'flustered', 'shy', 'confused', 'playful'],
  wholesome:      ['warmth', 'gentle', 'affectionate', 'comforting', 'soft'],
  chaotic:        ['mischievous', 'playful', 'confused', 'amused', 'cheerful'],
};
