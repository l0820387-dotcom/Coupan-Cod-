/**
 * bot.js
 * -----------------------------------------------------------------------
 * All Telegram-facing logic. Started once by server.js (require('./bot')).
 * Exposes deliverOrder() + notifyAdmins() so server.js's Paytm webhook can
 * push messages to users after real payment verification completes.
 * -----------------------------------------------------------------------
 */
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const dbLayer = require('./database');

const bot = new TelegramBot(config.telegram.botToken, { polling: true });

// In-memory per-user navigation state (category/product/qty being built up).
// Safe because this is a single bot process.
const sessions = {}; // userId -> { step, categoryId, productId, quantity }

function session(userId) {
  if (!sessions[userId]) sessions[userId] = {};
  return sessions[userId];
}

// ---------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------
function inlineRows(buttons) {
  // buttons: [{text, data} | {text, url}]
  return buttons.map(row => row.map(b => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })));
}

function mainMenuKeyboard() {
  const settings = dbLayer.db.get('settings').value();
  const enabled = settings.buttons.filter(b => b.enabled);
  const rows = {};
  enabled.forEach(b => {
    rows[b.row] = rows[b.row] || [];
    rows[b.row][b.col - 1] = { text: b.label, data: `menu:${b.action}` };
  });
  const grid = Object.keys(rows)
    .sort((a, b) => a - b)
    .map(r => rows[r].filter(Boolean));
  return { reply_markup: { inline_keyboard: grid } };
}

async function isMemberOfChannel(userId, channel) {
  try {
    const member = await bot.getChatMember(channel.chatId || channel.username, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (e) {
    return false; // if bot isn't admin in channel or user not found -> treat as not joined
  }
}

async function getMissingChannels(userId) {
  const channels = dbLayer.getActiveRequiredChannels();
  const missing = [];
  for (const ch of channels) {
    const ok = await isMemberOfChannel(userId, ch);
    if (!ok) missing.push(ch);
  }
  return missing;
}

function channelGateMessage(missing) {
  let text = '🔐 *Access Restricted*\n\nPlease join the following channel(s) to unlock the bot:\n\n';
  missing.forEach((c, i) => {
    text += `${i + 1}. ${c.name}\n`;
  });
  text += '\nAfter joining ALL channels, tap ✅ Verify Membership.';
  const rows = missing.map(c => [{ text: `➡️ Join ${c.name}`, url: c.link }]);
  rows.push([{ text: '✅ Verify Membership', data: 'verify_channels' }]);
  return { text, reply_markup: { inline_keyboard: inlineRows(rows) } };
}

async function sendMainMenu(chatId, userId) {
  const user = dbLayer.getUser(userId);
  const settings = dbLayer.db.get('settings').value();
  const text = settings.welcomeMessage.replace('{name}', user.firstName || 'there');
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
}

// ---------------------------------------------------------------------
// /start  ->  registration -> channel gate -> main menu
// ---------------------------------------------------------------------
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const referredBy = match && match[1] ? match[1].trim() : null;

  const settings = dbLayer.db.get('settings').value();
  if (settings.maintenanceMode && !config.telegram.adminIds.includes(userId)) {
    return bot.sendMessage(chatId, settings.maintenanceMessage);
  }

  const user = dbLayer.getOrCreateUser(msg.from, referredBy);
  if (user.blocked) {
    return bot.sendMessage(chatId, '🚫 Your account has been blocked. Contact support if you believe this is a mistake.');
  }

  const missing = await getMissingChannels(userId);
  if (missing.length > 0) {
    const { text, reply_markup } = channelGateMessage(missing);
    return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup });
  }
  await sendMainMenu(chatId, userId);
});

