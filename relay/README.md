# 轉送服務（CORS relay）

## 這是什麼，為什麼需要

GitHub Pages 版的遊戲整個跑在玩家的瀏覽器裡：故事、存檔、圖片都存在瀏覽器（IndexedDB），不需要任何伺服器。
唯一的例外是呼叫輝達 API：瀏覽器的安全規則（CORS）不允許網頁直接呼叫 `integrate.api.nvidia.com` 與
`ai.api.nvidia.com`，所以需要一支很小的轉送程式，把遊戲的請求原封不動轉給輝達，再把結果傳回來。

- 金鑰是玩家自己的，存在玩家瀏覽器的 localStorage，隨每次請求的 `Authorization` 標頭經過轉送，轉送不儲存、不記錄。
- 只轉送兩個路徑：`/v1/chat/completions`（文字）與 `/v1/genai/*`（生圖），其他一律 404。
- 只接受 `ALLOWED_ORIGINS` 列出的網站來源，其他來源回 403 `origin_not_allowed`。

## 內建轉送

Pages 版已內建 `https://chienzhi-relay.cattravelworld.com`（`tools/build_pages.py` 的 `RELAY`），
設定頁的轉送網址欄會預先填好內建網址，學員只要填輝達 API Key。設定裡自己填的網址會優先於內建值；清空或存回內建網址則繼續跟隨內建值。

它是部署在 Cloudflare 機房的 Worker，擁有者的電腦關機也能用。

## 部署或更新（擁有者）

```bash
cd relay
npx wrangler login     # 第一次：瀏覽器授權 Cloudflare 帳號
npx wrangler deploy    # 依 wrangler.toml 部署，並綁定 chienzhi-relay.cattravelworld.com
```

`wrangler.toml` 的 `ALLOWED_ORIGINS` 是允許使用這個轉送的網站來源（只填 `https://網域`，不含路徑），逗號分隔。

## 每日額度計數

Cloudflare 免費方案每天大約 10 萬次 Worker 請求（`wrangler.toml` 的 `DAILY_LIMIT`，以帳號實際方案為準）。
超過後 Cloudflare 回的錯誤頁沒有 CORS 標頭，遊戲只會看到「連不上」，所以轉送自己計數：

- 每個請求計入當天次數（UTC 日期，台灣時間早上 8 點換日），存在 Durable Object `Usage`（`USAGE` 綁定）。
- 用到 80%：回應加上 `x-relay-quota: near`，遊戲提醒一次。
- 用到 95%：轉送直接回 429 `relay_quota`（帶 CORS 標頭），遊戲說明轉送今日額度已滿，不再重試。預檢（OPTIONS）照常通過。
- `GET /usage` 回傳 `{limit, days}`：最近 7 天每天的請求次數，沒有玩家或金鑰資料。

限制：

- 計數是近似值：每個執行個體最多每 30 秒回報一次總數，各執行個體的第一個請求還不知道當天總數。
- 只算這支轉送；同帳號其他 Worker 的請求不算進來。
- Durable Object 需要帳號有 workers.dev 子網域，沒有時部署會出現錯誤 10063。本帳號已建 `cattravelworld.workers.dev`；
  `workers_dev = false`，轉送不會出現在那個網址。
- 學員從後台貼上的版本沒有 `USAGE` 綁定：不計數、不擋。`tools/dev_relay.py` 也不計數。

## 學員自己架（選用）

設定頁「轉送網址是什麼？怎麼填？」有步驟：在 Cloudflare 後台建立 Worker，貼上 `relay-worker.js`，
設定變數 `ALLOWED_ORIGINS`，部署後把 `https://….workers.dev` 網址貼到設定（結尾不加 `/v1`）。

## 本機測試用

`tools/dev_relay.py` 是同樣行為的 Python 版，只綁 127.0.0.1:8787。
`--inject-env-key` 會改用 `.env` 的金鑰，只限擁有者本機測試，絕不可對外公開這個埠。
