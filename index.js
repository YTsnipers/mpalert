const axios = require("axios");
const express = require("express");

// === 設定區 ===
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "CP1651WWCHZHH15IKMRCR4XAQFDC7WAEH2";
const targetAddress = (process.env.TARGET_ADDRESS || "0x8270400d528c34e1596EF367eeDEc99080A1b592").toLowerCase();
const startBlock = parseInt(process.env.START_BLOCK) || 21526488;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "7999542928:AAFdRPeyeTTHi_vGJnHYDghiESYR-j14Glw";
const TELEGRAM_CHAT_IDS = process.env.TELEGRAM_CHAT_IDS 
  ? process.env.TELEGRAM_CHAT_IDS.split(',').map(id => parseInt(id.trim()))
  : [1952177981];

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

// === 狀態變數 ===
let historyTxs = [];
let lastUpdateId = null;
let lastHourlyReport = new Date();
let isInitialized = false;

// === Express 伺服器設定（用於健康檢查） ===
const app = express();

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    targetAddress,
    totalTransactions: historyTxs.length,
    lastCheck: new Date().toISOString(),
    uptime: process.uptime(),
    platform: 'Render',
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

// === 工具函式 ===
function formatDate(date) {
  const formatter = new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Taipei",
  });
  return formatter.format(date);
}

function isYear2025(date) {
  return date.getFullYear() === 2025;
}

async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const promises = TELEGRAM_CHAT_IDS.map(async (chatId) => {
    try {
      await axios.post(url, {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      }, {
        timeout: 10000
      });
      console.log(`📤 已推播給 chat_id: ${chatId}`);
      return { chatId, success: true };
    } catch (err) {
      console.error(`❌ 傳送給 ${chatId} 失敗：`, err.response?.data?.description || err.message);
      return { chatId, success: false, error: err.message };
    }
  });

  return Promise.allSettled(promises);
}

async function sendHourlyStatus(newTxs, now) {
  const timeStr = formatDate(now);
  let message;

  if (newTxs.length > 0) {
    message = `🚨 <b>每小時更新</b>：偵測到 ${newTxs.length} 筆新交易\n\n` + 
      newTxs.map(tx =>
        `🔹 ${formatDate(tx.time)}\n🔗 <a href="https://etherscan.io/tx/${tx.hash}">查看交易</a>\n📦 區塊: ${tx.block}`
      ).join("\n\n");
  } else {
    message = `✅ <b>每小時更新</b>：截至 ${timeStr}，過去一小時內沒有新交易`;
  }

  await sendTelegramMessage(message);
}

