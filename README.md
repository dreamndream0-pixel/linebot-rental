# 🐌 小蝸出租 LINE Bot

租屋管理 LINE Bot，支援空房查詢、看房預約、維修回報、收租提醒。

## 功能

| 功能 | 說明 |
|------|------|
| 查詢空房 | 租客可看到所有空房資訊與照片 |
| 預約看房 | 選擇房間 → 日期 → 時段，自動通知房東 |
| 維修回報 | 選擇問題類型 → 描述 → 自動通知房東 |
| 收租提醒 | 每月自動推播提醒租客繳租 |
| 智慧門鎖 | 包租代管內整合 TTLock，房客用 LINE 自助取當日門鎖密碼 |

## 智慧門鎖（TTLock）— 包租代管功能

整合自 rubyclean 的門鎖管理，直接搬進後台「包租代管」分頁，讓房客在 LINE 輸入「密碼」即可取得**當日**門鎖密碼。

- **權限**：進階功能，預設關閉。由**總管理員**在後台「房東 → ⚙️ 權限設定」勾選 `🔐 智慧門鎖` 才對該房東開放。
- **入口**：後台「包租代管」分頁上方的 `🔐 門鎖管理` 按鈕。裡面用建物分頁列出所有房間，每間可設定：
  - **門鎖類型**：`🔐 TTLock 電子鎖` / `🔢 普通密碼鎖` / `🗝️ 傳統喇叭鎖`
  - **Lock ID**：TTLock 的 lockId（可多把，逗號分隔）
  - **房客 LINE User ID**：填入即綁定，只有此 User ID 能索取該房密碼
- **匯入預設**：`📥 匯入 rubyclean 預設` 一鍵帶入 rubyclean 既有的門鎖房間資料（保留已填的房客 User ID）。
- **帳號**：每個房東各自一組 TTLock 帳密，於門鎖管理內「設定帳密」填入（存於 `landlord.ttlockConfig`）。
- **取密碼**：房客在 LINE 輸入「密碼」→ 依其 User ID 找到綁定房間 → 回傳當日密碼。
  - 密碼鎖：依房號＋日期以固定算式計算（台北星期）
  - TTLock：呼叫 API 產生當日限時密碼（有效至台北當日 23:59）
  - 傳統鎖：提示無密碼，請聯絡房東

> 資料存於房東的 `landlord.lockRooms`（JSON：`{ roomKey: { type, ids, userId } }`）。
>
> 依賴 Node.js 全域 `fetch`（Node 18+）。
>
> ⚠️ 本次新增了 `landlords.ttlockConfig`、`landlords.lockRooms` 兩個欄位——依 UPDATE_GUIDE 規則，
> `xiaowo-rental/prisma/schema.prisma` 也已同步相同欄位，兩份 schema 需保持一致。

## 快速開始

### 1. 安裝依賴
```bash
npm install
```

### 2. 設定環境變數
```bash
cp .env.example .env
# 填入你的 LINE Token 和資料庫連線字串
```

### 3. 初始化資料庫
```bash
npx prisma db push
```

### 4. 啟動（開發）
```bash
npm run dev
```

### 5. 本地測試用 ngrok
```bash
ngrok http 3000
# 將 ngrok URL + /webhook 填入 LINE Developers Console
```

## 取得必要設定

### LINE Channel Access Token & Secret
1. 前往 https://developers.line.biz/
2. 建立 Provider → 新增 Messaging API Channel
3. 在 Channel 設定頁取得 Token 和 Secret

### 你的 LINE User ID（房東 ID）
在 LINE Developers Console → Messaging API → Bot information 下方
可用以下方式取得：傳訊給你自己的 Bot，Server 會 log 出你的 userId

### Supabase 連線字串
1. 前往 https://supabase.com/ 新增 Project
2. Settings → Database → Connection string（URI 格式）

## 部署到 Render

1. 推到 GitHub
2. 前往 https://render.com → New Web Service
3. 連結 GitHub repo
4. 設定環境變數
5. Build command: `npm install && npx prisma db push`
6. Start command: `npm start`

## 資料庫管理

```bash
# 開啟 Prisma Studio（視覺化管理介面）
npm run db:studio
```

## 新增房源（目前用 Prisma Studio）

日後可加入房東管理介面，目前先用 Prisma Studio 手動新增：

```
Property {
  name: "201室"
  rent: 8000
  deposit: 16000
  size: 5.5
  description: "採光良好套房，含冷氣熱水器"
  isAvailable: true
}
```
