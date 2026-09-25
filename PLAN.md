# 千枝物語（暫名，原稿名霧港物語）：AI 驅動自由劇情視覺小說 RPG 開發計畫

> 狀態：M1~M6 已實作；M7 真實端到端驗收結果見 `docs/dev-log.md`。Owner 指示「直接全部做完我再驗收」，中間里程碑未逐一請 Owner 確認。
> 已定案：後端本機 Python（FastAPI）、只在本機遊玩、日系賽璐璐。
> 已決定：文字模型 ultra 關推理主力 + 本機 qwen 關推理備援（第 4 題）；立繪 D6t。

## 0. Spike 結論摘要

詳細數據見 `spikes/SPIKE-REPORT.md`。

| 項目 | 結論 | 證據等級 |
|---|---|---|
| 生圖耗時 | 立繪 30.8~42.1 秒（txt2img 與 img2img 相同）；背景 1280×800 為 40.7~55.2 秒，首張含模型載入 | A（實跑立繪 58 張、背景 3 張） |
| 立繪一致性 | D6t：先生平靜基準圖，表情用整張 img2img（denoise 0.6）產生，只取臉部直式框（高 = 寬 × 1.35）羽化貼回基準圖。身體逐像素一致，表情可分辨。瞳色與髮飾會輕微漂移 | A（實跑並排） |
| 去背 | SKILL 規則（白色系改淺藍底、硬化 alpha、清殘色）讓白襯衫與白髮都保留完整 | A |
| 背景無文字 | 3 張都沒有可讀文字；鐘面羅馬數字、檔案夾標籤橫線屬圖案 | A |
| 文字模型 | 建議主力 ultra 關推理（口吻最好，首句中位 3.0 秒，但 4 次有 2 次 503 過載），備援本機 qwen 關推理（首句 1.3 秒、4/4 成功，有簡體字與動作描寫混入台詞）。待 Owner 選 | A |
| 串流阻塞 | httpx `iter_lines` 在沒收到資料時會一直阻塞，迴圈內的逾時檢查不會執行（kimi-k3 卡 208 秒才跳出）。正式版必須用獨立的 idle watchdog | A |
| 推理位置 | nemotron ultra 與 super 的推理放在 `reasoning_content`，content 內沒有 `<think>`；關推理（`enable_thinking=false`）後首句台詞從 26~31 秒降到 1~4 秒 | A |

## 1. 架構

```
┌──────────────────── 瀏覽器（p5.js，http://127.0.0.1:8765） ────────────────────┐
│ 標題 │ 開局設定 │ 遊戲主畫面（背景層、立繪層、對話框、選項、輸入框） │ 存讀檔 │ 節點樹 │ 設定 │
│ game.js 狀態機  stage.js 繪製  CSS border-image 九宮格  sound.js 配樂  api.js（SSE） │
└──────────────┬───────────────────────────────────────────────▲────────────────┘
               │ POST /api/turn（回 SSE：line / status / final / error）          │ GET /media/...
               │ POST /api/turn/{id}/cancel、/api/saves、/api/tree、/api/jobs    │
┌──────────────▼──────────────── FastAPI 後端（Python） ─────────────────────────┐
│ turn_service ── llm_client（串流、idle watchdog、三組重試、RPM 視窗、候選切換、遮金鑰）│
│      │                                                                        │
│      ├── prompt_builder（世界設定 + 角色 + 狀態 + 前情摘要 + 路徑上最近 6 輪）   │
│      ├── turn_parser（台詞行即時解析、最後一個可解析 JSON、schema 驗證與修補）   │
│      └── story_store（節點樹、存檔槽，JSON 檔，原子寫入）                       │
│ asset_service ── 單一 GPU 佇列（優先序：目前背景 > 目前說話者表情 > 其餘預備）   │
│      ├── comfy_client（txt2img、img2img、上傳、輪詢）                           │
│      └── cutout（沿用 SKILL process_assets 規則）                              │
│ .env（NVIDIA_API_KEY、LOCAL_LLM_*）只在這一層讀取                               │
└──────────────┬───────────────────────────────┬───────────────────────────────┘
               │ HTTPS 串流                     │ HTTP
        輝達 NIM ／ 本機 qwen            ComfyUI 127.0.0.1:8000（Z-Image Turbo）
```