// ---------------------------------------------------------------------
// Callback query router
// ---------------------------------------------------------------------
bot.on('callback_query', async query => {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const data = query.data;

  try {
    const user = dbLayer.getUser(userId) || dbLayer.getOrCreateUser(query.from);
    if (user.blocked) {
      return bot.answerCallbackQuery(query.id, { text: '🚫 Account blocked', show_alert: true });
    }

    if (data === 'verify_channels') {
      const missing = await getMissingChannels(userId);
      if (missing.length > 0) {
        const { text, reply_markup } = channelGateMessage(missing);
        await bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown', reply_markup });
        return bot.answerCallbackQuery(query.id, { text: '❌ Still missing channel(s)' });
      }
      dbLayer.updateUser(userId, { channelsVerified: true });
      await bot.answerCallbackQuery(query.id, { text: '✅ Verified!' });
      return sendMainMenu(chatId, userId);
    }

    // Everything below requires channel gate to already be passed
    const missing = await getMissingChannels(userId);
    if (missing.length > 0) {
      const { text, reply_markup } = channelGateMessage(missing);
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup });
    }

    if (data.startsWith('menu:')) {
      await bot.answerCallbackQuery(query.id);
      return handleMenuAction(chatId, userId, data.split(':')[1]);
    }
    if (data.startsWith('cat:')) {
      await bot.answerCallbackQuery(query.id);
      return showProducts(chatId, data.split(':')[1]);
    }
    if (data.startsWith('prod:')) {
      await bot.answerCallbackQuery(query.id);
      return showProductDetail(chatId, userId, data.split(':')[1]);
    }
    if (data.startsWith('qty:')) {
      const [, productId, deltaStr] = data.split(':');
      await bot.answerCallbackQuery(query.id);
      return adjustQuantity(chatId, query.message.message_id, userId, productId, parseInt(deltaStr, 10));
    }
    if (data.startsWith('confirm:')) {
      await bot.answerCallbackQuery(query.id);
      return confirmPurchase(chatId, userId, data.split(':')[1]);
    }
    if (data.startsWith('checkorder:')) {
      await bot.answerCallbackQuery(query.id);
      return showOrderDetail(chatId, userId, data.split(':')[1]);
    }
    if (data === 'back_main') {
      await bot.answerCallbackQuery(query.id);
      return sendMainMenu(chatId, userId);
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('callback_query error:', err);
    try {
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Something went wrong, please try again.' });
    } catch (_) {}
  }
});

// ---------------------------------------------------------------------
// Main menu actions
// ---------------------------------------------------------------------
async function handleMenuAction(chatId, userId, action) {
  switch (action) {
    case 'buy':
      return showCategories(chatId);
    case 'profile':
      return showProfile(chatId, userId);
    case 'orders':
      return showOrders(chatId, userId);
    case 'rewards':
      return showRewards(chatId, userId);
    case 'reviews':
      return showReviews(chatId);
    case 'refer':
      return showReferral(chatId, userId);
    case 'channels':
      return showPublicChannels(chatId);
    case 'support':
      return showSupport(chatId);
    case 'stock':
      return showStock(chatId);
    case 'rank':
      return showRank(chatId, userId);
    case 'wallet':
      return showWallet(chatId, userId);
    default:
      return bot.sendMessage(chatId, '❓ Unknown option.');
  }
}

const backRow = [[{ text: '⬅️ Back', data: 'back_main' }]];

async function showCategories(chatId) {
  const categories = dbLayer.getActiveCategories();
  if (categories.length === 0) {
    return bot.sendMessage(chatId, '📦 No categories available right now. Please check back later.', {
      reply_markup: { inline_keyboard: inlineRows(backRow) },
    });
  }
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    rows.push(
      categories
        .slice(i, i + 2)
        .map(c => ({ text: `${c.emoji} ${c.name}`, data: `cat:${c.id}` }))
    );
  }
  rows.push(...backRow);
  await bot.sendMessage(chatId, '🛍 *Choose a category:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(rows) } });
}

async function showProducts(chatId, categoryId) {
  const products = dbLayer.getActiveProductsByCategory(categoryId);
  if (products.length === 0) {
    return bot.sendMessage(chatId, '📦 No products in this category yet.', { reply_markup: { inline_keyboard: inlineRows(backRow) } });
  }
  for (const p of products) {
    const stock = dbLayer.availableStockCount(p.id);
    const stockLine = stock > 0 ? `🟢 In Stock: ${stock}` : '🔴 Out of Stock';
    const priceLine = p.discountPrice ? `~₹${p.originalPrice}~ ➡️ *₹${p.discountPrice}*` : `*₹${p.price}*`;
    const text = `🎫 *${p.name}*\n${p.description}\n\n💰 ${priceLine}\n${stockLine}\n⏳ Validity: ${p.validity || 'N/A'}`;
    const rows = stock > 0
      ? [[{ text: '🛒 Buy Now', data: `prod:${p.id}` }, { text: 'ℹ️ Details', data: `prod:${p.id}` }]]
      : [[{ text: '🔴 Out of Stock', data: 'noop' }]];
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(rows) } });
  }
  await bot.sendMessage(chatId, '⬇️', { reply_markup: { inline_keyboard: inlineRows(backRow.map(r => r.map(b => ({ ...b, data: 'menu:buy' })))) } });
}