async function fetchTransactions({ silent = false, forceHourlyReport = false } = {}) {
  const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${targetAddress}&startblock=${startBlock}&endblock=99999999&sort=asc&apikey=${ETHERSCAN_API_KEY}`;

  try {
    console.log(`🔍 開始查詢交易... (silent: ${silent})`);
    
    const res = await axios.get(url, {
      timeout: 30000
    });
    const data = res.data;

    if (data.status !== "1") {
      console.error("❌ Etherscan API 錯誤：", data.message || "未知錯誤");
      if (data.result && typeof data.result === 'string') {
        console.error("詳細錯誤：", data.result);
      }
      return;
    }

    if (!Array.isArray(data.result)) {
      console.error("❌ API 回傳格式錯誤：", typeof data.result);
      return;
    }

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const newTxs = [];

    for (const tx of data.result) {
      const txTime = new Date(parseInt(tx.timeStamp) * 1000);
      
      if (!isYear2025(txTime)) continue;

      const txHash = tx.hash;
      const alreadySeen = historyTxs.some(t => t.hash === txHash);

      if (!alreadySeen) {
        const txObj = {
          hash: txHash,
          time: txTime,
          block: parseInt(tx.blockNumber),
          value: tx.value,
          from: tx.from,
          to: tx.to
        };
        historyTxs.push(txObj);

        if (txTime > oneHourAgo) {
          newTxs.push(txObj);
        }
      }
    }

    historyTxs.sort((a, b) => b.time - a.time);

    console.log(`📊 總共 ${historyTxs.length} 筆 2025 年交易，新增 ${newTxs.length} 筆`);

    if (newTxs.length > 0 && isInitialized) {
      console.log(`🚨 偵測到 ${newTxs.length} 筆新交易`);
      const message = `🚨🚨🚨 <b>${newTxs.length} 筆新交易偵測到</b>\n\n` + 
        newTxs.map(tx =>
          `🔹 時間: ${formatDate(tx.time)}\n🔗 <a href="https://etherscan.io/tx/${tx.hash}">查看交易</a>\n📦 區塊: ${tx.block}\n💰 數值: ${parseFloat(tx.value) / 1e18} ETH`
        ).join("\n\n");
      
      await sendTelegramMessage(message);
    }

    const hoursSinceLastReport = (now - lastHourlyReport) / (1000 * 60 * 60);
    if ((hoursSinceLastReport >= 1 && !silent) || forceHourlyReport) {
      await sendHourlyStatus(newTxs, now);
      lastHourlyReport = now;
    }

    if (!isInitialized) {
      isInitialized = true;
      console.log("✅ 初始化完成，開始監控新交易");
    }

  } catch (err) {
    console.error("❌ 查詢交易發生錯誤：", err.message);
    
    if (err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND') {
      await sendTelegramMessage(`⚠️ 網路連線錯誤：${err.message}`);
    }
  }
}

async function listenToCommands() {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates${lastUpdateId ? `?offset=${lastUpdateId + 1}` : ''}`;

  try {
    const res = await axios.get(url, {
      timeout: 15000
    });
    
    if (!res.data.ok) {
      console.error("❌ Telegram API 錯誤：", res.data.description);
      return;
    }

    const updates = res.data.result;

    for (const update of updates) {
      lastUpdateId = update.update_id;
      const message = update.message;
      
      if (!message || !message.text) continue;

      const text = message.text.trim().toLowerCase();
      const chatId = message.chat.id;
      
      if (!TELEGRAM_CHAT_IDS.includes(chatId)) {
        console.log(`⚠️ 未授權用戶嘗試使用指令：${chatId}`);
        continue;
      }

      console.log(`📥 收到指令：${text} 來自 ${chatId}`);

      if (text === '/check') {
        const now = new Date();
        const timeFrames = [
          { label: '過去 1 小時', since: new Date(now.getTime() - 1 * 60 * 60 * 1000) },
          { label: '過去 24 小時', since: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
          { label: '過去 7 天', since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
        ];

        let messageToSend = `📊 <b>交易統計</b> (${targetAddress.slice(0, 10)}...)\n\n`;

        for (const frame of timeFrames) {
          const txs = historyTxs.filter(tx => tx.time > frame.since);

          if (txs.length === 0) {
            messageToSend += `${frame.label}：✅ 無交易\n`;
          } else {
            messageToSend += `${frame.label}：🔹 ${txs.length} 筆交易\n`;
          }
        }

        messageToSend += `\n🕒 查詢時間：${formatDate(now)}`;

        await sendTelegramMessage(messageToSend);
      } 
      else if (text === '/status') {
        const now = new Date();
        const uptime = Math.floor(process.uptime());
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        
        const statusMessage = `📱 <b>Bot 狀態</b>\n\n` +
          `🎯 監控地址：${targetAddress.slice(0, 10)}...\n` +
          `📊 總交易數：${historyTxs.length}\n` +
          `⏰ 運行時間：${hours}h ${minutes}m\n` +
          `🕒 當前時間：${formatDate(now)}\n` +
          `✅ 狀態：正常運行`;
          
        await sendTelegramMessage(statusMessage);
      }
      else if (text === '/help') {
        const helpMessage = `📋 <b>可用指令</b>\n\n` +
          `/check - 查看交易統計\n` +
          `/status - 查看 Bot 狀態\n` +
          `/help - 顯示此幫助訊息`;
          
        await sendTelegramMessage(helpMessage);
      }
    }
  } catch (err) {
    console.error("❌ 指令監聽錯誤：", err.message);
  }
}

// === Render 免費方案優化 ===
async function selfPing() {
  if (!RENDER_URL) return;
  
  try {
    await axios.get(`${RENDER_URL}/health`, { timeout: 5000 });
    console.log('🏓 自我喚醒 ping 成功');
  } catch (err) {
    console.log('⚠️ 自我喚醒 ping 失敗:', err.message);
  }
}

// === 優雅關閉 ===
process.on('SIGTERM', () => {
  console.log('📴 收到 SIGTERM，正在關閉...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 收到 SIGINT，正在關閉...');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未處理的 Promise 拒絕：', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ 未捕獲的異常：', err);
  process.exit(1);
});

// === 啟動程序 ===
async function startBot() {
  console.log("🚀 啟動 Telegram 監控 Bot...");
  console.log(`📡 監控地址：${targetAddress}`);
  console.log(`📱 通知對象：${TELEGRAM_CHAT_IDS.join(', ')}`);
  
  app.listen(PORT, () => {
    console.log(`🌐 健康檢查伺服器運行在 port ${PORT}`);
  });

  console.log("📡 初始化：載入歷史交易資料...");
  await fetchTransactions({ silent: true });
  
  await sendTelegramMessage(`🚀 Bot 已啟動\n📡 監控地址：${targetAddress.slice(0, 10)}...\n🕒 啟動時間：${formatDate(new Date())}`);

  console.log("⏰ 設定定時任務...");
  
  setInterval(() => {
    fetchTransactions({ silent: true });
  }, 3 * 60 * 1000);

  setInterval(() => {
    fetchTransactions({ silent: false, forceHourlyReport: true });
  }, 60 * 60 * 1000);

  setInterval(() => {
    listenToCommands();
  }, 10 * 1000);

  // Render 免費方案：每 14 分鐘自我喚醒
  if (RENDER_URL) {
    setInterval(() => {
      selfPing();
    }, 14 * 60 * 1000);
    console.log("🏓 已啟用自我喚醒機制 (每 14 分鐘)");
  }

  console.log("✅ Bot 啟動完成！");
}

startBot().catch(err => {
  console.error("❌ Bot 啟動失敗：", err);
  process.exit(1);
});