### 等待策略（實測數字）

| 情境 | 實測等待 | 對策 |
|---|---|---|
| 每輪 LLM | 首句台詞中位 1.3~3.0 秒，整輪 11~17 秒（關推理）；過載時換備援再多約 2 秒 | 台詞行一完整就推到前端打字；JSON 在台詞之後，選項晚一點出現不擋閱讀 |
| 換場背景 | 40~55 秒 | 先沿用舊背景加暗化與「場景繪製中」小圖示，劇情照常進行；新圖好了淡入。已生成的場景 id 直接取快取 |
| 開局立繪 | 2 角色 × 5 表情 ≈ 10 張 × 38 秒 ≈ 6.5 分鐘，外加背景 50 秒 | 佇列先生第一場背景與每人「平靜」，約 2.5 分鐘就能開始；其餘表情在背景補齊，缺的表情暫用平靜 |
| 重試中 | 空回退避最長合計 89 秒 | 對話框顯示「連線不穩，第 n 次重試，倒數 s 秒」與取消鈕；取消後回到送出前的節點，輸入內容保留 |

## 2. 立繪做法

採 spike 的 D6t 做法（證據：`spikes/results/sprites/faces3_*.png`、`sheet_*_D6t_cut_dark.png`）：

1. 玩家填的外觀由 LLM 轉成英文外觀描述，逐字固定存進 game.json，另存 seed
2. txt2img 生「平靜」基準圖（512×768，淺藍隔離底，白色系服裝或髮色時沿用 SKILL 規則換底色）
3. 其餘 4 表情：基準圖整張 img2img，denoise 0.6，提示詞 = 同一段外觀描述 + 表情詞
4. 從表情圖取臉部直式框（由去背剪影算頭頂與頭寬，高 = 寬 × 1.35，涵蓋下巴），羽化橢圓貼回基準圖
5. 5 張各自去背

每位角色 5 張約 3 分鐘。已知限制寫進 GAPS.md：瞳色與髮飾輕微漂移、疤痕等小特徵畫不出。
改善方向（M2 內試，不保證）：表情提示詞把瞳色放最前面；貼回後只對虹膜區域做色相校正。

## 3. 節點樹

### 建議粒度：每一輪（玩家一次輸入加 AI 一次回應）是一個節點，場景是節點的分組

理由：
- 分岔發生在玩家回答，若一個場景才一個節點，就無法回到場景中間改選
- 節點樹地圖上以場景為群組框（可收合），20 輪只會看到 3~5 個場景框，不會被 20 個點淹沒
- 一輪一次 LLM 呼叫，節點就是 LLM 的輸入與輸出，重播與分岔都不用重新計算

### 節點內容

```jsonc
{
  "id": "n_0007",
  "parent": "n_0006",              // 根節點為 null
  "children": ["n_0008", "n_0015"], // 分岔後多個
  "scene_id": "harbor_night",
  "player_input": { "kind": "option", "text": "追上去問他懷錶的事" }, // kind: option | free | opening
  "lines": [ { "speaker": "林映月", "expr": "surprised", "text": "……" } ],
  "result": { /* LLM 回傳 JSON，見第 5 節 */ },
  "state": { "affection": {"林映月": 12, "沈硯": 3}, "flags": ["..."], "items": ["..."] }, // 本節點結束後的完整狀態快照
  "summary": "前情摘要（本節點結束後）",
  "bgm_mood": "tense",
  "model": "nvidia/nemotron-3-ultra-550b-a55b",
  "created_at": "2026-09-25T10:00:00+08:00"
}
```

- 節點建立後不再修改（children 除外）。從舊節點改選只會新增子節點，舊分支原樣保留
- 狀態存完整快照而不是差量：一輪不到 1 KB，載入任一節點不用從根重算
- 圖片不存進節點，只存 `scene_id` 與角色 id；圖片放在遊戲的素材庫，多個節點共用

### 重播已走過的路（Owner 追加需求）

