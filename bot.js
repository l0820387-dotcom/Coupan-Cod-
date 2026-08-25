/**
 * bot.js
 * -----------------------------------------------------------------------
 * All Telegram-facing logic. Started once by server.js (require('./bot')).
 *
 * UX rules used throughout this file:
 *  - Every screen is rendered through renderScreen(), which EDITS the
 *    user's current message instead of sending a new one wherever
 *    possible, so the chat doesn't fill up with old menu messages.
 *  - Every button uses Telegram's native `style` field (Bot API 9.4+,
 *    Feb 2026) for real green/blue/red backgrounds — no separate
 *    Mini App needed.
 * -----------------------------------------------------------------------
 */
const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const config = require('./config');
const dbLayer = require('./database');
const paytmApi = require('./paytm');

const bot = new TelegramBot(config.telegram.botToken, { polling: true });

// In-memory per-user state: which message we're currently editing, the
// product/quantity being built up, and whether we're waiting for a typed
// custom quantity. Safe because this is a single bot process.
const sessions = {};
function session(userId) {
  if (!sessions[userId]) sessions[userId] = {};
  return sessions[userId];
}

// ---------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------
function styleFor(color) {
  return { green: 'success', blue: 'primary', red: 'danger' }[color];
}

/** buttons: array of rows, each row an array of {text, data|url, color} */
function buildKeyboard(rows) {
  return rows.map(row =>
    row.map(b => {
      const base = b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data };
      const style = styleFor(b.color);
      return style ? { ...base, style } : base;
    })
  );
}

/**
 * Renders a screen by editing the user's last bot message when possible.
 * Falls back to sending a fresh message if there's nothing to edit yet,
 * the old message can no longer be edited (too old / deleted), or the
 * content is identical (Telegram's "message is not modified" — treated
 * as a harmless no-op instead of an error).
 */
async function renderScreen(chatId, userId, text, rows, { forceNew = false } = {}) {
  const s = session(userId);
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buildKeyboard(rows) } };

  if (!forceNew && s.lastMessageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: s.lastMessageId, ...opts });
      return;
    } catch (err) {
      const msg = String(err.message || '');
      if (msg.includes('message is not modified')) return; // harmless — already showing this
      // otherwise (message too old, deleted, etc.) fall through and send fresh
    }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  s.lastMessageId = sent.message_id;
}

