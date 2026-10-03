"""Prompt text for the story engine, the world-setup call and the JSON-only repair call, per story language."""
import json

from . import config
from .turn_parser import EXPRESSIONS, MOODS, NARRATOR, WEATHERS, game_lang

RECENT_NODES = 6
MEMORY_EVERY = 8                       # every 8 summary items, the older ones fold into one long-term memory paragraph
MEMORY_CHARS = {"zh": 600, "en": 1200}   # the memory paragraph keeps its newest items within this length
LIVE_TURNS_PER_CHAPTER = 3     # write-as-you-play novel games move on one chapter about every 3 turns

TURN_SYSTEM = {"zh": """你是一款視覺小說 RPG 的劇情引擎。依照世界設定、角色設定、前情摘要與最近對話，寫出「這一輪」的劇情，並給玩家下一步選項。

## 輸出格式（必須嚴格遵守）

第一部分：台詞。每行一句，格式固定：
@說話者|表情: 台詞內容
- 說話者只能是：{speakers}
- 表情只能是：{expressions}（旁白固定寫 calm）
- 本輪寫 3 到 6 行，{protagonist}的台詞最多 1 行
- 角色行只寫說出口的話；動作、神情、環境一律另寫成旁白行
- 全部用繁體中文，口吻符合角色設定；旁白用第三人稱

第二部分：緊接著輸出一個 ```json 區塊，欄位如下，不得多也不得少：
{{
  "scene_change": false,
  "scene": {{"id": "場景代號（英文小寫加底線）", "name": "場景中文名", "image_prompt": "英文生圖提示詞，只寫地點、景物、時段、光線，不寫人物，不寫文字"}},
  "bgm_mood": "{moods} 其中之一",
  "weather": "{weathers} 其中之一",
  "options": ["選項 1", "選項 2", "選項 3"],
  "state_changes": {{"affection": {{{affection}}}, "flags_add": [], "items_add": [], "items_remove": []}},
  "summary_update": "用 1 到 2 句寫本輪發生的重要事件",
  "ending": null
}}
- scene_change：只有地點改變時才是 true；回到去過的地點時沿用「已知場景」的 id 與 name
- scene_change 為 false 時，scene 照填目前場景
- options：{opt_count}，每個 20 字內，是{protagonist}接下來的行動或台詞，方向要彼此不同
- affection 是本輪變化量，-3 到 3
{ending_rule}
json 區塊之後不要再輸出任何文字。""",
               "en": """You are the story engine of a visual novel RPG. Using the world setting, the characters, the story so far and the recent dialogue, write "this turn" of the story and give the player options for the next step.

## Output format (follow it exactly)

Part 1: dialogue. One line per row, always in this form:
@Speaker|expression: line text
- Speaker must be one of: {speakers}
- expression must be one of: {expressions} (the Narrator always uses calm)
- Write 3 to 6 rows this turn; {protagonist} speaks at most 1 row
- Character rows contain only spoken words; actions, looks and surroundings go in separate Narrator rows
- Write everything in natural English that fits each character; the Narrator uses third person

Part 2: right after that, output one ```json block with exactly these fields, no more and no fewer:
{{
  "scene_change": false,
  "scene": {{"id": "scene id (lowercase English with underscores)", "name": "short English scene name", "image_prompt": "English image prompt: place, objects, time of day and lighting only, no people, no text"}},
  "bgm_mood": "one of {moods}",
  "weather": "one of {weathers}",
  "options": ["option 1", "option 2", "option 3"],
  "state_changes": {{"affection": {{{affection}}}, "flags_add": [], "items_add": [], "items_remove": []}},
  "summary_update": "1 or 2 sentences on the important events of this turn",
  "ending": null
}}
- scene_change: true only when the location changes; when returning to a place already visited, reuse its id and name from "Known scenes"
- when scene_change is false, fill scene with the current scene
- options: {opt_count}, each under 10 words, what {protagonist} does or says next, each going a different way
- affection is this turn's change, -3 to 3
{ending_rule}
Output nothing after the json block."""}