回到某節點後送出的文字，若與該節點某個子節點的 `player_input.text` 完全相同（去頭尾空白），後端不呼叫 LLM，直接串流該子節點的台詞並回傳 `final`（帶 `replayed: true`），樹不變，只更新自動存檔。前端在選項後標「（已走過）」，重播時跳提示。劇情樹因此越玩越完整。比對只做完全相同文字，不做語意比對（見 GAPS）。

## 4. 存檔格式

```
saves/
  games/<game_id>/
    game.json          世界設定、角色設定（含英文外觀描述與 seed）、建立時間
    tree.json          { "root": "n_0000", "nodes": { id: node } }
    assets/
      scenes/<scene_id>.png          1280×800
      sprites/<char_id>/<expr>.png   去背後 PNG
      sprites/<char_id>/<expr>.raw.png
  slots.json           [{ slot, game_id, node_id, label, thumb, saved_at }]
  autosave.json        { game_id, node_id }（每輪結束自動寫）
```

- 每輪結束先寫 tree.json（寫暫存檔再 rename，避免寫到一半當機毀檔），再回應前端
- 存檔槽只是「指向某遊戲某節點的書籤」，建議 10 槽加 1 個自動存檔
- 一局遊戲一棵樹；不同存檔槽可指向同一棵樹的不同分支

## 5. LLM 回應格式

採混合式：台詞在前（可逐行串流），JSON 在後（程式狀態）。不用 tool_call，因為會失去串流。

~~~
@林映月|surprised: 這支懷錶……你是從哪裡拿到的？
@旁白|calm: 霧笛從港口深處傳來。
```json
{
  "scene_change": true,
  "scene": { "id": "clock_shop", "name": "舊鐘錶行", "image_prompt": "English, no people, no text ..." },
  "bgm_mood": "calm | warm | tense | sad | mystery | action",
  "options": ["3~4 個，每個 20 字內"],
  "state_changes": { "affection": {"林映月": 1}, "flags_add": [], "items_add": [], "items_remove": [] },
  "summary_update": "本輪一句話摘要"
}
```
~~~

後端驗證與修補（不用重問 LLM 就能處理的先修）：

| 問題 | 處理 |
|---|---|
| 說話者不在名單 | 當旁白顯示 |
| 表情不在 5 種內或漏寫（spike 最常見的格式錯） | 用平靜；另外接受 `@名字: 表情: 台詞` 變體 |
| `@主角` 替玩家說話 | 以主角名牌顯示，不另外處理（spike 7 組都出現過） |
| 台詞含簡體字 | 用 OpenCC s2twp 轉繁（本機已安裝） |
| image_prompt 非英文 | 丟棄本次換場，沿用目前背景，記錄一筆 |
| 選項超過 20 字或不足 3 個 | 截斷；不足時補「繼續聽下去」等固定選項 |
| JSON 解析失敗或缺欄位 | 台詞照常顯示；用「只補 JSON」的短請求再問一次，仍失敗就換候選模型 |

## 6. 輝達與本機端點容錯

照 GBrain `nvidia-api-default-settings`，遊戲情境的調整寫在右欄：

| 項目 | GBrain 值 | 本遊戲 |
|---|---|---|
| stream | True | 同 |
| 逾時 | 300 秒 | 連線 15 秒；首資料 30 秒；串流中 idle 45 秒；總長 240 秒。由獨立 watchdog 判定，不靠 iter_lines 迴圈 |
| max_tokens | 65536 | 關推理時 4096 已足夠（實測單輪 content 約 500~1500 字元）；字元上限 20000 |
| RPM | 35 滑動視窗 | 同 |
| 暫時性狀態碼重試 | 5 次，2~32 秒 | 同；404 也重試 |
| 空回重試 | 2、5、12、25、45 秒 | 前兩次照表；第 3 次起改換候選模型，避免玩家乾等 89 秒 |
| 逾時 | 不重試，直接換候選 | 同 |
| 冷卻鍵 | 供應者加模型名 | 同 |
| 10 條防守 | 全部 | 全部；U+FFFD 清洗、200 內夾錯誤三形狀、finish_reason 與 [DONE] 雙判、遮金鑰 |

取消：前端按取消時後端 cancel 該 asyncio task，httpx 連線隨之關閉；因為節點只在回合完整成功後才寫入，取消不會留下半個節點，玩家停在原本的節點。

## 7. 檔案結構