function unitPrice(p) {
  return p.discountPrice || p.price;
}

async function showProductDetail(chatId, userId, productId) {
  const p = dbLayer.getProduct(productId);
  if (!p) return bot.sendMessage(chatId, '❌ Product not found.');
  const s = session(userId);
  s.productId = productId;
  s.quantity = 1;
  return renderQuantityCard(chatId, null, userId, productId);
}

async function renderQuantityCard(chatId, messageId, userId, productId) {
  const p = dbLayer.getProduct(productId);
  const stock = dbLayer.availableStockCount(productId);
  const s = session(userId);
  s.quantity = Math.min(Math.max(1, s.quantity || 1), Math.max(stock, 1));
  const total = unitPrice(p) * s.quantity;

  const text =
    `🎫 *${p.name}*\n\n` +
    `Quantity: *${s.quantity}*\n` +
    `Unit Price: ₹${unitPrice(p)}\n` +
    `Total Amount: *₹${total}*\n\n` +
    `📦 Stock available: ${stock}\n` +
    `📃 Terms: ${p.terms || 'Standard terms apply'}`;

  const rows = [
    [
      { text: '➖', data: `qty:${productId}:-1` },
      { text: `${s.quantity}`, data: 'noop' },
      { text: '➕', data: `qty:${productId}:1` },
    ],
    [{ text: '✅ Proceed to Payment', data: `confirm:${productId}` }],
    [{ text: '⬅️ Back', data: 'menu:buy' }],
  ];

  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(rows) } };
  if (messageId) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
  }
  return bot.sendMessage(chatId, text, opts);
}

async function adjustQuantity(chatId, messageId, userId, productId, delta) {
  const s = session(userId);
  s.quantity = (s.quantity || 1) + delta;
  if (s.quantity < 1) s.quantity = 1;
  return renderQuantityCard(chatId, messageId, userId, productId);
}

async function confirmPurchase(chatId, userId, productId) {
  const s = session(userId);
  const qty = s.quantity || 1;
  const p = dbLayer.getProduct(productId);
  const stock = dbLayer.availableStockCount(productId);
  if (qty > stock) {
    return bot.sendMessage(chatId, '❌ Not enough stock for that quantity. Please reduce quantity.');
  }

  const { order, error } = dbLayer.createOrder({
    userId,
    productId,
    quantity: qty,
    unitPrice: unitPrice(p),
    paymentMethod: 'paytm',
  });
  if (error) {
    return bot.sendMessage(chatId, '❌ Unable to create order (out of stock). Please try again.');
  }
  dbLayer.createPaymentRecord(order.id, order.amount, userId);

  const payUrl = `${config.server.baseUrl}/pay/${order.id}`;
  const timeoutMin = dbLayer.db.get('settings.paymentTimeoutMinutes').value();
  const text =
    `🧾 *Order Created*\n\n` +
    `Order ID: \`${order.id}\`\n` +
    `Product: ${order.productName}\n` +
    `Quantity: ${order.quantity}\n` +
    `Amount: *₹${order.amount}*\n\n` +
    `⏳ Complete payment within *${timeoutMin} minutes* or this order will be auto-cancelled.`;

  const rows = [
    [{ text: '💳 Pay Now (Paytm)', url: payUrl }],
    [{ text: '📋 My Orders', data: 'menu:orders' }],
    [{ text: '⬅️ Main Menu', data: 'back_main' }],
  ];
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(rows) } });

  // Schedule an expiry check (belt-and-braces; server.js also runs a periodic sweep)
  setTimeout(() => {
    const current = dbLayer.getOrder(order.id);
    if (current && current.status === 'PAYMENT_PENDING' && Date.now() > current.expiresAt) {
      dbLayer.releaseVouchers(current.voucherIds);
      dbLayer.db.get('orders').find({ id: order.id }).assign({ status: 'CANCELLED' }).write();
      bot.sendMessage(chatId, `⌛ Order \`${order.id}\` expired without payment and has been cancelled.`, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }, timeoutMin * 60 * 1000 + 2000);
}

// ---------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------
async function showOrders(chatId, userId) {
  const orders = dbLayer.getUserOrders(userId, 10);
  if (orders.length === 0) {
    return bot.sendMessage(chatId, '📋 You have no orders yet.', { reply_markup: { inline_keyboard: inlineRows(backRow) } });
  }
  const rows = orders.map(o => [{ text: `${statusEmoji(o.status)} ${o.id} — ₹${o.amount}`, data: `checkorder:${o.id}` }]);
  rows.push(...backRow);
  await bot.sendMessage(chatId, '📋 *Your Recent Orders:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(rows) } });
}

function statusEmoji(status) {
  return { PAYMENT_PENDING: '🟡', PAID: '🟢', DELIVERED: '✅', FAILED: '🔴', CANCELLED: '⚪', REFUNDED: '🔵' }[status] || '⚪';
}

async function showOrderDetail(chatId, userId, orderId) {
  const o = dbLayer.getOrder(orderId);
  if (!o || o.userId !== userId) return bot.sendMessage(chatId, '❌ Order not found.');
  let text =
    `🧾 *Order ${o.id}*\n\n` +
    `Product: ${o.productName}\n` +
    `Quantity: ${o.quantity}\n` +
    `Amount: ₹${o.amount}\n` +
    `Status: ${statusEmoji(o.status)} ${o.status}\n` +
    `Created: ${new Date(o.createdAt).toLocaleString()}\n`;
  if (o.status === 'DELIVERED') {
    const codes = dbLayer.getVoucherCodesForOrder(o.id);
    text += `\n🎁 *Your Voucher Code(s):*\n${codes.map(c => `\`${c}\``).join('\n')}`;
  }
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(backRow.map(r => r.map(b => ({ ...b, data: 'menu:orders' })))) } });
}

// ---------------------------------------------------------------------
// Profile / Wallet / Rank / Rewards / Referral / Reviews / Support / Channels / Stock
// ---------------------------------------------------------------------
async function showProfile(chatId, userId) {
  const u = dbLayer.getUser(userId);
  const wallet = dbLayer.getWallet(userId);
  const text =
    `👤 *My Profile*\n\n` +
    `Name: ${u.firstName} ${u.lastName || ''}\n` +
    `Username: @${u.username || 'N/A'}\n` +
    `User ID: \`${u.id}\`\n` +
    `Joined: ${new Date(u.registeredAt).toLocaleDateString()}\n\n` +
    `🛒 Total Orders: ${u.totalPurchases}\n` +
    `💰 Total Spent: ₹${u.totalSpending}\n` +
    `💳 Wallet Balance: ₹${wallet.balance}`;
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(backRow) } });
}

