const axios = require("axios");
const express = require("express");

// === 設定區 ===
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const targetAddress = (process.env.TARGET_ADDRESS || "0x8270400d528c34e1596EF367eeDEc99080A1b592").toLowerCase();
const startBlock = parseInt(process.env.START_BLOCK) || 21526488;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_IDS = process.env.ADMIN_CHAT_IDS 
  ? process.env.ADMIN_CHAT_IDS.split(',').map(id => parseInt(id.trim()))
  : [];

// 檢查必要的環境變數
if (!ETHERSCAN_API_KEY) {
  console.error("❌ 缺少 ETHERSCAN_API_KEY 環境變數");
  process.exit(1);
}

if (!TELEGRAM_BOT_TOKEN) {
  console.error("❌ 缺少 TELEGRAM_BOT_TOKEN 環境變數");
  process.exit(1);
}

if (ADMIN_CHAT_IDS.length === 0) {
  console.error("❌ 缺少 ADMIN_CHAT_IDS 環境變數");
  process.exit(1);
}

const INVITE_CODE = process.env.INVITE_CODE || "ETH2025";
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

// === 用戶管理 ===
let authorizedUsers = new Set();
let userJoinDates = new Map(); // 記錄用戶加入時間

// 初始化管理員用戶
ADMIN_CHAT_IDS.forEach(id => {
  authorizedUsers.add(id);
  userJoinDates.set(id, new Date());
});

// === 狀態變數 ===
let historyTxs = [];
let lastUpdateId = null;
let lastHourlyReport = new Date();
let isInitialized = false;

// === Express 伺服器設定 ===
const app = express();

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    targetAddress,
    totalTransactions: historyTxs.length,
    totalUsers: authorizedUsers.size,
    adminUsers: ADMIN_CHAT_IDS.length,
    lastCheck: new Date().toISOString(),
    uptime: process.uptime(),
    platform: 'Render',
    version: '2.0.0'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', users: authorizedUsers.size });
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

function isAdmin(chatId) {
  return ADMIN_CHAT_IDS.includes(chatId);
}

// 發送訊息給特定用戶
async function sendTelegramMessage(message, targetChatIds = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const chatIds = targetChatIds || Array.from(authorizedUsers);

  const promises = chatIds.map(async (chatId) => {
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
      
      // 如果用戶封鎖了 Bot，從授權列表中移除（除非是管理員）
      if (err.response?.data?.error_code === 403 && !isAdmin(chatId)) {
        authorizedUsers.delete(chatId);
        userJoinDates.delete(chatId);
        console.log(`🗑️ 已移除無法送達的用戶：${chatId}`);
      }
      
      return { chatId, success: false, error: err.message };
    }
  });

  return Promise.allSettled(promises);
}