// ---------------------------------------------------------------------
// Channel membership gate
// ---------------------------------------------------------------------
async function isMemberOfChannel(userId, channel) {
  const target = channel.chatId || channel.username;
  if (!target) return true; // misconfigured channel (no ID/username) — don't block users on it forever
  try {
    const member = await bot.getChatMember(target, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (e) {
    return false; // bot not admin in channel, or user hasn't joined
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

async function showChannelGate(chatId, userId, missing) {
  let text = '🔐 *One Last Step*\n\nJoin the channel(s) below to unlock the store:\n\n';
  missing.forEach((c, i) => {
    text += `${i + 1}. ${c.name}\n`;
  });
  text += "\nOnce you've joined all of them, tap *Verify Membership*.";
  const rows = missing.map(c => [{ text: `➡️ Join ${c.name}`, url: c.link, color: 'blue' }]);
  rows.push([{ text: '✅ Verify Membership', data: 'verify_channels', color: 'green' }]);
  await renderScreen(chatId, userId, text, rows);
}

// ---------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------
function mainMenuRows() {
  const settings = dbLayer.db.get('settings').value();
  const enabled = settings.buttons.filter(b => b.enabled);
  const grid = {};
  enabled.forEach(b => {
    grid[b.row] = grid[b.row] || [];
    grid[b.row][b.col - 1] = { text: b.label, data: `menu:${b.action}`, color: b.color || 'blue' };
  });
  return Object.keys(grid).sort((a, b) => a - b).map(r => grid[r].filter(Boolean));
}

async function sendMainMenu(chatId, userId) {
  const user = dbLayer.getUser(userId);
  const settings = dbLayer.db.get('settings').value();
  const text = settings.welcomeMessage.replace('{name}', user.firstName || 'there');
  await renderScreen(chatId, userId, text, mainMenuRows());
}

// ---------------------------------------------------------------------
// /start  ->  registration -> channel gate -> main menu
// ---------------------------------------------------------------------
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const referredBy = match && match[1] ? match[1].trim() : null;

  session(userId).lastMessageId = null; // /start always begins a fresh screen

  const settings = dbLayer.db.get('settings').value();
  if (settings.maintenanceMode && !config.telegram.adminIds.includes(userId)) {
    return bot.sendMessage(chatId, settings.maintenanceMessage);
  }

  const user = dbLayer.getOrCreateUser(msg.from, referredBy);
  if (user.blocked) {
    return bot.sendMessage(chatId, '🚫 Your account has been blocked. Contact support if you believe this is a mistake.');
  }

  const missing = await getMissingChannels(userId);
  if (missing.length > 0) return showChannelGate(chatId, userId, missing);
  await sendMainMenu(chatId, userId);
});

// ---------------------------------------------------------------------
// Plain text messages — only used to capture a typed custom quantity
// ---------------------------------------------------------------------
bot.on('message', async msg => {
  if (!msg.from || !msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const s = session(userId);
  if (!s.awaitingQtyFor) return; // not something we care about

  const productId = s.awaitingQtyFor;
  delete s.awaitingQtyFor;
  const stock = dbLayer.availableStockCount(productId);
  const qty = parseInt(msg.text.trim(), 10);

  // Delete the user's typed number so it doesn't clutter the chat either.
  bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  if (!Number.isInteger(qty) || qty < 1 || qty > stock) {
    const text =
      `❌ *Quantity Not Available*\n\n` +
      `You entered: ${msg.text.trim()}\n` +
      `📦 Available Stock: ${stock}\n` +
      `📏 Min: 1 | Max: ${stock || 'out of stock'}\n\n` +
      `Please choose a valid quantity.`;
    return renderScreen(chatId, userId, text, [[{ text: '✅ OK, Back', data: `prod:${productId}`, color: 'green' }]]);
  }
  s.quantity = qty;
  return showConfirmScreen(chatId, userId, productId);
});

// ---------------------------------------------------------------------
// Callback query router
// ---------------------------------------------------------------------
bot.on('callback_query', async query => {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const data = query.data;
  session(userId).lastMessageId = query.message.message_id; // keep our edit-target in sync

  try {
    const user = dbLayer.getUser(userId) || dbLayer.getOrCreateUser(query.from);
    if (user.blocked) {
      return bot.answerCallbackQuery(query.id, { text: '🚫 Account blocked', show_alert: true });
    }

    if (data === 'verify_channels') {
      const missing = await getMissingChannels(userId);
      await bot.answerCallbackQuery(query.id, missing.length ? { text: '❌ Still missing channel(s)' } : { text: '✅ Verified!' });
      if (missing.length > 0) return showChannelGate(chatId, userId, missing);
      dbLayer.updateUser(userId, { channelsVerified: true });
      return sendMainMenu(chatId, userId);
    }

    // Everything below requires the channel gate to already be passed
    const missing = await getMissingChannels(userId);
    if (missing.length > 0) {
      await bot.answerCallbackQuery(query.id);
      return showChannelGate(chatId, userId, missing);
    }

    if (data === 'noop') return bot.answerCallbackQuery(query.id);

    if (data.startsWith('menu:')) {
      await bot.answerCallbackQuery(query.id);
      return handleMenuAction(chatId, userId, data.split(':')[1]);
    }
    if (data.startsWith('cat:')) {
      await bot.answerCallbackQuery(query.id);
      return showProducts(chatId, userId, data.split(':')[1]);
    }
    if (data.startsWith('prod:')) {
      await bot.answerCallbackQuery(query.id);
      return showQuantityScreen(chatId, userId, data.split(':')[1]);
    }
    if (data.startsWith('pickqty:')) {
      const [, productId, qtyStr] = data.split(':');
      session(userId).quantity = parseInt(qtyStr, 10);
      await bot.answerCallbackQuery(query.id);
      return showConfirmScreen(chatId, userId, productId);
    }
    if (data.startsWith('customqty:')) {
      const productId = data.split(':')[1];
      session(userId).awaitingQtyFor = productId;
      const stock = dbLayer.availableStockCount(productId);
      await bot.answerCallbackQuery(query.id);
      return renderScreen(
        chatId, userId,
        `🔢 *Enter Quantity*\n\nMin: 1 | Max: ${stock}\n👇 Type the number and send it as a message:`,
        [[{ text: '⬅️ Back', data: `prod:${productId}`, color: 'blue' }]]
      );
    }
    if (data.startsWith('confirm:')) {
      await bot.answerCallbackQuery(query.id);
      return createOrderAndShowPayment(chatId, userId, data.split(':')[1]);
    }
    if (data.startsWith('walletpay:')) {
      await bot.answerCallbackQuery(query.id);
      return payWithWallet(chatId, userId, data.split(':')[1]);
    }
    if (data.startsWith('ihavepaid:')) {
      await bot.answerCallbackQuery(query.id, { text: '🔍 Checking with Paytm…' });
      return checkAndFinalize(chatId, userId, data.split(':')[1]);
    }
    if (data.startsWith('cancelorder:')) {
      await bot.answerCallbackQuery(query.id);
      return cancelPendingOrder(chatId, userId, data.split(':')[1]);
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
    case 'buy': return showCategories(chatId, userId);
    case 'profile': return showProfile(chatId, userId);
    case 'orders': return showOrders(chatId, userId);
    case 'rewards': return showRewards(chatId, userId);
    case 'reviews': return showReviews(chatId, userId);
    case 'refer': return showReferral(chatId, userId);
    case 'channels': return showPublicChannels(chatId, userId);
    case 'support': return showSupport(chatId, userId);
    case 'stock': return showStock(chatId, userId);
    case 'rank': return showRank(chatId, userId);
    case 'wallet': return showWallet(chatId, userId);
    default: return renderScreen(chatId, userId, '❓ Unknown option.', [[{ text: '🏠 Main Menu', data: 'back_main', color: 'blue' }]]);
  }
}

const homeRow = [{ text: '🏠 Main Menu', data: 'back_main', color: 'blue' }];

// ---------------------------------------------------------------------
// Buy flow
// ---------------------------------------------------------------------
async function showCategories(chatId, userId) {
  const categories = dbLayer.getActiveCategories();
  if (categories.length === 0) {
    return renderScreen(chatId, userId, '📦 No categories available right now. Please check back soon.', [homeRow]);
  }
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    rows.push(categories.slice(i, i + 2).map(c => ({ text: `${c.emoji} ${c.name}`, data: `cat:${c.id}`, color: 'blue' })));
  }
  rows.push(homeRow);
  await renderScreen(chatId, userId, '🛍 *Select a Category*', rows);
}

function unitPrice(p) {
  return p.discountPrice || p.price;
}

async function showProducts(chatId, userId, categoryId) {
  const category = dbLayer.db.get('categories').find({ id: categoryId }).value();
  const products = dbLayer.getActiveProductsByCategory(categoryId);
  if (products.length === 0) {
    return renderScreen(chatId, userId, `📦 No products in *${category ? category.name : 'this category'}* yet.`, [
      [{ text: '⬅️ Back to Categories', data: 'menu:buy', color: 'blue' }],
      homeRow,
    ]);
  }
  let text = `🛍 *${category ? category.emoji + ' ' + category.name : 'Products'}*\n\n`;
  const rows = [];
  products.forEach((p, i) => {
    const stock = dbLayer.availableStockCount(p.id);
    const price = unitPrice(p);
    text += `${i + 1}. ${p.name} | ₹${price} | ${stock > 0 ? '📦 ' + stock : '🔴 Out of Stock'}\n`;
    rows.push([{
      text: `${i + 1}. ${p.name}${stock > 0 ? ' — ₹' + price : ' (Out of Stock)'}`,
      data: stock > 0 ? `prod:${p.id}` : 'noop',
      color: stock > 0 ? 'green' : 'red',
    }]);
  });
  text += '\n👇 Tap a product to buy:';
  rows.push([{ text: '⬅️ Back to Categories', data: 'menu:buy', color: 'blue' }]);
  rows.push(homeRow);
  await renderScreen(chatId, userId, text, rows);
}

async function showQuantityScreen(chatId, userId, productId) {
  const p = dbLayer.getProduct(productId);
  if (!p) return renderScreen(chatId, userId, '❌ Product not found.', [homeRow]);
  const stock = dbLayer.availableStockCount(productId);
  const price = unitPrice(p);

  const text =
    `🎫 *${p.name}*\n${p.description || ''}\n\n` +
    `💰 Unit Price: ₹${price}\n` +
    `📦 Available Stock: ${stock}\n` +
    `⏳ Validity: ${p.validity || 'N/A'}\n\n` +
    `👇 Select Quantity:`;

  const presetCount = Math.min(9, stock);
  const rows = [];
  for (let i = 0; i < presetCount; i += 3) {
    const row = [];
    for (let n = i + 1; n <= Math.min(i + 3, presetCount); n++) {
      row.push({ text: `${n} • ₹${price * n}`, data: `pickqty:${productId}:${n}`, color: 'green' });
    }
    rows.push(row);
  }
  if (stock > 0) rows.push([{ text: '✏️ Custom Quantity', data: `customqty:${productId}`, color: 'green' }]);
  rows.push([{ text: '⬅️ Back', data: `cat:${p.categoryId}`, color: 'blue' }]);

  await renderScreen(chatId, userId, text, rows);
}

async function showConfirmScreen(chatId, userId, productId) {
  const p = dbLayer.getProduct(productId);
  const stock = dbLayer.availableStockCount(productId);
  const qty = session(userId).quantity || 1;
  if (qty > stock) {
    return renderScreen(chatId, userId, '❌ Not enough stock for that quantity anymore. Please pick a smaller quantity.', [
      [{ text: '⬅️ Back', data: `prod:${productId}`, color: 'blue' }],
    ]);
  }
  const total = unitPrice(p) * qty;
  const wallet = dbLayer.getWallet(userId);
  const text =
    `🧾 *Confirm Your Order*\n\n` +
    `📦 Product: ${p.name}\n` +
    `🔢 Quantity: ${qty}\n` +
    `💰 Total: ₹${total}\n` +
    `💳 Wallet Balance: ₹${wallet.balance}\n\n` +
    `📃 Terms: ${p.terms || 'Standard terms apply'}\n\n` +
    `How would you like to pay?`;
  const rows = [];
  if (wallet.balance >= total) {
    rows.push([{ text: `💳 Pay ₹${total} from Wallet`, data: `walletpay:${productId}`, color: 'green' }]);
  }
  rows.push([{ text: `📲 Pay ₹${total} via UPI/Paytm`, data: `confirm:${productId}`, color: 'green' }]);
  rows.push([{ text: '⬅️ Change Quantity', data: `prod:${productId}`, color: 'blue' }, { text: '❌ Cancel', data: 'menu:buy', color: 'red' }]);
  await renderScreen(chatId, userId, text, rows);
}

async function payWithWallet(chatId, userId, productId) {
  const qty = session(userId).quantity || 1;
  const p = dbLayer.getProduct(productId);
  const stock = dbLayer.availableStockCount(productId);
  if (qty > stock) {
    return renderScreen(chatId, userId, '❌ Not enough stock for that quantity. Please try a smaller quantity.', [[{ text: '⬅️ Back', data: `prod:${productId}`, color: 'blue' }]]);
  }
  const { order, error } = dbLayer.createOrder({ userId, productId, quantity: qty, unitPrice: unitPrice(p), paymentMethod: 'wallet' });
  if (error) return renderScreen(chatId, userId, '❌ Unable to create order (just went out of stock). Please try again.', [homeRow]);

  const result = dbLayer.payOrderFromWallet(order.id);
  if (result.error) {
    dbLayer.releaseVouchers(order.voucherIds);
    dbLayer.db.get('orders').find({ id: order.id }).assign({ status: 'CANCELLED' }).write();
    return renderScreen(chatId, userId, `❌ Wallet payment failed (${result.error}). Please try UPI/Paytm instead.`, [[{ text: '⬅️ Back', data: `prod:${productId}`, color: 'blue' }]]);
  }
  await finalizeSuccessfulPayment(order.id, `WALLET:${order.id}`, result);
}

async function createOrderAndShowPayment(chatId, userId, productId) {
  const qty = session(userId).quantity || 1;
  const p = dbLayer.getProduct(productId);
  const stock = dbLayer.availableStockCount(productId);
  if (qty > stock) {
    return renderScreen(chatId, userId, '❌ Not enough stock for that quantity. Please try a smaller quantity.', [
      [{ text: '⬅️ Back', data: `prod:${productId}`, color: 'blue' }],
    ]);
  }

  const { order, error } = dbLayer.createOrder({
    userId, productId, quantity: qty, unitPrice: unitPrice(p), paymentMethod: 'paytm',
  });
  if (error) {
    return renderScreen(chatId, userId, '❌ Unable to create order (just went out of stock). Please try again.', [homeRow]);
  }
  dbLayer.createPaymentRecord(order.id, order.amount, userId);

  const timeoutMin = dbLayer.db.get('settings.paymentTimeoutMinutes').value();
  const payUrl = `${config.server.baseUrl}/pay/${order.id}`;
  const caption =
    `💳 *Payment Required*\n\n` +
    `📦 Item: ${order.productName} · Qty: ${order.quantity}\n` +
    `💰 Total: ₹${order.amount}\n` +
    `🆔 Order: \`${order.id}\`\n\n` +
    `⚡ Payment is verified automatically — tap *I Have Paid* after scanning/paying.\n` +
    `⏳ This order expires in *${timeoutMin} minutes*.`;
  const rows = [
    [{ text: '✅ I Have Paid', data: `ihavepaid:${order.id}`, color: 'green' }],
    [{ text: '❌ Cancel', data: `cancelorder:${order.id}`, color: 'red' }],
  ];

  try {
    const txnToken = await paytmApi.initiateTransaction(order);
    const upiPayload = txnToken ? await paytmApi.getUpiIntent(order, txnToken) : null;
    if (upiPayload) {
      const qrBuffer = await QRCode.toBuffer(upiPayload, { width: 500, margin: 1 });
      await bot.sendPhoto(chatId, qrBuffer, { caption, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buildKeyboard(rows) } });
      session(userId).lastMessageId = null; // next screen should send fresh, not edit a photo message
      scheduleExpiryNotice(chatId, order.id, timeoutMin);
      return;
    }
  } catch (err) {
    console.error('UPI QR generation failed, falling back to payment link:', err.message);
  }

  // Fallback: no QR available for this MID/product — send the browser checkout link instead.
  const fallbackText = caption + `\n\n🔗 Or pay via the secure link below:`;
  const fallbackRows = [[{ text: `✅ Pay ₹${order.amount} Now`, url: payUrl, color: 'green' }], ...rows];
  await renderScreen(chatId, userId, fallbackText, fallbackRows);
  scheduleExpiryNotice(chatId, order.id, timeoutMin);
}

function scheduleExpiryNotice(chatId, orderId, timeoutMin) {
  setTimeout(() => {
    const current = dbLayer.getOrder(orderId);
    if (current && current.status === 'PAYMENT_PENDING' && Date.now() > current.expiresAt) {
      dbLayer.releaseVouchers(current.voucherIds);
      dbLayer.db.get('orders').find({ id: orderId }).assign({ status: 'CANCELLED' }).write();
      bot.sendMessage(chatId, `⌛ Order \`${orderId}\` expired without payment and was cancelled — the voucher has been released.`, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }, timeoutMin * 60 * 1000 + 2000);
}

async function cancelPendingOrder(chatId, userId, orderId) {
  const order = dbLayer.getOrder(orderId);
  if (!order || order.userId !== userId || order.status !== 'PAYMENT_PENDING') {
    return renderScreen(chatId, userId, 'This order can no longer be cancelled.', [homeRow]);
  }
  dbLayer.releaseVouchers(order.voucherIds);
  dbLayer.db.get('orders').find({ id: orderId }).assign({ status: 'CANCELLED' }).write();
  session(userId).lastMessageId = null;
  await bot.sendMessage(chatId, `❌ Order \`${orderId}\` cancelled. The voucher has been released back to stock.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buildKeyboard([homeRow]) } });
}

/** Called when the user taps "I Have Paid" — re-checks directly with Paytm, never trusts the tap alone. */
async function checkAndFinalize(chatId, userId, orderId) {
  const order = dbLayer.getOrder(orderId);
  if (!order || order.userId !== userId) return;
  if (order.status !== 'PAYMENT_PENDING') {
    if (order.status === 'DELIVERED') return; // already handled, nothing to do
    return bot.sendMessage(chatId, `This order is currently *${order.status}*.`, { parse_mode: 'Markdown' });
  }
  try {
    const result = await paytmApi.checkStatus(orderId);
    const amountMatches = result && Math.abs(parseFloat(result.txnAmount) - order.amount) < 0.01;
    const txnRefFresh = result?.txnId && !dbLayer.isTxnRefUsed(result.txnId);
    if (result?.resultInfo?.resultStatus === 'TXN_SUCCESS' && amountMatches && txnRefFresh) {
      dbLayer.finalizePayment(orderId, { status: 'TXN_SUCCESS', txnRef: result.txnId, raw: result });
      const completion = dbLayer.completeOrderPayment(orderId, result.txnId);
      return finalizeSuccessfulPayment(orderId, result.txnId, completion);
    }
  } catch (err) {
    console.error('checkAndFinalize error:', err.message);
  }
  await bot.sendMessage(chatId, "⏳ Payment not confirmed yet. If you've just paid, please wait a few seconds and tap *I Have Paid* again.", { parse_mode: 'Markdown' });
}



// ---------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------
function statusEmoji(status) {
  return { PAYMENT_PENDING: '🟡', PAID: '🟢', DELIVERED: '✅', FAILED: '🔴', CANCELLED: '⚪', REFUNDED: '🔵' }[status] || '⚪';
}

async function showOrders(chatId, userId) {
  const orders = dbLayer.getUserOrders(userId, 10);
  if (orders.length === 0) {
    return renderScreen(chatId, userId, '📋 You have no orders yet.', [homeRow]);
  }
  const rows = orders.map(o => [{ text: `${statusEmoji(o.status)} ${o.id} — ₹${o.amount}`, data: `checkorder:${o.id}`, color: 'blue' }]);
  rows.push(homeRow);
  await renderScreen(chatId, userId, '📋 *Your Recent Orders*', rows);
}

async function showOrderDetail(chatId, userId, orderId) {
  const o = dbLayer.getOrder(orderId);
  if (!o || o.userId !== userId) return renderScreen(chatId, userId, '❌ Order not found.', [homeRow]);
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
  await renderScreen(chatId, userId, text, [[{ text: '⬅️ Back to Orders', data: 'menu:orders', color: 'blue' }], homeRow]);
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
  await renderScreen(chatId, userId, text, [homeRow]);
}

async function showWallet(chatId, userId) {
  const wallet = dbLayer.getWallet(userId);
  const txs = dbLayer.db.get('walletTransactions').filter({ userId }).orderBy(['createdAt'], ['desc']).take(5).value();
  let text =
    `💰 *My Wallet*\n\n` +
    `Available Balance: ₹${wallet.balance}\n` +
    `Total Credited: ₹${wallet.totalCredited}\n` +
    `Total Spent: ₹${wallet.totalSpent}\n\n` +
    `📜 Recent Transactions:\n`;
  text += txs.length ? txs.map(t => `${t.type === 'DEBIT' ? '➖' : '➕'} ₹${t.amount} — ${t.note}`).join('\n') : 'No transactions yet.';
  await renderScreen(chatId, userId, text, [homeRow]);
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
  await renderScreen(chatId, userId, text, [homeRow]);
}

async function showRewards(chatId, userId) {
  const rewards = dbLayer.db.get('rewards').filter({ userId }).value();
  const total = rewards.reduce((s, r) => s + r.amount, 0);
  const text = `🎁 *My Rewards*\n\nTotal Earned: ₹${total}\nReferral Rewards: ${rewards.filter(r => r.type === 'referral').length}\n\nRewards are added straight to your wallet and can be used on any purchase.`;
  await renderScreen(chatId, userId, text, [homeRow]);
}

async function showReferral(chatId, userId) {
  const botInfo = await bot.getMe();
  const link = `https://t.me/${botInfo.username}?start=${userId}`;
  const settings = dbLayer.db.get('settings').value();
  const referred = dbLayer.db.get('referrals').filter({ inviterId: userId }).value();
  const text =
    `🤝 *Refer & Earn*\n\n` +
    `Share your link — earn rewards every time a friend makes a purchase!\n\n` +
    `🔗 ${link}\n\n` +
    `💵 Reward: ${settings.referralRewardType === 'percentage' ? settings.referralRewardValue + '%' : '₹' + settings.referralRewardValue} per qualifying purchase\n` +
    `👥 Total Referred: ${referred.length}\n` +
    `✅ Rewarded: ${referred.filter(r => r.rewardGranted).length}`;
  await renderScreen(chatId, userId, text, [homeRow]);
}

async function showReviews(chatId, userId) {
  const reviews = dbLayer.db.get('reviews').filter({ status: 'approved' }).orderBy(['createdAt'], ['desc']).take(10).value();
  let text = '⭐ *Customer Reviews*\n\n';
  text += reviews.length ? reviews.map(r => `${'⭐'.repeat(r.rating)} ${r.text}`).join('\n\n') : 'No reviews yet — be the first to share yours after your next purchase!';
  await renderScreen(chatId, userId, text, [homeRow]);
}

async function showSupport(chatId, userId) {
  const s = dbLayer.db.get('settings').value();
  const rows = [];
  if (s.supportUsername) rows.push([{ text: '✈️ Telegram Support', url: `https://t.me/${s.supportUsername.replace('@', '')}`, color: 'blue' }]);
  if (s.supportWhatsapp) rows.push([{ text: '💬 WhatsApp Support', url: `https://wa.me/${s.supportWhatsapp.replace(/\D/g, '')}`, color: 'green' }]);
  if (s.supportGroup) rows.push([{ text: '👥 Support Group', url: s.supportGroup, color: 'blue' }]);
  rows.push(homeRow);
  await renderScreen(chatId, userId, s.supportMessage, rows);
}

async function showPublicChannels(chatId, userId) {
  const channels = dbLayer.db.get('publicChannels').filter({ enabled: true }).value();
  if (channels.length === 0) return renderScreen(chatId, userId, '📢 No channels configured yet.', [homeRow]);
  const rows = channels.map(c => [{ text: `📢 ${c.name}`, url: c.link, color: 'blue' }]);
  rows.push(homeRow);
  await renderScreen(chatId, userId, '📢 *Our Channels*', rows);
}

async function showStock(chatId, userId) {
  const categories = dbLayer.getActiveCategories();
  let text = '📊 *Stock Status*\n\n';
  categories.forEach(c => {
    const products = dbLayer.getActiveProductsByCategory(c.id);
    const total = products.reduce((s, p) => s + dbLayer.availableStockCount(p.id), 0);
    text += `${c.emoji} ${c.name}\n${total > 0 ? '🟢 Available: ' + total : '🔴 Out of Stock'}\n\n`;
  });
  await renderScreen(chatId, userId, text, [homeRow]);
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
    `Keep your code safe — thank you for shopping with us!`;
  const rows = [
    [{ text: '📋 My Orders', data: 'menu:orders', color: 'blue' }, { text: '🛒 Buy More', data: 'menu:buy', color: 'green' }],
    [{ text: '🆘 Support', data: 'menu:support', color: 'blue' }],
  ];
  // This is a genuinely new event (not a menu navigation), so it's always a fresh message.
  const sent = await bot.sendMessage(order.userId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buildKeyboard(rows) } });
  session(order.userId).lastMessageId = sent.message_id;

  notifyAdmins(`💰 New sale! Order ${order.id} — ₹${order.amount} — ${order.productName}`);
}

/** Single entry point used by the webhook, the wallet-pay flow, and the "I Have Paid"
 * check — delivers the voucher and, if this purchase unlocked a referral bonus, notifies
 * the inviter too. `completion` is whatever dbLayer.completeOrderPayment() returned. */
async function finalizeSuccessfulPayment(orderId, txnRef, completion) {
  if (!completion || completion.error) return;
  await deliverOrder(orderId);
  if (completion.referralUnlock) {
    const { inviterId, code, requiredRefers } = completion.referralUnlock;
    bot.sendMessage(
      inviterId,
      `🎉 *Bonus Unlocked!*\n\nYou've referred ${requiredRefers} paying customers — here's a coupon just for you:\n\n\`${code}\`\n\nUse it on your next order. Keep sharing your link to unlock more! 🤝`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

function notifyAdmins(text) {
  config.telegram.adminIds.forEach(adminId => {
    bot.sendMessage(adminId, `🔔 ${text}`).catch(() => {});
  });
}

// ---------------------------------------------------------------------
// /admin — lightweight in-Telegram dashboard for authorized admins only
// ---------------------------------------------------------------------
bot.onText(/\/admin/, async msg => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  if (!config.telegram.adminIds.includes(userId)) return; // silently ignore for non-admins

  const d = dbLayer.getDashboardStats();
  const text =
    `🛠 *Admin Dashboard*\n\n` +
    `👥 Users: ${d.totalUsers} (${d.activeUsers} active)\n` +
    `🧾 Orders: ${d.totalOrders} (${d.todayOrders} today)\n` +
    `💰 Revenue: ₹${d.totalRevenue} (₹${d.todayRevenue} today)\n` +
    `🟡 Pending Payments: ${d.pendingPayments}\n` +
    `🟢 Successful: ${d.successfulPayments} · 🔴 Failed: ${d.failedPayments}\n` +
    `📦 Stock Available: ${d.totalStock} · ✅ Sold: ${d.soldVouchers}\n` +
    `⚠️ Low Stock Products: ${d.lowStockProducts}\n\n` +
    `Open the full panel for products, vouchers, users, broadcast and settings:`;
  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buildKeyboard([[{ text: '🖥 Open Full Admin Panel', url: `${config.server.baseUrl}/admin/admin.html`, color: 'blue' }]]) },
  });
});

// Periodic sweep for orders that expired while the process may have restarted
setInterval(() => {
  const expired = dbLayer.expireStaleOrders();
  expired.forEach(o => {
    bot.sendMessage(o.userId, `⌛ Order \`${o.id}\` expired without payment and was cancelled — the voucher has been released.`, { parse_mode: 'Markdown' }).catch(() => {});
  });
}, 30 * 1000);

module.exports = { bot, deliverOrder, finalizeSuccessfulPayment, notifyAdmins };
