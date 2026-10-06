# 探究與實作上台報告平台

Firebase 即時版：抽籤排序、QR 即時評分、座號紀錄、三向度報告評量、報告／提問／換場計時、平均分數與 Excel 匯出。

## 正式網址

- 公開網站：<https://addielu-phy.github.io/inquiry-practice-report-platform/>
- 原始碼：<https://github.com/addielu-phy/inquiry-practice-report-platform>

## 公開網站版特色

- 老師端在 GitHub Pages 上直接開啟，不需要安裝。
- 可依不同班級設定組數，例如 8 組、9 組、12 組；也可手動修改特殊組名。
- 老師按「建立即時收分 Session」後，系統產生學生 QR Code。
- 學生掃 QR 後填寫自己的組別與座號；分數寫入 **Firebase Realtime Database**，老師投影畫面約 1 秒內即時更新。
- 學生用學校 Wi-Fi 或自己的 4G／5G 都能評分（只需要一般 HTTPS／WebSocket，不再需要 WebRTC 點對點連線）。
- 老師重新整理頁面會自動恢復同一個 Session 與 QR Code；評分同時備份在老師瀏覽器 localStorage。
- 報告組分數分成三個探究與實作關鍵能力：
  1. **探究問題與方法設計**：問題意識、變因控制、方法合理性。
  2. **資料證據與分析解釋**：數據品質、圖表呈現、證據支持結論。
  3. **科學表達與回應能力**：結構清楚、時間掌握、回應提問。
- 提問組維持「問題品質分數」1–10 分。
- 報告時間可設定 3–10 分鐘（預設 5）、提問時間 1–5 分鐘（預設 3），評分／換場固定 3 分鐘；設定會保存在老師瀏覽器與 Firebase Session，重新整理不會遺失。
- 老師端可顯示本輪報告組、提問組、倒數計時、三向度平均、報告總平均、提問平均與未評分組別。
- 活動結束可下載 `.xlsx` Excel 檔與 JSON 備份。

## 使用流程

0. 第一次使用前，先完成下方「Firebase 設定教學」（只需做一次）。
1. 老師開啟公開網址。
2. 確認活動名稱。
3. 在「組數快速設定」輸入班級組數，例如 `9`，按「套用組數」。
4. 若有特殊組名，在組別名單中逐行修改。
5. 按「儲存並抽籤」。
6. 按「建立／恢復即時收分 Session」（需要換新 QR 時按「開新 Session」）。
7. 投影 QR Code 給學生掃。
8. 學生填寫：
   - 自己的組別
   - 自己的座號
   - 報告組三項能力分數
   - 提問組問題品質分數
9. 每輪依序按：
   - 開始報告（依設定，預設 5:00）
   - 開始提問（依設定，預設 3:00）
   - 評分／換場 3:00
   - 下一輪＋開始報告
10. 活動結束下載 Excel 與 JSON 備份。

## Excel 欄位

Excel 會包含：

- 總表：每輪報告總平均、三向度平均、提問平均、評分人數、已評分組數、未評分組別。
- 組別總結：各組作為報告組與提問組時的平均表現。
- 原始評分：每一筆學生送出的評分，包含評分組別與座號。
- 抽籤排序：每輪報告組與提問組排序。

## 重要限制

- 需要先設定自己的 Firebase 專案（免費 Spark 方案即可，一個班級的評分資料量非常小）。
- 評分以「組別::座號」為一筆，同一支手機重複送出＝更新自己的評分。
- 為了避免冒名覆蓋，**某個「組別＋座號」第一次送出後，只有同一支手機／同一個瀏覽器能修改**。學生換手機或換瀏覽器（例如從 LINE 內建瀏覽器改用 Safari）再送出會被拒絕，請學生用原本的裝置修改，或由老師清空後重送。
- 學生只能寫入「目前這一輪」；老師換輪後，舊輪次不能再補送。
- 活動結束請務必下載 Excel／JSON 備份。

## Firebase 設定教學（老師只需做一次）

### 1. 建立 Firebase 專案
1. 用 Google 帳號登入 <https://console.firebase.google.com/>。
2. 按「建立專案」，取一個名字（例如 `inquiry-report-2026`），Google Analytics 可以關閉。