```
CharacterGame/
  .env                    金鑰（不進版控）
  PLAN.md  GAPS.md
  server/
    main.py               FastAPI 路由、靜態檔
    config.py             讀 .env、常數
    llm_client.py         串流、watchdog、重試、RPM、候選
    turn_service.py       組 prompt、解析、寫節點
    prompts.py            系統提示詞、開局提示詞、角色外觀轉英文
    story_store.py        tree、slots、autosave
    asset_service.py      GPU 佇列、快取
    comfy_client.py       由 spikes/comfy.py 整理而來
    cutout.py             由 SKILL process_assets.py 改寫
    tests/                pytest
  web/
    index.html
    js/ main.js game.js stage.js ui.js api.js tree.js setup.js sound.js（九宮格用 CSS border-image，不另寫 ui9.js）
    ui/                   ComfyUI 產生的介面素材與 ui-spec.json
  saves/
  spikes/                 本次 spike 程式與結果（保留作證據）
  docs/ dev-log.md  screenshots/
```

## 8. 沿用／改寫／新寫

| 沿用 | 改寫 | 新寫 |
|---|---|---|
| SKILL 去背規則（WHITE_WORDS 改淺藍底、alpha 硬化、碎塊移除、殘色清除） | `gen_assets.py`：批次生圖改成常駐佇列、可插隊、回報進度 | 遊戲狀態機、對話框、選項、自由輸入 |
| SKILL 提示詞經驗：no text 寫進正面提示詞、隔離底色、構圖句 | `engine.js`：時間軸播放模型不適用，只取 drawSprite、光暈、顆粒、暗角函式 | 串流 SSE 解析與打字機 |
| `sound.js` 合成器（pluck、pad、chime、whoosh 等） | `sound.js` 的 score 是固定時間軸，改成依 bgm_mood 循環的配樂 | 節點樹、存讀檔、分岔 |
| SKILL 天氣粒子（依 sketch 範本） | `check_cutouts.py`：改成生圖佇列內的自動檢查 | 九宮格 UI 元件 |
| `preview_frames.py` 的 Playwright 截圖做法 | HoloTeam `streamIdle` 概念改寫成 Python asyncio watchdog | 開局設定頁、角色外觀轉英文提示詞 |
| HoloTeam 重試分類與 GBrain 參數 | HoloTeam 重試迴圈（避開已知缺陷：退避無倒數、標頭前停止會卡） | 立繪表情衍生管線（第 2 節定案做法） |

## 9. 里程碑

每個里程碑完成後附截圖與驗證報告，Owner 確認後才進下一個。驗收一律用真實端點與真實 ComfyUI。

| # | 內容 | 驗收 |
|---|---|---|
| M1 | 後端骨架與 LLM 用戶端：串流、watchdog、三組重試、候選切換、取消、遮金鑰；pytest 覆蓋重試分類與 JSON 修補 | 真實端點跑 10 輪，記錄首句台詞與總時長；故意把 base_url 指錯、中途取消，確認狀態與倒數事件正確；grep log 與回應確認無金鑰 |
| M2 | 生圖佇列與立繪管線：角色外觀轉英文、基準圖、表情衍生、去背、快取、背景生成 | 2 位新角色（其中 1 位白髮或白衣）各 5 表情並排圖；去背檢查；佇列插隊實測 |
| M3 | p5 遊戲主畫面：背景、立繪淡入淡出與說話者高亮、對話框打字機、選項、自由輸入、換場轉場、配樂與粒子、等待與重試畫面 | 用 M2 角色實玩 10 輪、至少換 2 次場，每輪截圖；換場時劇情不中斷 |
| M4 | 開局自定義：時空背景預設與自由輸入、多角色表單、開局生成進度畫面 | 從空白建立新世界與 2 角色，計時從按下開始到可以玩的時間 |
| M5 | 存檔與節點樹：自動存檔、10 槽、節點樹地圖（場景分組）、從舊節點分岔 | 存檔、關閉伺服器重開、讀檔；在第 2 場景節點改選，新舊分支都能載入 |
| M6 | 封面與介面素材：風格字串與元件規格定案、ComfyUI 生成無文字素材、九宮格套用到全部 9 種畫面 | 9 種畫面截圖並排，同一風格；放大檢查素材內無文字。實作：`tools/make_ui_assets.py` 黑底生框，左上象限鏡射成完全對稱，裁到框線範圍，保留四角，四邊中段改用最素的一列或一欄重複（拉伸不會拖出花紋），亮度轉 alpha；規格寫在 `web/ui/ui-spec.json` |
| M7 | 端到端驗收 | 依開發提示詞流程：自定義世界與 2 角色 → 20 輪以上、3 場景以上 → 存檔 → 重開讀檔 → 第 2 場景改選 → 新舊分支都在樹上都能載入；全程截圖與 dev-log |