ENDING_RULE = {"zh": """- ending：平常填 null。劇情要逐步朝「結局目標」推進，不要急著結束
- 好壞結局一樣可能，不要偏袒主角：主角魯莽行事、無視警告、背叛或拋下同伴、放棄目標、一再判斷錯誤時，局勢要真的惡化並累積代價，不准用巧合、援軍、奇蹟或突然覺醒替主角解圍
- options 的 3 到 4 個選項中，至少 1 個是看似誘人但有明顯風險、可能導向失敗的做法
- 結局目標在本輪明確達成時填 good；目標已經無法達成時（關鍵人物死亡或離去、關鍵物品毀損、時限已過、主角被擊敗、被捕或放棄）填 bad。格式：{"type": "good 或 bad", "title": "結局名稱，8 字內"}
- 填了 ending 的這一輪要寫完收尾劇情（台詞可寫到 8 行），options 填空陣列 []；bad 結局要寫出失敗的後果，不要在最後扭轉成好結果""",
               "en": """- ending: normally null. Move the story step by step toward the "Ending goal" without rushing
- Good and bad endings are equally possible; do not protect the protagonist. When the protagonist acts recklessly, ignores warnings, betrays or abandons allies, gives up on the goal or keeps misjudging, the situation must really get worse and the costs must add up. Never rescue the protagonist with coincidence, reinforcements, miracles or a sudden awakening
- among the 3 or 4 options, at least 1 is tempting but clearly risky and could lead to failure
- fill good when the ending goal is clearly reached this turn; fill bad when the goal can no longer be reached (a key person dies or leaves, a key item is destroyed, time runs out, the protagonist is defeated, captured or gives up). Format: {"type": "good or bad", "title": "ending name, at most 5 words"}
- a turn with an ending must write the closing scene in full (up to 8 rows), and options must be an empty array []; a bad ending shows the cost of failure and is not turned into a happy result at the last moment"""}
NO_ENDING_RULE = {"zh": "- ending：固定填 null", "en": "- ending: always null"}

SETUP_SYSTEM = {"zh": "你是視覺小說的美術指導。把玩家用中文寫的設定轉成生圖用的英文描述。只輸出一個 ```json 區塊，不要其他文字。",
                "en": "You are the art director of a visual novel. Turn the player's setting into English descriptions for image generation. Output only one ```json block and nothing else."}

SETUP_USER = {"zh": """## 世界設定
{world}

## 角色
{characters}

請輸出：
```json
{{
  "title": "故事標題，繁體中文 8 字內",
  "style_en": "英文，描述這個世界的年代、地點與整體視覺氛圍，10 到 20 個英文字，例如 1930s steampunk port city, brass and fog",
  "characters": [
    {{"name": "角色名（照抄）", "appearance_en": "英文逗號分隔：年齡與性別、髮色與髮型、瞳色、服裝（含顏色）、一到兩個配件。不寫表情、不寫姿勢、不寫背景"}}
  ],
  "first_scene": {{"id": "英文小寫加底線", "name": "中文場景名", "image_prompt": "英文，故事開場地點的景物、時段、光線，不寫人物與文字"}}
}}
```""",
              "en": """## World
{world}

## Characters
{characters}

Output:
```json
{{
  "title": "story title in English, at most 5 words",
  "style_en": "10 to 20 English words on the era, place and overall look of this world, e.g. 1930s steampunk port city, brass and fog",
  "characters": [
    {{"name": "character name (copied exactly)", "appearance_en": "comma separated English: age and gender, hair color and style, eye color, clothes (with colors), one or two accessories. No expression, no pose, no background"}}
  ],
  "first_scene": {{"id": "lowercase English with underscores", "name": "short English scene name", "image_prompt": "English: objects, time of day and lighting of the opening location, no people, no text"}}
}}
```"""}

# Novel import: every part of the book is turned into notes, then one call adapts all the notes into a setup draft
NOVEL_NOTES_SYSTEM = {"zh": "你是小說分析助手，替一部小說整理改編成互動遊戲用的筆記。只輸出筆記，不要其他文字。",
                      "en": "You analyse novels and write notes for adapting them into an interactive game. "
                            "Output only the notes and nothing else."}

