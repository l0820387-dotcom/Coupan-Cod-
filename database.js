/**
 * database.js
 * -----------------------------------------------------------------------
 * Local file-based database (lowdb -> db.json on disk). No external DB
 * server required. Every collection from the spec lives here as an array
 * inside one JSON file, with helper functions that implement the actual
 * business rules (atomic-enough voucher reservation, wallet transactions,
 * order lifecycle, referrals, ranks, etc).
 *
 * NOTE ON "ATOMICITY": Node.js is single-threaded and lowdb writes are
 * synchronous, so as long as you only run ONE bot process against this
 * db.json file, the reserve/allocate operations below are safe from race
 * conditions. If you ever scale to multiple processes, swap this file for
 * a real database (Postgres/Mongo) with transactions - the function
 * signatures below are designed so that swap only touches this file.
 * -----------------------------------------------------------------------
 */
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);

const DEFAULTS = {
  users: [],
  categories: [],
  products: [],
  vouchers: [],
  orders: [],
  payments: [],
  wallets: [],              // { userId, balance, totalCredited, totalSpent }
  walletTransactions: [],
  referrals: [],
  rewards: [],
  ranks: [
    { id: 'bronze', name: '🥉 Bronze', minSpend: 0, minOrders: 0 },
    { id: 'silver', name: '🥈 Silver', minSpend: 1000, minOrders: 5 },
    { id: 'gold', name: '🥇 Gold', minSpend: 5000, minOrders: 20 },
    { id: 'diamond', name: '💎 Diamond', minSpend: 20000, minOrders: 50 },
  ],
  reviews: [],
  requiredChannels: [],
  publicChannels: [],
  promoCodes: [],
  offers: [],
  resellers: [],
  adminLogs: [],
  broadcasts: [],
  notifications: [],
  settings: {
    paymentTimeoutMinutes: 7,
    maintenanceMode: false,
    maintenanceMessage: '🛠 We\'re doing some quick maintenance and will be back shortly. Thanks for your patience!',
    referralEnabled: true,
    referralRewardType: 'fixed', // fixed | percentage
    referralRewardValue: 10,
    referralMinPurchase: 0,
    referralMaxReward: 500,
    // Refer-to-unlock: after N successful (paid) referrals, the inviter automatically
    // receives this promo code as a one-time bonus.
    referralUnlockEnabled: false,
    referralUnlockRequiredRefers: 5,
    referralUnlockPromoCode: '',
    welcomeMessage:
      "👋 Welcome, {name}!\n\nGlad to have you here 🛍\nBrowse verified vouchers, pay securely, and get your code instantly.\n\n👇 Tap a button below to get started:",
    supportUsername: '',
    supportWhatsapp: '', // digits only with country code, e.g. 919876543210
    supportGroup: '',
    supportChannel: '',
    supportMessage: "🆘 *Need a hand?* We're happy to help — pick whichever works best for you:",
    // "color" sets each button's real Telegram background color (Bot API 9.4+, Feb 2026):
    // green -> success, blue -> primary. No Mini App or extra file needed for this.
    buttons: [
      { id: 'buy', label: '⚡ Buy Vouchers', action: 'buy', row: 1, col: 1, enabled: true, color: 'green' },
      { id: 'profile', label: '👤 Profile', action: 'profile', row: 2, col: 1, enabled: true, color: 'blue' },
      { id: 'orders', label: '📋 My Orders', action: 'orders', row: 2, col: 2, enabled: true, color: 'blue' },
      { id: 'rewards', label: '🎁 My Rewards', action: 'rewards', row: 3, col: 1, enabled: true, color: 'green' },
      { id: 'reviews', label: '⭐ Reviews', action: 'reviews', row: 4, col: 1, enabled: true, color: 'blue' },
      { id: 'refer', label: '🤝 Refer & Earn', action: 'refer', row: 4, col: 2, enabled: true, color: 'green' },
      { id: 'channels', label: '📢 Channels', action: 'channels', row: 5, col: 1, enabled: true, color: 'blue' },
      { id: 'support', label: '🆘 Support', action: 'support', row: 5, col: 2, enabled: true, color: 'blue' },
      { id: 'stock', label: '📊 Stock Status', row: 6, col: 1, action: 'stock', enabled: true, color: 'blue' },
      { id: 'buynow', label: '🛒 Buy Now', action: 'buy', row: 6, col: 2, enabled: false, color: 'green' },
      { id: 'rank', label: '🏆 My Rank', action: 'rank', row: 7, col: 1, enabled: true, color: 'green' },
      { id: 'wallet', label: '💰 Wallet', action: 'wallet', row: 7, col: 2, enabled: true, color: 'green' },
    ],
  },
};

