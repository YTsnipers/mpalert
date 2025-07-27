# 🚀 Ethereum Address Monitor Bot

一個用於監控以太坊地址交易的 Telegram Bot，支持實時通知和定期狀態報告。

## ✨ 功能特色

- 🔍 **實時監控**：每 3 分鐘檢查目標地址的新交易
- 📱 **即時通知**：偵測到新交易立即推送 Telegram 通知
- 📊 **定期報告**：每小時發送狀態更新
- 🤖 **指令支持**：支持 `/check`、`/status`、`/help` 指令
- 🌐 **健康檢查**：提供 HTTP 端點供監控服務使用
- 🔒 **安全性**：環境變數配置，支持多用戶授權

## 🛠️ 技術架構

- **Node.js** + **Express** 
- **Axios** 用於 API 請求
- **Etherscan API** 獲取交易資料
- **Telegram Bot API** 推送通知
- **Docker** 容器化部署

## 📋 支持的指令

| 指令 | 功能 |
|------|------|
| `/check` | 查看過去 1小時/24小時/7天 的交易統計 |
| `/status` | 查看 Bot 運行狀態和基本資訊 |
| `/help` | 顯示所有可用指令 |

## 🚀 快速開始

### 1. 環境準備

```bash
# 安裝依賴
npm install

# 複製環境變數範本
cp .env.example .env