NOVEL_NOTES_USER = {"zh": """以下是小說{title}的第 {i} 段原文（共 {n} 段）。請用繁體中文整理成筆記：
1. 人物：每位出場人物一行，寫名字、外觀（年齡、髮型髮色、服裝）、個性、說話方式、與其他人物的關係，原文沒寫的就略過
2. 年代與地點的線索
3. 本段依序發生的重要事件，5 到 10 條
全部 600 字內。

## 原文
{text}""",
                    "en": """Below is part {i} of {n} of the novel{title}. Write notes in English:
1. People: one row per person who appears, with name, looks (age, hair, clothes), personality, way of speaking and relationships to the others; skip what the text does not say
2. Clues about the era and the place
3. The important events of this part in order, 5 to 10 items
At most 400 words in total.

## Text
{text}"""}

NOVEL_SYSTEM = {"zh": "你是互動視覺小說的編劇，要把一部小說改編成由玩家扮演主角的遊戲。只輸出一個 ```json 區塊，不要其他文字。",
                "en": "You are the writer of an interactive visual novel, adapting a novel into a game where the player "
                      "plays the protagonist. Output only one ```json block and nothing else."}

NOVEL_USER = {"zh": """以下是小說{title}各段的分析筆記，依原文順序排列。

{notes}

請改編成遊戲設定，輸出：
```json
{{
  "world": {{"era": "年代與時代特徵，40 字內", "place": "主要舞台，40 字內", "genre": "類型，20 字內", "tone": "基調，20 字內",
            "extra": "玩家需要知道的背景或世界規則，120 字內", "goal": "主角在故事結尾要達成的目標，寫成能判定成敗的一句話，60 字內"}},
  "protagonist": {{"name": "主角名字，照原著", "profile": "主角的身分與處境，100 字內"}},
  "characters": [
    {{"name": "角色名字，照原著", "appearance": "年齡、髮型髮色、瞳色、服裝顏色、配件，原著沒寫的合理補上，100 字內",
      "personality": "個性，50 字內", "speech": "說話方式，50 字內", "relationship": "與主角的關係，50 字內"}}
  ],
  "chapters": [
    {{"title": "關卡名稱，12 字內", "summary": "這一關主角面對的處境、衝突與要做的事，80 字內"}}
  ]
}}
```
- protagonist 是原著的主角，由玩家扮演
- characters：主角以外最重要的 1 到 {max_chars} 位角色，不可包含主角，名字不可重複
- chapters：依原著劇情順序切成 {min_ch} 到 {max_ch} 關，每關是一段有明確衝突的劇情，最後一關通往結局
- world 的 extra、protagonist 的 profile 與 characters 只寫故事開頭時的狀態，後段才揭露的真相、轉折與身分只寫在對應關卡的 summary
- title 只寫關卡名稱，不要加「第一章」「第1關」這類編號
- 全部用繁體中文""",
              "en": """Below are the notes on each part of the novel{title}, in the order of the book.

{notes}

Adapt it into a game setup and output:
```json
{{
  "world": {{"era": "era and its features, at most 25 words", "place": "main setting, at most 25 words",
            "genre": "genre, at most 6 words", "tone": "tone, at most 6 words",
            "extra": "background or world rules the player needs, at most 70 words",
            "goal": "what the protagonist must achieve by the end, one sentence whose success or failure can be judged, at most 35 words"}},
  "protagonist": {{"name": "the protagonist's name as in the book", "profile": "who the protagonist is and their situation, at most 60 words"}},
  "characters": [
    {{"name": "name as in the book", "appearance": "age, hair style and color, eye color, clothing colors, accessories; fill in what the book leaves out, at most 60 words",
      "personality": "at most 30 words", "speech": "way of speaking, at most 30 words", "relationship": "relationship to the protagonist, at most 30 words"}}
  ],
  "chapters": [
    {{"title": "chapter name, at most 6 words", "summary": "the situation, conflict and task the protagonist faces in this chapter, at most 50 words"}}
  ]
}}
```
- protagonist is the main character of the book, played by the player
- characters: the 1 to {max_chars} most important people other than the protagonist, never the protagonist, no repeated names
- chapters: {min_ch} to {max_ch} chapters in the order of the book, each a stretch of story with a clear conflict; the last one leads to the ending
- world extra, the protagonist profile and characters describe things as they stand when the story begins; truths, twists and identities revealed later go only in the summary of their chapter
- a title is only the chapter name, with no numbering such as "Chapter 1"
- write everything in English"""}

