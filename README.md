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

整合自 rubyclean 的門鎖邏輯，讓房客在 LINE 輸入「密碼」即可取得**當日**門鎖密碼。

- **權限**：進階功能，預設關閉。由**總管理員**在後台「房東 → ⚙️ 權限設定」勾選 `🔐 智慧門鎖` 才對該房東開放。
- **帳號**：每個房東各自一組 TTLock 帳密，於後台「包租代管 → 某物件 → 🔐 門鎖密碼 → 設定帳密」填入（存於 `landlord.ttlockConfig`）。
- **綁定**：後台手動輸入房客 LINE User ID ↔ 門鎖 Lock ID（存於 `LockTenant`）；只有綁定的 User ID 能索取。
- **規則**：密碼當天有效（台北時區 23:59），同日重複索取回傳同一組；免費 3 次／年（每年重置），第 4 次起每次收 50 元作業費並記入待收帳款。

> 依賴 Node.js 全域 `fetch`（Node 18+）。
>
> ⚠️ 本次新增了 `landlords.ttlockConfig` 欄位與 `lock_tenants` 資料表——依 UPDATE_GUIDE 規則，
> `xiaowo-rental/prisma/schema.prisma` 也已同步相同模型，兩份 schema 需保持一致。

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