// 處理用戶訂閱/取消訂閱
async function handleUserManagement(chatId, messageText, userInfo) {
  const userName = userInfo?.first_name || userInfo?.username || `用戶${chatId}`;
  
  // 訂閱功能
  if (messageText === '/subscribe') {
    if (!authorizedUsers.has(chatId)) {
      authorizedUsers.add(chatId);
      userJoinDates.set(chatId, new Date());
      
      await sendTelegramMessage(
        `🎉 歡迎 ${userName}！\n✅ 訂閱成功！你現在會收到 ${targetAddress.slice(0, 10)}... 的交易通知。\n\n📋 輸入 /help 查看可用指令`, 
        [chatId]
      );
      
      // 通知管理員
      if (ADMIN_CHAT_IDS.length > 0) {
        await sendTelegramMessage(
          `📢 新用戶訂閱\n👤 ${userName} (${chatId})\n🕒 ${formatDate(new Date())}\n👥 總用戶數：${authorizedUsers.size}`, 
          ADMIN_CHAT_IDS
        );
      }
      
      console.log(`📢 新用戶訂閱：${userName} (${chatId})`);
    } else {
      await sendTelegramMessage(`ℹ️ ${userName}，你已經訂閱過了！`, [chatId]);
    }
    return true;
  }
  
  // 取消訂閱功能
  if (messageText === '/unsubscribe') {
    if (authorizedUsers.has(chatId)) {
      if (!isAdmin(chatId)) {
        authorizedUsers.delete(chatId);
        userJoinDates.delete(chatId);
        await sendTelegramMessage(`👋 ${userName}，取消訂閱成功！如需重新訂閱，請發送 /subscribe`, [chatId]);
        
        // 通知管理員
        if (ADMIN_CHAT_IDS.length > 0) {
          await sendTelegramMessage(
            `📤 用戶取消訂閱\n👤 ${userName} (${chatId})\n👥 剩餘用戶數：${authorizedUsers.size}`, 
            ADMIN_CHAT_IDS
          );
        }
        
        console.log(`📤 用戶取消訂閱：${userName} (${chatId})`);
      } else {
        await sendTelegramMessage(`ℹ️ 管理員無法取消訂閱`, [chatId]);
      }
    } else {
      await sendTelegramMessage(`ℹ️ 你還沒有訂閱`, [chatId]);
    }
    return true;
  }
  
  // 邀請碼加入功能
  if (messageText.startsWith('/join ')) {
    const code = messageText.split(' ')[1];
    if (code === INVITE_CODE) {
      if (!authorizedUsers.has(chatId)) {
        authorizedUsers.add(chatId);
        userJoinDates.set(chatId, new Date());
        await sendTelegramMessage(
          `🎉 ${userName}，邀請碼正確！\n✅ 成功加入監控群組！\n📋 輸入 /help 查看可用指令`, 
          [chatId]
        );
        
        // 通知管理員
        if (ADMIN_CHAT_IDS.length > 0) {
          await sendTelegramMessage(
            `🎫 邀請碼用戶加入\n👤 ${userName} (${chatId})\n👥 總用戶數：${authorizedUsers.size}`, 
            ADMIN_CHAT_IDS
          );
        }
      } else {
        await sendTelegramMessage(`ℹ️ ${userName}，你已經是會員了！`, [chatId]);
      }
    } else {
      await sendTelegramMessage(`❌ 邀請碼錯誤！請聯繫管理員獲取正確的邀請碼。`, [chatId]);
    }
    return true;
  }
  
  return false;
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

  message += `\n\n👥 目前訂閱用戶：${authorizedUsers.size} 人`;
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
      console.log(`🚨 偵測到 ${newTxs.length} 筆新交易，推送給 ${authorizedUsers.size} 位用戶`);
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
      await sendTelegramMessage(`⚠️ 網路連線錯誤：${err.message}`, ADMIN_CHAT_IDS);
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
      const userInfo = message.from;
      
      console.log(`📥 收到訊息：${text} 來自 ${chatId} (${userInfo?.first_name || userInfo?.username || '未知'})`);

      // 處理用戶管理指令（對所有用戶開放）
      const handled = await handleUserManagement(chatId, text, userInfo);
      if (handled) continue;

      // 幫助指令（對所有用戶開放）
      if (text === '/help') {
        const isAuthorized = authorizedUsers.has(chatId);
        const isUserAdmin = isAdmin(chatId);
        
        let helpMessage = `📋 <b>可用指令</b>\n\n`;
        
        if (!isAuthorized) {
          helpMessage += `📢 <b>加入群組：</b>\n`;
          helpMessage += `/subscribe - 訂閱交易通知\n`;
          helpMessage += `/join 邀請碼 - 使用邀請碼加入\n\n`;
        } else {
          helpMessage += `👤 <b>用戶指令：</b>\n`;
          helpMessage += `/check - 查看交易統計\n`;
          helpMessage += `/status - 查看 Bot 狀態\n`;
          helpMessage += `/unsubscribe - 取消訂閱\n\n`;
        }
        
        if (isUserAdmin) {
          helpMessage += `👑 <b>管理員指令：</b>\n`;
          helpMessage += `/users - 查看用戶列表\n`;
          helpMessage += `/broadcast 訊息 - 廣播訊息\n\n`;
        }
        
        helpMessage += `/help - 顯示此幫助訊息`;
          
        await sendTelegramMessage(helpMessage, [chatId]);
        continue;
      }

      // 以下指令需要授權
      if (!authorizedUsers.has(chatId)) {
        await sendTelegramMessage(
          `❌ 你尚未授權使用此 Bot\n\n📢 加入方式：\n/subscribe - 直接訂閱\n/join 邀請碼 - 使用邀請碼\n/help - 查看幫助`, 
          [chatId]
        );
        continue;
      }

      // 授權用戶指令
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
        await sendTelegramMessage(messageToSend, [chatId]);
      } 
      else if (text === '/status') {
        const now = new Date();
        const uptime = Math.floor(process.uptime());
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const userJoinDate = userJoinDates.get(chatId);
        
        const statusMessage = `📱 <b>Bot 狀態</b>\n\n` +
          `🎯 監控地址：${targetAddress.slice(0, 10)}...\n` +
          `📊 總交易數：${historyTxs.length}\n` +
          `👥 訂閱用戶：${authorizedUsers.size} 人\n` +
          `⏰ 運行時間：${hours}h ${minutes}m\n` +
          `📅 你的加入時間：${userJoinDate ? formatDate(userJoinDate) : '未知'}\n` +
          `🕒 當前時間：${formatDate(now)}\n` +
          `✅ 狀態：正常運行`;
          
        await sendTelegramMessage(statusMessage, [chatId]);
      }

      // 管理員專用指令
      if (isAdmin(chatId)) {
        if (text === '/users') {
          const userList = Array.from(authorizedUsers).map((uid, index) => {
            const joinDate = userJoinDates.get(uid);
            const isUserAdmin = isAdmin(uid);
            return `${index + 1}. ${uid}${isUserAdmin ? ' 👑' : ''} (${joinDate ? formatDate(joinDate) : '未知'})`;
          }).join('\n');
          
          const usersMessage = `👥 <b>用戶列表</b> (${authorizedUsers.size} 人)\n\n${userList}`;
          await sendTelegramMessage(usersMessage, [chatId]);
        }
        else if (text.startsWith('/broadcast ')) {
          const broadcastMessage = message.text.substring(11); // 移除 '/broadcast '
          if (broadcastMessage.trim()) {
            const finalMessage = `📢 <b>管理員廣播</b>\n\n${broadcastMessage}`;
            await sendTelegramMessage(finalMessage);
            await sendTelegramMessage(`✅ 廣播訊息已發送給 ${authorizedUsers.size} 位用戶`, [chatId]);
          }
        }
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
  console.log("🚀 啟動多用戶 Telegram 監控 Bot...");
  console.log(`📡 監控地址：${targetAddress}`);
  console.log(`👑 管理員數量：${ADMIN_CHAT_IDS.length}`);
  console.log(`🎫 邀請碼已設定`);
  console.log(`👥 初始用戶數：${authorizedUsers.size}`);
  
  app.listen(PORT, () => {
    console.log(`🌐 健康檢查伺服器運行在 port ${PORT}`);
  });

  console.log("📡 初始化：載入歷史交易資料...");
  await fetchTransactions({ silent: true });
  
  // 發送啟動通知給管理員
  const startupMessage = `🚀 <b>Bot 已啟動</b>\n\n` +
    `📡 監控地址：${targetAddress.slice(0, 10)}...\n` +
    `👥 當前用戶數：${authorizedUsers.size}\n` +
    `📊 歷史交易數：${historyTxs.length}\n` +
    `🕒 啟動時間：${formatDate(new Date())}\n\n` +
    `🎫 邀請碼：<code>${INVITE_CODE}</code>\n` +
    `📋 用戶可發送 /subscribe 直接訂閱`;
    
  await sendTelegramMessage(startupMessage, ADMIN_CHAT_IDS);

  console.log("⏰ 設定定時任務...");
  
  // 每 3 分鐘查詢一次（主要監控）
  setInterval(() => {
    fetchTransactions({ silent: true });
  }, 3 * 60 * 1000);

  // 每小時發送狀態報告
  setInterval(() => {
    fetchTransactions({ silent: false, forceHourlyReport: true });
  }, 60 * 60 * 1000);

  // 每 10 秒監聽指令
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