# Labels and fixed sentences inside the user message
TEXT = {
    "zh": {"era": "年代", "place": "地點", "genre": "類型", "tone": "基調", "extra": "補充", "goal": "結局目標",
           "look": "外觀", "personality": "個性", "speech": "說話方式", "relationship": "與主角關係",
           "hero": "- 主角：{name}，{profile}（由玩家扮演）", "action": "（{name}的行動）{text}",
           "h_world": "## 世界設定", "h_chars": "## 角色", "h_known": "## 已知場景", "h_scene": "## 目前場景",
           "h_state": "## 目前狀態", "h_summary": "## 前情摘要", "h_recent": "## 最近對話", "none": "（無）",
           "h_memory": "## 長期記憶（較早的劇情）", "memory_sep": "；", "memory_end": "。",
           "opening": "## 本輪任務\n這是故事的第一輪。用旁白交代{name}的處境與目前場景的氣氛，"
                      "讓至少一位角色登場並對主角說話。scene_change 填 false，ending 填 null。",
           "player": "## 玩家本輪行動\n{text}", "go": "請寫出本輪劇情。", "sep": "、", "colon": "：",
           "repair": "你的回應缺少 ```json 區塊。台詞不要重寫，只輸出本輪的 ```json 區塊，欄位照系統訊息。",
           "continue": "你上一則回應在這裡中斷了。從中斷處直接接著寫，不要重複已寫出的台詞，格式照系統訊息，"
                       "最後一樣附上本輪的 ```json 區塊。",
           "opt_any": "3 或 4 個", "opt_n": "剛好 {n} 個", "opt_rule": "3 到 4 個選項", "opt_rule_n": "{n} 個選項",
           "h_turn": "## 回合進度", "turn_k": "這是第 {k} 輪，全篇最多 {d} 輪。",
           "turn_last": "本輪是最後一輪：必須在本輪寫出結局，依主角至今的選擇判定 good 或 bad，ending 不可為 null。",
           "turn_near": "下一輪就是最後一輪，本輪要把劇情推到決定性的關頭。",
           "scene_budget": "盡量沿用「已知場景」，真的換到新地點才新增（全篇最多 {max} 個場景，目前 {n} 個）。",
           "scene_full": "場景數已達上限：不可新增場景，只能留在原地或換到「已知場景」中的地點。",
           "force_ending": "本輪是最後一輪，ending 不可為 null。台詞不要重寫，只輸出本輪的 ```json 區塊，"
                           "ending 照系統訊息的格式填，type 依主角至今的選擇判定 good 或 bad，options 填 []。",
           "h_novel": "## 原著關卡大綱", "novel_src": "本作改編自小說《{title}》。",
           "novel_rule": "劇情大致依關卡順序推進，保留原著人物的個性與關係；玩家的選擇可以改變事件的經過與結果，不要照抄原文。",
           "chapter_row": "{i}. {title}：{summary}", "h_chapter": "## 本輪關卡",
           "chapter_now": "目前在第 {i} 關「{title}」（共 {n} 關）。",
           "chapter_span": "本輪涵蓋第 {a} 到 {b} 關（共 {n} 關），把這幾關的重點濃縮在本輪。",
           "chapter_next": "本輪是這一關的尾聲，把劇情引向下一關「{title}」。",
           "chapter_last": "這是最後一關，劇情要朝結局推進。"},
    "en": {"era": "Era", "place": "Place", "genre": "Genre", "tone": "Tone", "extra": "Notes", "goal": "Ending goal",
           "look": "Looks", "personality": "Personality", "speech": "Way of speaking",
           "relationship": "Relationship to the protagonist",
           "hero": "- Protagonist: {name}, {profile} (played by the player)", "action": "({name}'s action) {text}",
           "h_world": "## World", "h_chars": "## Characters", "h_known": "## Known scenes",
           "h_scene": "## Current scene", "h_state": "## Current state", "h_summary": "## Story so far",
           "h_recent": "## Recent dialogue", "none": "(none)",
           "h_memory": "## Long-term memory (earlier story)", "memory_sep": "; ", "memory_end": ".",
           "opening": "## This turn\nThis is the first turn of the story. Use the Narrator to set up {name}'s situation "
                      "and the mood of the current scene, and bring in at least one character who speaks to the "
                      "protagonist. scene_change is false, ending is null.",
           "player": "## Player's action this turn\n{text}", "go": "Write this turn.", "sep": ", ", "colon": ": ",
           "repair": "Your reply is missing the ```json block. Do not rewrite the dialogue; output only this "
                     "turn's ```json block with the fields from the system message.",
           "continue": "Your previous reply was cut off here. Continue straight from where it stopped without repeating "
                       "any line already written, keep the format from the system message, and end with this turn's "
                       "```json block as usual.",
           "opt_any": "3 or 4", "opt_n": "exactly {n}", "opt_rule": "the 3 or 4 options", "opt_rule_n": "the {n} options",
           "h_turn": "## Turn count", "turn_k": "This is turn {k} of at most {d}.",
           "turn_last": "This is the last turn: the story must end in this turn. Decide good or bad from the "
                        "protagonist's choices so far; ending must not be null.",
           "turn_near": "The next turn is the last one; bring the story to its deciding moment in this turn.",
           "scene_budget": "Reuse the \"Known scenes\" where you can; add a new one only for a real change of place "
                           "(at most {max} scenes in the whole story, {n} so far).",
           "scene_full": "The scene budget is used up: do not add a scene; stay here or move to one of the "
                         "\"Known scenes\".",
           "force_ending": "This is the last turn, so ending must not be null. Do not rewrite the dialogue; output "
                           "only this turn's ```json block: ending in the format from the system message, its type good or "
                           "bad from the protagonist's choices so far, and options set to [].",
           "h_novel": "## Chapters of the original", "novel_src": "This story is adapted from the novel \"{title}\".",
           "novel_rule": "Move through the chapters roughly in order and keep the characters' personalities and "
                         "relationships from the book; the player's choices may change how events go and how they "
                         "turn out. Do not copy the book's text.",
           "chapter_row": "{i}. {title}: {summary}", "h_chapter": "## Chapter this turn",
           "chapter_now": "Now in chapter {i}, \"{title}\" (of {n}).",
           "chapter_span": "This turn covers chapters {a} to {b} (of {n}); fold the key points of these chapters "
                           "into this turn.",
           "chapter_next": "This turn closes the chapter; lead the story toward the next one, \"{title}\".",
           "chapter_last": "This is the last chapter; move the story toward the ending."},
}