### 2. 啟用 Realtime Database
1. 左側選單「建構 → Realtime Database」→「建立資料庫」。
2. 位置建議選 **Singapore (asia-southeast1)**（離台灣最近）。
3. 安全性規則先選「以鎖定模式啟動」，下一步再貼上本專案的規則。
4. 建好後，頁面最上方會顯示資料庫網址，例如
   `https://inquiry-report-2026-default-rtdb.asia-southeast1.firebasedatabase.app`，等一下會用到。

### 3. 啟用匿名登入（Anonymous Auth）
1. 左側「建構 → Authentication」→「開始使用」。
2. 「登入方式（Sign-in method）」→ 選「匿名（Anonymous）」→ 啟用 → 儲存。
   - 老師與學生都會自動以匿名身分登入，不需要帳號密碼；規則用這個身分判斷「誰是建立 Session 的老師」。

### 4. 貼上安全性規則
1. 回到「Realtime Database → 規則（Rules）」分頁。
2. 把本專案 `database.rules.json` 的全部內容貼上，按「發布」。
3. 規則重點：
   - 只有建立 Session 的老師（同一個匿名身分）能修改輪次、計時、組別與清空／匯入評分。
   - 學生只能寫入 `sessions/{Session}/scores/{目前輪次}/{組別::座號}`，欄位必須齊全，分數必須是 1–10，座號 1–12 字元，組別必須存在，且不能是本輪報告組或提問組。
   - 學生不能讀取別人的評分，也不能刪除評分。
   - 某筆評分建立後，只有原本送出的那支手機（或老師）能更新。
   - 若要放寬「換手機也能更新自己的評分」，可把規則中 `$key` 的 `.write` 裡 `&& (!data.exists() || data.child('uid').val() === auth.uid)` 這段刪除（代價是任何人都能覆蓋別人的同組同座號紀錄）。

### 5. 新增網頁應用程式並貼上設定
1. 專案總覽旁的齒輪「專案設定」→「一般」→ 最下方「你的應用程式」→ 點 `</>`（網頁）。
2. 取一個暱稱，**不用**勾選 Firebase Hosting，按「註冊應用程式」。
3. 畫面會出現 `const firebaseConfig = { ... }`，把裡面的值逐一貼到本專案的 **`src/firebase-config.js`**，取代所有 `YOUR_...`。
4. 確認 `databaseURL` 是第 2 步看到的資料庫網址（若 Firebase 給的設定沒有這一行，請自己補上）。
5. 這些設定值本來就會公開在網頁上，安全性由第 4 步的規則保護。

### 6. 授權網域
1. 「Authentication → 設定（Settings）→ 授權網域（Authorized domains）」。
2. 按「新增網域」，加入 `你的帳號.github.io`（例如 `addielu-phy.github.io`）。`localhost` 預設已在清單中，可用於本機測試。

### 7. 部署到 GitHub Pages
1. 把修改後的 `src/firebase-config.js` commit 並 push 到 `main` 分支。
2. 本 repo 已有 `.github/workflows/pages.yml`，push 後 GitHub Actions 會自動部署（Repository → Settings → Pages 的 Source 需設為「GitHub Actions」）。
3. 打開 `https://你的帳號.github.io/inquiry-practice-report-platform/`，按「建立／恢復即時收分 Session」，狀態顯示「即時收分中」就成功了。

### 8. 上課前檢查清單
- 用 1 支手機走學校 Wi-Fi、1 支手機走 4G／5G，各掃一次 QR 送出測試分數，確認老師畫面數字有跳動。
- 若顯示「沒有權限」：檢查規則是否已發布、匿名登入是否已啟用。
- 若顯示「尚未設定 Firebase」：檢查 `src/firebase-config.js` 是否還有 `YOUR_`。
- 學校網路需能連到 `www.gstatic.com`（Firebase 程式庫）與 `*.firebasedatabase.app`。
- 用測試資料試完後按「清空評分」，或按「開新 Session」。

### 免費額度與資料清理
- Spark 免費方案：Realtime Database 1 GB 儲存、每月 10 GB 下載、同時 100 個連線，足夠一般班級使用（同時在線人數超過 100 需升級 Blaze 方案）。
- 每個 Session 的資料會留在 Firebase，學期結束可以到 Realtime Database 的「資料」分頁刪除 `sessions` 底下舊的 Session。

