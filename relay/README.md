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
學員在設定只要填輝達 API Key，轉送網址留空。設定裡自己填的網址會優先於內建值。

它是部署在 Cloudflare 機房的 Worker，擁有者的電腦關機也能用。

## 部署或更新（擁有者）

```bash
cd relay
npx wrangler login     # 第一次：瀏覽器授權 Cloudflare 帳號
npx wrangler deploy    # 依 wrangler.toml 部署，並綁定 chienzhi-relay.cattravelworld.com
```

`wrangler.toml` 的 `ALLOWED_ORIGINS` 是允許使用這個轉送的網站來源（只填 `https://網域`，不含路徑），逗號分隔。

## 學員自己架（選用）

設定頁「轉送網址是什麼？怎麼填？」有步驟：在 Cloudflare 後台建立 Worker，貼上 `relay-worker.js`，
設定變數 `ALLOWED_ORIGINS`，部署後把 `https://….workers.dev` 網址貼到設定（結尾不加 `/v1`）。

## 本機測試用

`tools/dev_relay.py` 是同樣行為的 Python 版，只綁 127.0.0.1:8787。
`--inject-env-key` 會改用 `.env` 的金鑰，只限擁有者本機測試，絕不可對外公開這個埠。