def world_text(world: dict, lang: str) -> str:
    T = TEXT[lang]
    rows = [f"- {T[k]}{T['colon']}{world[k]}" for k in ("era", "place", "genre", "tone", "extra", "goal")
            if world.get(k)]
    return "\n".join(rows)


def characters_text(game: dict, lang: str) -> str:
    T = TEXT[lang]
    out = []
    for c in game["characters"]:
        out.append(f"### {c['name']}\n" + "\n".join(
            f"- {T[label]}{T['colon']}{c[k]}" for k, label in (("appearance", "look"), ("personality", "personality"),
                                                               ("speech", "speech"), ("relationship", "relationship"))))
    return "\n".join(out)


def protagonist_text(game: dict, lang: str) -> str:
    p = game["protagonist"]
    return TEXT[lang]["hero"].format(name=p["name"], profile=p.get("profile", ""))


def turn_system(game: dict) -> str:
    lang = game_lang(game)
    T = TEXT[lang]
    names = [c["name"] for c in game["characters"]]
    n = (game.get("batch") or {}).get("options")
    ending_rule = (ENDING_RULE if game["world"].get("goal") else NO_ENDING_RULE)[lang]
    if n:
        ending_rule = ending_rule.replace(T["opt_rule"], T["opt_rule_n"].format(n=n))
    return TURN_SYSTEM[lang].format(
        speakers=T["sep"].join([NARRATOR[lang], *names, game["protagonist"]["name"]]),
        expressions=T["sep"].join(EXPRESSIONS), moods="|".join(MOODS), weathers="|".join(WEATHERS),
        protagonist=game["protagonist"]["name"],
        affection=", ".join(f'"{n}": 0' for n in names),
        opt_count=T["opt_n"].format(n=n) if n else T["opt_any"],
        ending_rule=ending_rule)