async function showWallet(chatId, userId) {
  const wallet = dbLayer.getWallet(userId);
  const txs = dbLayer.db.get('walletTransactions').filter({ userId }).orderBy(['createdAt'], ['desc']).take(5).value();
  let text =
    `💰 *Wallet*\n\n` +
    `Balance: *₹${wallet.balance}*\n` +
    `Total Credited: ₹${wallet.totalCredited}\n` +
    `Total Spent: ₹${wallet.totalSpent}\n\n` +
    `📜 Recent Transactions:\n`;
  text += txs.length ? txs.map(t => `${t.type === 'DEBIT' ? '➖' : '➕'} ₹${t.amount} — ${t.note}`).join('\n') : 'No transactions yet.';
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(backRow) } });
}

async function showRank(chatId, userId) {
  const u = dbLayer.getUser(userId);
  const ranks = dbLayer.db.get('ranks').value();
  const current = ranks.find(r => r.id === u.rankId);
  const text =
    `🏆 *My Rank*\n\n` +
    `Current Rank: ${current ? current.name : 'Bronze'}\n` +
    `Total Orders: ${u.totalPurchases}\n` +
    `Total Spending: ₹${u.totalSpending}\n\n` +
    `📈 All Ranks:\n` +
    ranks.map(r => `${r.name} — min ₹${r.minSpend} / ${r.minOrders} orders`).join('\n');
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(backRow) } });
}

async function showRewards(chatId, userId) {
  const rewards = dbLayer.db.get('rewards').filter({ userId }).value();
  const total = rewards.reduce((s, r) => s + r.amount, 0);
  const text = `🎁 *My Rewards*\n\nTotal Earned: ₹${total}\nReferral Rewards: ${rewards.filter(r => r.type === 'referral').length}\n\nUse your wallet balance towards any purchase!`;
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(backRow) } });
}