db.defaults(DEFAULTS).write();

// ---------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------
function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}${uuidv4().split('-')[0]}`;
}

function log(action, actor, target, result, extra = {}) {
  db.get('adminLogs')
    .push({ id: id('log'), action, actor, target, result, extra, timestamp: Date.now() })
    .write();
}

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------
function getOrCreateUser(tgUser, referredBy = null) {
  const uid = String(tgUser.id);
  let user = db.get('users').find({ id: uid }).value();
  if (user) {
    db.get('users').find({ id: uid }).assign({ lastActivity: Date.now() }).write();
    return user;
  }
  user = {
    id: uid,
    username: tgUser.username || '',
    firstName: tgUser.first_name || '',
    lastName: tgUser.last_name || '',
    registeredAt: Date.now(),
    lastActivity: Date.now(),
    referralCode: uid,
    referredBy: referredBy || null,
    totalPurchases: 0,
    totalSpending: 0,
    rankId: 'bronze',
    isReseller: false,
    resellerStatus: null, // pending | approved | rejected | blocked
    blocked: false,
    channelsVerified: false,
  };
  db.get('users').push(user).write();
  db.get('wallets').push({ userId: uid, balance: 0, totalCredited: 0, totalSpent: 0 }).write();
  if (referredBy && referredBy !== uid) {
    db.get('referrals')
      .push({
        id: id('ref'),
        inviterId: referredBy,
        newUserId: uid,
        registeredAt: Date.now(),
        qualifyingOrderId: null,
        rewardGranted: false,
      })
      .write();
  }
  log('user_register', uid, uid, 'success');
  return user;
}

function getUser(userId) {
  return db.get('users').find({ id: String(userId) }).value();
}

function updateUser(userId, patch) {
  return db.get('users').find({ id: String(userId) }).assign(patch).write();
}

function setUserBlocked(userId, blocked, actorAdminId) {
  updateUser(userId, { blocked });
  log('block_toggle', actorAdminId, userId, blocked ? 'blocked' : 'unblocked');
}

function recalcRank(userId) {
  const user = getUser(userId);
  if (!user) return;
  const ranks = db.get('ranks').value().slice().sort((a, b) => b.minSpend - a.minSpend);
  const eligible = ranks.find(
    r => user.totalSpending >= r.minSpend && user.totalPurchases >= r.minOrders
  );
  if (eligible && eligible.id !== user.rankId) {
    updateUser(userId, { rankId: eligible.id });
  }
}

// ---------------------------------------------------------------------
// Required channels (mandatory join-gate)
// ---------------------------------------------------------------------
function getActiveRequiredChannels() {
  return db.get('requiredChannels').filter({ enabled: true }).sortBy('order').value();
}

// ---------------------------------------------------------------------
// Categories / Products
// ---------------------------------------------------------------------
function getActiveCategories() {
  return db.get('categories').filter({ enabled: true }).sortBy('position').value();
}

function getActiveProductsByCategory(categoryId) {
  return db
    .get('products')
    .filter(p => p.categoryId === categoryId && p.enabled)
    .sortBy('position')
    .value();
}

function getProduct(productId) {
  return db.get('products').find({ id: productId }).value();
}

function availableStockCount(productId) {
  return db.get('vouchers').filter({ productId, status: 'AVAILABLE' }).size().value();
}

// ---------------------------------------------------------------------
// Voucher inventory
// ---------------------------------------------------------------------
function addVoucherCodes(productId, codes) {
  const existing = new Set(db.get('vouchers').filter({ productId }).map('code').value());
  let added = 0,
    duplicates = 0;
  codes.forEach(code => {
    const clean = code.trim();
    if (!clean) return;
    if (existing.has(clean)) {
      duplicates++;
      return;
    }
    db.get('vouchers')
      .push({ id: id('vch'), productId, code: clean, status: 'AVAILABLE', createdAt: Date.now() })
      .write();
    existing.add(clean);
    added++;
  });
  return { added, duplicates };
}

/** Reserve N available codes for an order. Returns array of voucher ids, or null if insufficient stock. */
function reserveVouchers(productId, qty, orderId) {
  const available = db.get('vouchers').filter({ productId, status: 'AVAILABLE' }).take(qty).value();
  if (available.length < qty) return null;
  const ids = available.map(v => v.id);
  ids.forEach(vid => {
    db.get('vouchers').find({ id: vid }).assign({ status: 'RESERVED', reservedForOrder: orderId }).write();
  });
  return ids;
}

function releaseVouchers(voucherIds) {
  voucherIds.forEach(vid => {
    db.get('vouchers')
      .find({ id: vid })
      .assign({ status: 'AVAILABLE', reservedForOrder: null })
      .write();
  });
}

function markVouchersSold(voucherIds, orderId) {
  voucherIds.forEach(vid => {
    db.get('vouchers')
      .find({ id: vid })
      .assign({ status: 'SOLD', soldForOrder: orderId, soldAt: Date.now() })
      .write();
  });
}

// ---------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------
function createOrder({ userId, productId, quantity, unitPrice, discount = 0, promoCode = null, paymentMethod }) {
  const product = getProduct(productId);
  const amount = Math.max(0, unitPrice * quantity - discount);
  const orderId = id('ORD');
  const timeoutMin = db.get('settings.paymentTimeoutMinutes').value();
  const voucherIds = reserveVouchers(productId, quantity, orderId);
  if (!voucherIds) return { error: 'OUT_OF_STOCK' };

  const order = {
    id: orderId,
    userId,
    productId,
    productName: product.name,
    quantity,
    unitPrice,
    discount,
    promoCode,
    amount,
    paymentMethod, // 'paytm' | 'wallet'
    status: 'PAYMENT_PENDING',
    voucherIds,
    txnRef: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + timeoutMin * 60 * 1000,
    paidAt: null,
    deliveredAt: null,
  };
  db.get('orders').push(order).write();
  return { order };
}

function getOrder(orderId) {
  return db.get('orders').find({ id: orderId }).value();
}

function getUserOrders(userId, limit = 20) {
  return db.get('orders').filter({ userId }).orderBy(['createdAt'], ['desc']).take(limit).value();
}

function expireStaleOrders() {
  const now = Date.now();
  const stale = db
    .get('orders')
    .filter(o => o.status === 'PAYMENT_PENDING' && o.expiresAt < now)
    .value();
  stale.forEach(o => {
    releaseVouchers(o.voucherIds);
    db.get('orders').find({ id: o.id }).assign({ status: 'CANCELLED' }).write();
    log('order_expire', 'system', o.id, 'cancelled');
  });
  return stale;
}

/** Marks order PAID after real payment verification, allocates vouchers, updates stats. Idempotent. */
function completeOrderPayment(orderId, txnRef) {
  const order = getOrder(orderId);
  if (!order) return { error: 'ORDER_NOT_FOUND' };
  if (order.status === 'DELIVERED' || order.status === 'PAID') {
    return { error: 'ALREADY_PROCESSED', order }; // idempotency guard
  }
  if (order.status !== 'PAYMENT_PENDING') {
    return { error: `INVALID_STATE_${order.status}` };
  }
  markVouchersSold(order.voucherIds, orderId);
  db.get('orders')
    .find({ id: orderId })
    .assign({ status: 'PAID', paidAt: Date.now(), txnRef })
    .write();

  const user = getUser(order.userId);
  updateUser(order.userId, {
    totalPurchases: (user.totalPurchases || 0) + order.quantity,
    totalSpending: (user.totalSpending || 0) + order.amount,
  });
  recalcRank(order.userId);
  const referralUnlock = grantReferralRewardIfEligible(order.userId, order);

  return { order: getOrder(orderId), referralUnlock };
}

/** Debits the buyer's wallet and completes the order in one atomic-enough step. */
function payOrderFromWallet(orderId) {
  const order = getOrder(orderId);
  if (!order) return { error: 'ORDER_NOT_FOUND' };
  if (order.status !== 'PAYMENT_PENDING') return { error: `INVALID_STATE_${order.status}` };
  const wallet = getWallet(order.userId);
  if (!wallet || wallet.balance < order.amount) return { error: 'INSUFFICIENT_BALANCE' };

  const debit = walletTransaction(order.userId, 'DEBIT', order.amount, `Order ${order.id} — ${order.productName}`, order.id);
  if (debit.error) return { error: debit.error };

  return completeOrderPayment(orderId, `WALLET:${order.id}`);
}

function markOrderDelivered(orderId) {
  db.get('orders').find({ id: orderId }).assign({ status: 'DELIVERED', deliveredAt: Date.now() }).write();
}

function getVoucherCodesForOrder(orderId) {
  return db.get('vouchers').filter({ soldForOrder: orderId }).map('code').value();
}

// ---------------------------------------------------------------------
// Payments (Paytm transaction bookkeeping)
// ---------------------------------------------------------------------
function createPaymentRecord(orderId, amount, userId) {
  const payment = {
    id: id('PAY'),
    orderId,
    userId,
    expectedAmount: amount,
    status: 'PENDING',
    txnRef: null,
    createdAt: Date.now(),
    verifiedAt: null,
    raw: null,
  };
  db.get('payments').push(payment).write();
  return payment;
}

function isTxnRefUsed(txnRef) {
  return !!db.get('payments').find({ txnRef, status: 'SUCCESS' }).value();
}

function finalizePayment(orderId, { status, txnRef, raw }) {
  db.get('payments')
    .find({ orderId })
    .assign({ status, txnRef, raw, verifiedAt: Date.now() })
    .write();
}

// ---------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------
function getWallet(userId) {
  return db.get('wallets').find({ userId: String(userId) }).value();
}

function walletTransaction(userId, type, amount, note = '', refId = null) {
  const wallet = getWallet(userId);
  if (!wallet) return { error: 'NO_WALLET' };
  if ((type === 'DEBIT') && wallet.balance < amount) return { error: 'INSUFFICIENT_BALANCE' };

  const delta = type === 'DEBIT' ? -amount : amount;
  const newBalance = wallet.balance + delta;
  db.get('wallets')
    .find({ userId: String(userId) })
    .assign({
      balance: newBalance,
      totalCredited: wallet.totalCredited + (delta > 0 ? amount : 0),
      totalSpent: wallet.totalSpent + (type === 'DEBIT' ? amount : 0),
    })
    .write();

  const tx = {
    id: id('wtx'),
    userId,
    type, // CREDIT | DEBIT | REFUND | REWARD | ADMIN_ADJUSTMENT
    amount,
    note,
    refId,
    balanceAfter: newBalance,
    createdAt: Date.now(),
  };
  db.get('walletTransactions').push(tx).write();
  return { tx };
}

// ---------------------------------------------------------------------
// Referrals & Rewards
// ---------------------------------------------------------------------
function grantReferralRewardIfEligible(buyerUserId, order) {
  const settings = db.get('settings').value();
  if (!settings.referralEnabled) return null;
  const referral = db
    .get('referrals')
    .find({ newUserId: buyerUserId, rewardGranted: false })
    .value();
  if (!referral) return null;
  if (order.amount < settings.referralMinPurchase) return null;

  let reward =
    settings.referralRewardType === 'percentage'
      ? (order.amount * settings.referralRewardValue) / 100
      : settings.referralRewardValue;
  reward = Math.min(reward, settings.referralMaxReward);

  walletTransaction(referral.inviterId, 'REWARD', reward, `Referral reward for inviting ${buyerUserId}`, order.id);
  db.get('referrals')
    .find({ id: referral.id })
    .assign({ rewardGranted: true, qualifyingOrderId: order.id })
    .write();
  db.get('rewards')
    .push({
      id: id('rwd'),
      userId: referral.inviterId,
      type: 'referral',
      amount: reward,
      relatedOrderId: order.id,
      createdAt: Date.now(),
    })
    .write();

  return checkReferralUnlock(referral.inviterId);
}

/** Refer-to-unlock: once an inviter reaches the configured number of successful
 * (paid) referrals, grant them the configured promo code exactly once. */
function checkReferralUnlock(inviterId) {
  const settings = db.get('settings').value();
  if (!settings.referralUnlockEnabled || !settings.referralUnlockPromoCode) return null;
  const inviter = getUser(inviterId);
  if (!inviter || inviter.referralUnlockGranted) return null;

  const successfulRefers = db.get('referrals').filter({ inviterId, rewardGranted: true }).size().value();
  if (successfulRefers < settings.referralUnlockRequiredRefers) return null;

  updateUser(inviterId, { referralUnlockGranted: true });
  return { inviterId, code: settings.referralUnlockPromoCode, requiredRefers: settings.referralUnlockRequiredRefers };
}

// ---------------------------------------------------------------------
// Promo codes
// ---------------------------------------------------------------------
function validatePromoCode(code, userId, orderAmount) {
  const promo = db.get('promoCodes').find({ code, active: true }).value();
  if (!promo) return { error: 'INVALID_CODE' };
  const now = Date.now();
  if (promo.startDate && now < promo.startDate) return { error: 'NOT_STARTED' };
  if (promo.expiryDate && now > promo.expiryDate) return { error: 'EXPIRED' };
  if (orderAmount < (promo.minOrder || 0)) return { error: 'MIN_ORDER_NOT_MET' };

  const totalUses = db.get('orders').filter({ promoCode: code }).size().value();
  if (promo.usageLimit && totalUses >= promo.usageLimit) return { error: 'USAGE_LIMIT_REACHED' };

  const userUses = db.get('orders').filter({ promoCode: code, userId }).size().value();
  if (promo.perUserLimit && userUses >= promo.perUserLimit) return { error: 'USER_LIMIT_REACHED' };

  let discount =
    promo.discountType === 'percentage' ? (orderAmount * promo.discountValue) / 100 : promo.discountValue;
  if (promo.maxDiscount) discount = Math.min(discount, promo.maxDiscount);
  return { discount: Math.round(discount) };
}

function editVoucherCode(voucherId, newCode) {
  const v = db.get('vouchers').find({ id: voucherId }).value();
  if (!v) return { error: 'NOT_FOUND' };
  if (v.status !== 'AVAILABLE') return { error: 'CANNOT_EDIT_SOLD_OR_RESERVED' };
  const clean = newCode.trim();
  if (!clean) return { error: 'EMPTY_CODE' };
  const dup = db.get('vouchers').find({ productId: v.productId, code: clean }).value();
  if (dup && dup.id !== voucherId) return { error: 'DUPLICATE_CODE' };
  db.get('vouchers').find({ id: voucherId }).assign({ code: clean }).write();
  return { ok: true };
}

function getDashboardStats() {
  const orders = db.get('orders').value();
  const today = new Date().setHours(0, 0, 0, 0);
  const todayOrders = orders.filter(o => o.createdAt >= today);
  return {
    totalUsers: db.get('users').size().value(),
    activeUsers: db.get('users').filter(u => Date.now() - u.lastActivity < 7 * 24 * 3600 * 1000).size().value(),
    totalOrders: orders.length,
    todayOrders: todayOrders.length,
    todayRevenue: todayOrders.filter(o => ['PAID', 'DELIVERED'].includes(o.status)).reduce((s, o) => s + o.amount, 0),
    totalRevenue: orders.filter(o => ['PAID', 'DELIVERED'].includes(o.status)).reduce((s, o) => s + o.amount, 0),
    pendingPayments: orders.filter(o => o.status === 'PAYMENT_PENDING').length,
    successfulPayments: orders.filter(o => ['PAID', 'DELIVERED'].includes(o.status)).length,
    failedPayments: orders.filter(o => ['FAILED', 'CANCELLED'].includes(o.status)).length,
    totalStock: db.get('vouchers').filter({ status: 'AVAILABLE' }).size().value(),
    soldVouchers: db.get('vouchers').filter({ status: 'SOLD' }).size().value(),
    lowStockProducts: db
      .get('products')
      .filter(p => availableStockCount(p.id) <= (p.lowStockThreshold || 5))
      .size()
      .value(),
  };
}

module.exports = {
  db,
  id,
  log,
  getOrCreateUser,
  getUser,
  updateUser,
  setUserBlocked,
  recalcRank,
  getActiveRequiredChannels,
  getActiveCategories,
  getActiveProductsByCategory,
  getProduct,
  availableStockCount,
  addVoucherCodes,
  reserveVouchers,
  releaseVouchers,
  markVouchersSold,
  createOrder,
  payOrderFromWallet,
  getOrder,
  getUserOrders,
  expireStaleOrders,
  completeOrderPayment,
  markOrderDelivered,
  getVoucherCodesForOrder,
  createPaymentRecord,
  isTxnRefUsed,
  finalizePayment,
  getWallet,
  walletTransaction,
  validatePromoCode,
  editVoucherCode,
  getDashboardStats,
};