def batch_turn_text(game: dict, turn: int) -> str:
    """Turn count and scene budget for a batch game; the tree is only finite if every branch ends by the last turn."""
    T = TEXT[game_lang(game)]
    last = game["batch"]["turns"]
    rows = [T["turn_k"].format(k=turn, d=last)]
    if turn >= last:
        rows.append(T["turn_last"])
    elif turn == last - 1:
        rows.append(T["turn_near"])
    n = len(game["scenes"])
    rows.append(T["scene_full"] if n >= config.BATCH_MAX_SCENES
                else T["scene_budget"].format(max=config.BATCH_MAX_SCENES, n=n))
    return f"{T['h_turn']}\n" + "\n".join(rows)


def chapter_start(game: dict, turn: int) -> int:
    """First chapter (0-based) of turn `turn`. Batch games spread the chapters over their fixed turns; live games move
    on one chapter every LIVE_TURNS_PER_CHAPTER turns and then stay on the last one."""
    n = len(game["novel"]["chapters"])
    if game.get("batch"):
        return min(n, (turn - 1) * n // game["batch"]["turns"])
    return min(n - 1, (turn - 1) // LIVE_TURNS_PER_CHAPTER)


def novel_text(game: dict, lang: str) -> str:
    T = TEXT[lang]
    novel = game["novel"]
    rows = [T["novel_src"].format(title=novel["title"])] if novel.get("title") else []
    rows += [T["chapter_row"].format(i=i, title=c["title"], summary=c["summary"])
             for i, c in enumerate(novel["chapters"], 1)]
    rows.append(T["novel_rule"])
    return f"{T['h_novel']}\n" + "\n".join(rows)


def chapter_text(game: dict, turn: int, lang: str) -> str:
    """Which chapter(s) this turn plays, and a nudge toward the next chapter on the turn that closes one."""
    T = TEXT[lang]
    chapters = game["novel"]["chapters"]
    n = len(chapters)
    a, nxt = chapter_start(game, turn), chapter_start(game, turn + 1)
    b = max(a, nxt - 1)
    rows = [T["chapter_now"].format(i=a + 1, title=chapters[a]["title"], n=n) if a == b
            else T["chapter_span"].format(a=a + 1, b=b + 1, n=n)]
    if b == n - 1:
        rows.append(T["chapter_last"])
    elif nxt > b:
        rows.append(T["chapter_next"].format(title=chapters[nxt]["title"]))
    return f"{T['h_chapter']}\n" + "\n".join(rows)


def _node_transcript(node: dict, protagonist: str, lang: str) -> list[str]:
    rows = []
    pi = node.get("player_input") or {}
    if pi.get("kind") in ("option", "free"):
        rows.append(TEXT[lang]["action"].format(name=protagonist, text=pi["text"]))
    rows += [f"@{ln['speaker']}: {ln['text']}" for ln in node.get("lines", [])]
    return rows


def split_summary(summary: list[str], lang: str) -> tuple[str, list[str]]:
    """Long-term memory paragraph and the recent summary items (G13).

    Every MEMORY_EVERY items, the older ones fold into one paragraph, so the recent list holds 8 to 15 items;
    the paragraph drops its oldest items past MEMORY_CHARS and then starts with an ellipsis.
    """
    T = TEXT[lang]
    folded = max(0, (len(summary) - MEMORY_EVERY) // MEMORY_EVERY * MEMORY_EVERY)
    old = [s.rstrip("。.") for s in summary[:folded]]
    keep = old
    while keep and len(T["memory_sep"].join(keep)) > MEMORY_CHARS[lang]:
        keep = keep[1:]
    memory = (("…" if len(keep) < len(old) else "") + T["memory_sep"].join(keep) + T["memory_end"]) if keep else ""
    return memory, summary[folded:]


def turn_messages(game: dict, path: list[dict], player_input: dict, scene: dict) -> list[dict]:
    """path: nodes from root to the parent of the new turn (may be empty for the opening)."""
    lang = game_lang(game)
    T = TEXT[lang]
    protagonist = game["protagonist"]["name"]
    parent = path[-1] if path else None
    state = parent["state"] if parent else {"affection": {}, "flags": [], "items": []}
    summary = parent["summary"] if parent else []
    known = "\n".join(f"- {sid}{T['colon']}{s['name']}" for sid, s in game["scenes"].items()) or T["none"]
    recent = [row for n in path[-RECENT_NODES:] for row in _node_transcript(n, protagonist, lang)]

    parts = [f"{T['h_world']}\n{world_text(game['world'], lang)}\n{protagonist_text(game, lang)}",
             f"{T['h_chars']}\n{characters_text(game, lang)}",
             *([novel_text(game, lang)] if game.get("novel") else []),
             f"{T['h_known']}\n{known}",
             f"{T['h_scene']}\n{scene['id']}{T['colon']}{scene['name']}",
             f"{T['h_state']}\n" + json.dumps(state, ensure_ascii=False)]
    memory, items = split_summary(summary, lang)
    if memory:
        parts.append(f"{T['h_memory']}\n{memory}")
    if items:
        parts.append(f"{T['h_summary']}\n" + "\n".join(f"{i + 1}. {s}" for i, s in enumerate(items)))
    if recent:
        parts.append(f"{T['h_recent']}\n" + "\n".join(recent))
    if game.get("novel"):
        parts.append(chapter_text(game, len(path) + 1, lang))
    if game.get("batch"):
        parts.append(batch_turn_text(game, len(path) + 1))
    if player_input["kind"] == "opening":
        parts.append(T["opening"].format(name=protagonist))
    else:
        parts.append(T["player"].format(text=player_input["text"]))
    parts.append(T["go"])
    return [{"role": "system", "content": turn_system(game)}, {"role": "user", "content": "\n\n".join(parts)}]


def setup_messages(world: dict, characters: list[dict], lang: str) -> list[dict]:
    chars = "\n".join(f"- {c['name']}{TEXT[lang]['colon']}{c['appearance']}" for c in characters)
    return [{"role": "system", "content": SETUP_SYSTEM[lang]},
            {"role": "user", "content": SETUP_USER[lang].format(world=world_text(world, lang), characters=chars)}]


def novel_notes_messages(title: str, i: int, n: int, text: str, lang: str) -> list[dict]:
    return [{"role": "system", "content": NOVEL_NOTES_SYSTEM[lang]},
            {"role": "user", "content": NOVEL_NOTES_USER[lang].format(title=title, i=i, n=n, text=text)}]


def novel_messages(title: str, notes: list[str], lang: str, max_chars: int, min_ch: int, max_ch: int) -> list[dict]:
    body = "\n\n".join(f"### {i}\n{x}" for i, x in enumerate(notes, 1))
    return [{"role": "system", "content": NOVEL_SYSTEM[lang]},
            {"role": "user", "content": NOVEL_USER[lang].format(title=title, notes=body, max_chars=max_chars,
                                                                min_ch=min_ch, max_ch=max_ch)}]


def repair_messages(turn_msgs: list[dict], reply_text: str, lang: str, key: str = "repair") -> list[dict]:
    """key "force_ending": the last turn of a batch game came back without an ending.
    key "continue": the reply broke off after `reply_text` (whole lines); ask for the rest only."""
    return [*turn_msgs, {"role": "assistant", "content": reply_text},
            {"role": "user", "content": TEXT[lang][key]}]