## 10. Pre-mortem

| 問題 | 回答 |
|---|---|
| 最可能失敗 | 輝達 ultra 關推理過載頻繁（spike 4 次有 2 次 503），每輪切到備援，兩個模型口吻不同，劇情風格忽冷忽熱 |
| 失敗機率 | 40%（超過 30%：M1 第一件事就是用真實端點連跑 20 輪量過載率與備援切換後的口吻差異） |
| 早期訊號 | M2 的並排圖出現髮型或服裝不同；M1 的 10 輪中 JSON 修補率超過 20% |
| 對策 | 立繪：表情衍生只動臉部區域，身體像素固定；LLM：關推理、縮短 prompt、失敗改用「只補 JSON」短請求 |
| 放棄條件 | 立繪：M2 兩次調整後仍有一半表情認不出是同一人，改成「只做平靜立繪，表情用程式疊加漫畫符號」；LLM：M1 首句台詞中位超過 15 秒，換模型 |
| 替代方案 | 立繪改 5 表情一張圖（character sheet）再裁切；LLM 改本機 qwen 或其他候選 |
| 預估誤差 | M1~M5 各 0.5~1.5 天；M6 素材風格不穩可能加倍 |

## 11. 自我檢查

### 假設清單（★ 為最不確定的 3 項）

1. ★ 表情衍生做法在「新角色」上一樣有效（spike 只測了 2 位角色）
2. ★ ComfyUI 能畫出可用於九宮格的對稱框線素材；Z-Image 可能畫出不對稱或帶透視的框，要後製裁切
3. ★ 選定模型在 20 輪以上長對話仍守格式（spike 每組只測 4 輪，且歷史只有固定 3 輪）
4. 輝達端點在驗收當天可用；nano 與 palmyra 已 404，候選清單會持續變動
5. 本機 qwen 端點（x.x.x.x，Tailscale）遊玩時在線
6. 6GB VRAM 下 ComfyUI 與 rembg（CPU）同時跑不互搶
7. 每輪 prompt 維持在 6000 字元內，首句台詞時間不隨輪數明顯增加
8. OpenCC s2twp 轉換不會誤改角色名與專有名詞（套件已確認安裝，轉換結果未驗）
9. 玩家只在這台電腦玩，不需要多人或雲端存檔

### 第一次玩的玩家最可能卡住的 3 處

1. 開局等立繪：即使先開始，也要等約 2.5 分鐘；需要一段可以讀的開場（LLM 先寫序章）與進度條
2. 自由輸入寫得太長或太離題，AI 回應後選項接不上；需要輸入框提示與字數上限
3. 節點樹看不懂：一輪一節點會讓樹很長；用場景分組框、目前位置標記、滑鼠移上去顯示那一輪的第一句台詞

### SKILL 與 HoloTeam 可能不適用之處

- SKILL 的 engine.js 每幀是時間 t 的純函式，適合固定動畫；遊戲是事件驅動，播放引擎要重寫
- SKILL 生圖是一次批次跑完再組裝；遊戲要在遊玩中插隊生圖，而且要能被取消或降優先
- SKILL 的提示詞範本針對可愛動物與節日插圖，人物臉部比例、表情詞需要另外調
- HoloTeam 是 TypeScript 與 Electron 主程序，本遊戲後端是 Python，只能移植邏輯
- HoloTeam 的空回退避表合計 89 秒，放在遊戲回合裡太長，改成兩次後換模型
- HoloTeam 紀錄推理在 content 的 `<think>` 裡；本次實測 nemotron 在 `reasoning_content`，兩種都要處理
