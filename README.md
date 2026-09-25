# 千枝物語 CharacterGame

AI 驅動的自由劇情視覺小說：玩家自訂世界與角色，輝達文字模型寫劇情，本機 ComfyUI 畫立繪與場景。支援中文、英文，可選即時生成或批次預先寫完整棵劇情樹。

製作全紀錄（教學網站）：https://nice923boss.github.io/CharacterGame/

## 本機啟動

需要：Windows、Python 3.12、ComfyUI（Z-Image Turbo 模型）、輝達 NVIDIA API 金鑰。

1. 安裝套件：

   ```bash
   pip install -r requirements.txt
   ```

2. 複製 `.env.example` 成 `.env`，填入 `NVIDIA_API_KEY`。
3. 先開 ComfyUI（`127.0.0.1:8000`）。`server/config.py` 的 `COMFY_OUTPUT`、`COMFY_INPUT` 改成你的 ComfyUI 資料夾。
4. 雙擊 `啟動千枝物語.bat`：啟動伺服器並自動開瀏覽器，關掉黑色視窗就停止。伺服器已在跑時只開瀏覽器。也可以在專案根目錄手動啟動：

   ```bash
   python -m server.main
   ```

5. 瀏覽器開 http://127.0.0.1:8765

測試：`python -m pytest`

## 資料夾

| 路徑 | 內容 |
|---|---|
| `server/` | FastAPI 後端、劇情生成、產圖、批次模式、測試 |
| `web/` | 前端（p5.js） |
| `saves/` | 存檔與生成的圖片 |
| `docs/` | 開發紀錄、驗收截圖、故事紀錄 |
| `spikes/` | 開工前的技術驗證 |
| `教學網站/` | 製作全紀錄單檔 HTML |
| `GAPS.md` | 已知限制與未驗證項目 |
