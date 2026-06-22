# 小蝸系統更新指南

這份文件只保留「每次改版都要照做」的流程。完整系統背景位於兩個專案的
共同母資料夾 `專案總結.md`。

## 開始更新前

在母資料夾執行：

```bash
./linebot-rental/scripts/maintenance-check.sh
```

它會檢查：

- 網站與 Bot 的 Prisma schema 是否同步
- `.env.example` 是否漏掉程式實際使用的環境變數
- 兩個 Git 專案目前有哪些尚未提交的變更

## 修改範圍判斷

| 更新內容 | 主要修改位置 | 是否需同步另一專案 |
|---|---|---|
| 網站頁面、網站 API | `xiaowo-rental/` | 通常不用 |
| LINE 對話、後台、排程 | `linebot-rental/` | 通常不用 |
| 資料表、欄位、關聯、enum | 任一 `prisma/schema.prisma` | **一定要同步兩份 schema** |
| 房源更新後網站快取 | Bot `admin.js` + 網站 `api/revalidate` | 兩邊都要確認 |
| 新增環境變數 | 使用變數的專案 | 同步更新該專案 `.env.example` 與部署平台 |

## Schema 更新流程

1. 先修改其中一份 `prisma/schema.prisma`。
2. 將相同資料模型修改套用到另一份 schema。
3. 保留 Bot schema 的 `directUrl = env("DIRECT_URL")`；網站 schema 不需要這行。
4. 執行 `./linebot-rental/scripts/maintenance-check.sh`，確認 schema 同步。
5. 在 Bot 專案使用 `DIRECT_URL` 執行資料庫結構更新。
6. 兩個專案各自執行 `npx prisma generate` 並測試。

## 發布前檢查

```bash
./linebot-rental/scripts/maintenance-check.sh
(cd xiaowo-rental && npm run build)
(cd linebot-rental && npm start)
```

`npm start` 會啟動 Bot 服務，不會自行結束；確認能啟動後即可停止。

發布跨專案功能時，建議先部署 Bot，再部署網站，最後實際測試一次房源新增或更新，
確認網站快取有成功刷新。

## 文件維護原則

- `專案總結.md`：只記錄架構、現有能力、重要限制與待辦。
- `linebot-rental/UPDATE_GUIDE.md`：只記錄固定更新流程。
- 兩個專案的 `README.md`：只記錄各自的安裝、開發與部署方式。
- 新增功能時，不必重寫所有文件；只更新真正受影響的那一份。