async function showReferral(chatId, userId) {
  const botInfo = await bot.getMe();
  const link = `https://t.me/${botInfo.username}?start=${userId}`;
  const settings = dbLayer.db.get('settings').value();
  const referred = dbLayer.db.get('referrals').filter({ inviterId: userId }).value();
  const text =
    `🤝 *Refer & Earn*\n\n` +
    `Share your link, earn rewards when friends purchase!\n\n` +
    `🔗 ${link}\n\n` +
    `💵 Reward: ${settings.referralRewardType === 'percentage' ? settings.referralRewardValue + '%' : '₹' + settings.referralRewardValue} per qualifying purchase\n` +
    `👥 Total Referred: ${referred.length}\n` +
    `✅ Rewarded: ${referred.filter(r => r.rewardGranted).length}`;
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(backRow) } });
}

async function showReviews(chatId) {
  const reviews = dbLayer.db.get('reviews').filter({ status: 'approved' }).orderBy(['createdAt'], ['desc']).take(10).value();
  let text = '⭐ *Customer Reviews*\n\n';
  text += reviews.length ? reviews.map(r => `${'⭐'.repeat(r.rating)} ${r.text}`).join('\n\n') : 'No reviews yet. Be the first after your purchase!';
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(backRow) } });
}

async function showSupport(chatId) {
  const s = dbLayer.db.get('settings').value();
  const rows = [];
  if (s.supportUsername) rows.push([{ text: '💬 Chat with Support', url: `https://t.me/${s.supportUsername.replace('@', '')}` }]);
  if (s.supportGroup) rows.push([{ text: '👥 Support Group', url: s.supportGroup }]);
  rows.push(...backRow);
  await bot.sendMessage(chatId, s.supportMessage, { reply_markup: { inline_keyboard: inlineRows(rows) } });
}

async function showPublicChannels(chatId) {
  const channels = dbLayer.db.get('publicChannels').filter({ enabled: true }).value();
  if (channels.length === 0) return bot.sendMessage(chatId, '📢 No channels configured yet.', { reply_markup: { inline_keyboard: inlineRows(backRow) } });
  const rows = channels.map(c => [{ text: `📢 ${c.name}`, url: c.link }]);
  rows.push(...backRow);
  await bot.sendMessage(chatId, '📢 *Our Channels:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(rows) } });
}

async function showStock(chatId) {
  const categories = dbLayer.getActiveCategories();
  let text = '📊 *Stock Status*\n\n';
  categories.forEach(c => {
    const products = dbLayer.getActiveProductsByCategory(c.id);
    const total = products.reduce((s, p) => s + dbLayer.availableStockCount(p.id), 0);
    text += `${c.emoji} ${c.name}\n${total > 0 ? '🟢 Available: ' + total : '🔴 Out of Stock'}\n\n`;
  });
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(backRow) } });
}

// ---------------------------------------------------------------------
// Exported for server.js (called after real Paytm payment verification)
// ---------------------------------------------------------------------
async function deliverOrder(orderId) {
  const order = dbLayer.getOrder(orderId);
  if (!order || order.status !== 'PAID') return;
  const codes = dbLayer.getVoucherCodesForOrder(orderId);
  dbLayer.markOrderDelivered(orderId);

  const text =
    `🎉 *Payment Successful!*\n\n` +
    `📦 Product: ${order.productName}\n` +
    `🧾 Order ID: ${order.id}\n` +
    `💰 Paid: ₹${order.amount}\n\n` +
    `🎁 *Your Voucher:*\n${codes.map(c => `\`${c}\``).join('\n')}\n\n` +
    `Keep your code safe.`;
  const rows = [
    [{ text: '📋 My Orders', data: 'menu:orders' }, { text: '🛒 Buy More', data: 'menu:buy' }],
    [{ text: '🆘 Support', data: 'menu:support' }],
  ];
  await bot.sendMessage(order.userId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineRows(rows) } });

  notifyAdmins(`💰 New sale! Order ${order.id} — ₹${order.amount} — ${order.productName}`);
}

function notifyAdmins(text) {
  config.telegram.adminIds.forEach(adminId => {
    bot.sendMessage(adminId, `🔔 ${text}`).catch(() => {});
  });
}

// Periodic sweep for orders that expired while the process may have restarted
setInterval(() => {
  const expired = dbLayer.expireStaleOrders();
  expired.forEach(o => {
    bot.sendMessage(o.userId, `⌛ Order \`${o.id}\` expired without payment and has been cancelled.`, { parse_mode: 'Markdown' }).catch(() => {});
  });
}, 30 * 1000);

module.exports = { bot, deliverOrder, notifyAdmins };