## 運作方式（技術說明）

- 老師端按「建立 Session」：以匿名身分寫入 `sessions/{id}/meta`（記錄老師 uid），再寫入 `sessions/{id}/state`（活動名稱、組別、抽籤順序、目前輪次、階段、計時器 `endsAt`、報告／提問時間設定 `durations`）。修改時間只影響下一次按「開始」，不會改動正在倒數的計時。
- 學生端開啟 `?session={id}`：以 `onValue` 監聽 `state`，倒數時間由手機依 `endsAt` 與 Firebase 伺服器時間差在本機計算；送出時寫入 `sessions/{id}/scores/{輪次}/{組別::座號}`，Firebase 確認寫入後才顯示「已送出」，8 秒沒確認會顯示逾時並可重試。
- 老師端以 `onValue` 監聽 `scores`，一有新評分就重新計算平均、進度與未評分組別，並備份到 localStorage。
- 在線學生數：學生手機寫入 `presence/{uid}`，斷線時由 Firebase 自動移除。
- 老師開新 Session 時，會在舊 Session 標記 `movedTo`，仍停在舊 QR 的學生手機會自動跳到新 Session。
- 學生頁只載入 Firebase 程式庫；QR Code（qrious）與 Excel（SheetJS）只在老師端需要時才載入。
- 連線容錯（針對 4G／5G 不穩）：
  - `index.html` 以 `modulepreload` 預先下載 Firebase SDK；SDK 下載失敗時自動重新載入頁面（2 分鐘內最多 2 次）。
  - 匿名登入失敗會自動重試（1、2、4…最多 15 秒間隔），慢的請求會持續等待，不會因逾時直接卡死。
  - 資料庫預設走 WebSocket；若 7 秒內沒連上（例如 WebSocket 被卡住），自動改用 long polling，不必等 SDK 內建的 30 秒逾時。
  - 學生狀態列會顯示目前進度與已等待秒數；超過 45 秒仍未連上才提示可手動重新整理。

## 本機 LAN 備援版

本機版不使用 Firebase，學生必須和老師電腦連同一個 Wi-Fi（用自己 4G／5G 的學生無法使用）。需要自動輸出到 Google Drive for desktop 時可用。⚠️ 本機版仍是舊規格：沒有座號、只有單一報告分數，而且每組只保留一筆（同組成員送出會互相覆蓋）。注意：本機 LAN 版保留原始課堂備援流程；若要與公開網站版完全同規格，需另行同步更新 `local-server/server.py`。

```bash
PYTHONUNBUFFERED=1 uv run --with 'qrcode[pil]' python local-server/server.py
```

本機版會顯示：

- 老師端：`http://<LAN_IP>:8765/`
- 學生端：`http://<LAN_IP>:8765/student`

學生需與老師電腦在同一個 Wi-Fi / LAN。

## 開發與調整

本網站是純靜態檔案：

- `index.html`：頁面結構
- `src/styles.css`：版面與視覺
- `src/app.js`：抽籤、Firebase 即時收分、計時與 Excel 匯出邏輯（ES module）
- `src/firebase-config.js`：Firebase 設定（老師唯一需要修改的檔案）
- `database.rules.json`：Realtime Database 安全性規則
- `firebase.json`：Firebase CLI／Emulator 設定（只用於部署規則或本機測試，GitHub Pages 不需要）
- `local-server/server.py`：本機 LAN 備援版

檢查 JavaScript 語法：

```bash
node --check src/app.js
node --check src/firebase-config.js
```

用 Firebase Emulator 在本機測試（不需要真的 Firebase 專案，需要 Java 與 Node.js）：

```bash
npx firebase-tools emulators:start --only database,auth --project demo-ipr
# 另開一個終端機
python -m http.server 8080
# 瀏覽器打開 http://127.0.0.1:8080/?emulator=1（學生網址會自動帶 emulator=1）
```

也可以用 Firebase CLI 部署規則：`npx firebase-tools deploy --only database --project 你的專案ID`。

本機預覽：

```bash
python -m http.server 8080
```

然後打開：

```text
http://127.0.0.1:8080/
```
