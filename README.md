# 客服日回報系統

客服團隊每日回報 web app：手機友善的填寫表單 ＋ 密碼保護的主管彙整後台。

## 功能

**填寫端（`/`）**
- 班別（早班/晚班，主管可改）＋ 姓名 ＋ 日期
- 疑難案件（5次以上回覆或逾1週未結）：平台(LINE/FB可新增)＋客戶識別＋卡關原因(可新增)＋內容＋☑需主管介入，可不斷新增
- 3次內有效回應案件：平台＋內容，可不斷新增
- 新舊人互助事蹟：誰協助誰＋內容（件數自動列入月度彙總，對接考核）
- 交接晚班對象：下拉(可新增)＋備註
- 主管交辦事項：內容＋完成/部分完成/未完成；非完成必填原因與預計完成時間
- 今日追蹤問題件＆進度：**昨日「持續追蹤」案件自動帶入**，只需更新進度或結案
- 前台「＋新增選項」直接寫入範本，全員共用、永久保存
- 草稿自動暫存（localStorage）；**送出即鎖定**（同人同班同日僅一次，要改請主管後台刪除）
- 複製摘要（純文字，可貼 LINE 群）

**主管後台（`/admin.html`，密碼 `ADMIN_PASSWORD`）**
- 月度彙總：每人回報天數、疑難/有效/互助件數、交辦完成率、需介入次數、追蹤未結
- 每日明細＋詳情 modal（⚠需主管介入紅卡標示）＋「只看需主管介入」篩選
- 刪除單筆（該同事即可重填）
- CSV 匯出（含 BOM，Excel 直開不亂碼）
- 📝 編輯回報表內容：改標題/班別/各區塊文字/選項/開關欄位/排序，舊回報不受影響

## 技術

- 零框架 Node `http` server（`server.js`），無 build step
- 儲存：libsql — 本機自動用 `file:local.db`；設 `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` 即用 Turso 雲端
- 資料表：`cs_submissions`、`cs_config`（表名帶 `cs_` 前綴，可與其他系統共用同一個 Turso DB）

## 本機執行

```
npm install
node server.js   # http://localhost:4323
```

## 部署（Render）

1. push 到 GitHub（private repo）
2. Render → New → Web Service → 連 repo（自動讀 `render.yaml`）
3. Environment 設 `ADMIN_PASSWORD`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN` → Deploy
