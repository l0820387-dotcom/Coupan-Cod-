/**
 * server.js
 * -----------------------------------------------------------------------
 * Entry point (`node server.js`). Starts the Telegram bot (via require)
 * and runs an Express server that serves:
 *   1. The Admin Panel (static admin.html + JSON REST API under /api)
 *   2. The Paytm checkout bridge page (/pay/:orderId)
 *   3. The Paytm server-to-server callback (/paytm/callback)
 *
 * PAYMENT SAFETY: an order is ONLY ever marked PAID inside
 * completeVerifiedPayment(), which is only called after (a) Paytm's
 * checksum on the callback verifies AND (b) a server-side call to
 * Paytm's Transaction Status API confirms the transaction really
 * succeeded for the correct order/amount/MID. Nothing in the bot or the
 * admin panel can mark an order PAID by itself except the explicit,
 * logged "manual mark-paid" admin action.
 * -----------------------------------------------------------------------
 */
const express = require('express');
const path = require('path');
const config = require('./config');
const dbLayer = require('./database');
const paytmApi = require('./paytm');
const { bot, deliverOrder, finalizeSuccessfulPayment, notifyAdmins } = require('./bot'); // starts the bot (polling) as a side effect

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/admin', express.static(path.join(__dirname, 'public')));

// =======================================================================
// ADMIN AUTH (simple token session — fine for a single-admin local panel)
// =======================================================================
const sessions = new Set();
function makeToken() {
  return require('crypto').randomBytes(24).toString('hex');
}
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token && sessions.has(token)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === config.adminPanel.username && password === config.adminPanel.password) {
    const token = makeToken();
    sessions.add(token);
    dbLayer.log('admin_login', username, 'admin_panel', 'success');
    return res.json({ token });
  }
  dbLayer.log('admin_login', username, 'admin_panel', 'failed');
  return res.status(401).json({ error: 'Invalid credentials' });
});

// =======================================================================
// DASHBOARD
// =======================================================================
app.get('/api/dashboard', requireAdmin, (req, res) => {
  res.json(dbLayer.getDashboardStats());
});

// =======================================================================
// GENERIC CRUD FACTORY (used for categories, products, channels, etc.)
// =======================================================================
function crud(collection, { onCreate, onUpdate } = {}) {
  const r = express.Router();
  r.get('/', requireAdmin, (req, res) => res.json(dbLayer.db.get(collection).value()));
  r.post('/', requireAdmin, (req, res) => {
    const item = { id: dbLayer.id(collection.slice(0, 3)), ...req.body };
    if (onCreate) onCreate(item);
    dbLayer.db.get(collection).push(item).write();
    dbLayer.log(`${collection}_create`, 'admin', item.id, 'success');
    res.json(item);
  });
  r.put('/:id', requireAdmin, (req, res) => {
    dbLayer.db.get(collection).find({ id: req.params.id }).assign(req.body).write();
    if (onUpdate) onUpdate(req.params.id, req.body);
    dbLayer.log(`${collection}_update`, 'admin', req.params.id, 'success');
    res.json(dbLayer.db.get(collection).find({ id: req.params.id }).value());
  });
  r.delete('/:id', requireAdmin, (req, res) => {
    dbLayer.db.get(collection).remove({ id: req.params.id }).write();
    dbLayer.log(`${collection}_delete`, 'admin', req.params.id, 'success');
    res.json({ ok: true });
  });
  return r;
}

app.use('/api/categories', crud('categories'));
app.use('/api/products', crud('products'));
app.use('/api/requiredChannels', crud('requiredChannels'));
app.use('/api/publicChannels', crud('publicChannels'));
app.use('/api/promoCodes', crud('promoCodes'));
app.use('/api/offers', crud('offers'));

// =======================================================================
// VOUCHER INVENTORY
// =======================================================================
app.get('/api/vouchers/:productId', requireAdmin, (req, res) => {
  const list = dbLayer.db.get('vouchers').filter({ productId: req.params.productId }).value();
  res.json({
    available: list.filter(v => v.status === 'AVAILABLE').length,
    sold: list.filter(v => v.status === 'SOLD').length,
    reserved: list.filter(v => v.status === 'RESERVED').length,
    // Sold codes intentionally NOT dumped in bulk here to protect sensitive data;
    // use /api/vouchers/:productId/search for a targeted lookup.
    availableCodes: list.filter(v => v.status === 'AVAILABLE').map(v => ({ id: v.id, code: v.code })),
  });
});
app.post('/api/vouchers/:productId/bulk', requireAdmin, (req, res) => {
  const { codes } = req.body; // array of strings, or newline-separated string
  const codeArray = Array.isArray(codes) ? codes : String(codes).split('\n');
  const result = dbLayer.addVoucherCodes(req.params.productId, codeArray);
  dbLayer.log('voucher_bulk_add', 'admin', req.params.productId, 'success', result);
  res.json(result);
});
app.get('/api/vouchers/:productId/search', requireAdmin, (req, res) => {
  const q = (req.query.code || '').trim();
  const match = dbLayer.db.get('vouchers').find({ productId: req.params.productId, code: q }).value();
  res.json(match ? { ...match, code: match.status === 'AVAILABLE' ? match.code : '••••••••' } : null);
});
app.delete('/api/vouchers/item/:id', requireAdmin, (req, res) => {
  const v = dbLayer.db.get('vouchers').find({ id: req.params.id }).value();
  if (v && v.status === 'AVAILABLE') {
    dbLayer.db.get('vouchers').remove({ id: req.params.id }).write();
    dbLayer.log('voucher_delete', 'admin', req.params.id, 'success');
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'Cannot delete a reserved/sold voucher' });
});
app.put('/api/vouchers/item/:id', requireAdmin, (req, res) => {
  const result = dbLayer.editVoucherCode(req.params.id, req.body.code || '');
  if (result.error) return res.status(400).json({ error: result.error });
  dbLayer.log('voucher_edit', 'admin', req.params.id, 'success');
  res.json({ ok: true });
});

// =======================================================================
// USERS
// =======================================================================
app.get('/api/users', requireAdmin, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  let list = dbLayer.db.get('users').value();
  if (q) list = list.filter(u => u.id.includes(q) || (u.username || '').toLowerCase().includes(q));
  res.json(list.slice(0, 200));
});
app.get('/api/users/:id', requireAdmin, (req, res) => {
  const user = dbLayer.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({
    user,
    wallet: dbLayer.getWallet(req.params.id),
    orders: dbLayer.getUserOrders(req.params.id, 50),
    referrals: dbLayer.db.get('referrals').filter({ inviterId: req.params.id }).value(),
  });
});
app.post('/api/users/:id/block', requireAdmin, (req, res) => {
  dbLayer.setUserBlocked(req.params.id, !!req.body.blocked, 'admin');
  res.json({ ok: true });
});
app.post('/api/users/:id/wallet-adjust', requireAdmin, (req, res) => {
  const { amount, type, note } = req.body; // type: CREDIT | DEBIT
  const result = dbLayer.walletTransaction(req.params.id, 'ADMIN_ADJUSTMENT', Math.abs(amount) * (type === 'DEBIT' ? -1 : 1) >= 0 ? Math.abs(amount) : Math.abs(amount), note || 'Manual admin adjustment');
  dbLayer.log('wallet_admin_adjust', 'admin', req.params.id, 'success', { amount, type });
  res.json(result);
});

// =======================================================================
// ORDERS
// =======================================================================
app.get('/api/orders', requireAdmin, (req, res) => {
  const { q } = req.query;
  let list = dbLayer.db.get('orders').orderBy(['createdAt'], ['desc']).value();
  if (q) {
    list = list.filter(o => o.id.includes(q) || o.userId.includes(q) || (o.txnRef || '').includes(q));
  }
  res.json(list.slice(0, 300));
});
app.post('/api/orders/:id/resend', requireAdmin, async (req, res) => {
  const order = dbLayer.getOrder(req.params.id);
  if (!order || order.status !== 'DELIVERED') return res.status(400).json({ error: 'Order not delivered yet' });
  const codes = dbLayer.getVoucherCodesForOrder(order.id);
  await bot.sendMessage(order.userId, `🔁 *Resent — Order ${order.id}*\n\n🎁 Voucher Code(s):\n${codes.map(c => `\`${c}\``).join('\n')}`, { parse_mode: 'Markdown' });
  dbLayer.log('order_resend', 'admin', order.id, 'success');
  res.json({ ok: true });
});
app.post('/api/orders/:id/cancel', requireAdmin, (req, res) => {
  const order = dbLayer.getOrder(req.params.id);
  if (!order || order.status !== 'PAYMENT_PENDING') return res.status(400).json({ error: 'Only pending orders can be cancelled' });
  dbLayer.releaseVouchers(order.voucherIds);
  dbLayer.db.get('orders').find({ id: order.id }).assign({ status: 'CANCELLED' }).write();
  dbLayer.log('order_cancel', 'admin', order.id, 'success');
  res.json({ ok: true });
});
// Manual "mark paid" — restricted, clearly logged, requires a reason. Use only for
// genuinely confirmed off-band payments (e.g. verified directly in the Paytm dashboard).
app.post('/api/orders/:id/manual-mark-paid', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'A reason is required for manual payment confirmation' });
  const result = dbLayer.completeOrderPayment(req.params.id, `MANUAL:${reason}`);
  if (result.error) return res.status(400).json({ error: result.error });
  dbLayer.log('order_manual_mark_paid', 'admin', req.params.id, 'success', { reason });
  await deliverOrder(req.params.id);
  res.json({ ok: true });
});

// =======================================================================
// PAYMENTS overview
// =======================================================================
app.get('/api/payments', requireAdmin, (req, res) => {
  res.json(dbLayer.db.get('payments').orderBy(['createdAt'], ['desc']).take(300).value());
});

// =======================================================================
// SETTINGS (timeout, buttons, welcome message, maintenance, referral, support)
// =======================================================================
app.get('/api/settings', requireAdmin, (req, res) => res.json(dbLayer.db.get('settings').value()));
app.put('/api/settings', requireAdmin, (req, res) => {
  dbLayer.db.set('settings', { ...dbLayer.db.get('settings').value(), ...req.body }).write();
  dbLayer.log('settings_update', 'admin', 'settings', 'success');
  res.json(dbLayer.db.get('settings').value());
});

// =======================================================================
// BROADCAST
// =======================================================================
app.post('/api/broadcast', requireAdmin, async (req, res) => {
  const { text, imageUrl } = req.body;
  const users = dbLayer.db.get('users').filter(u => !u.blocked).value();
  let sent = 0,
    failed = 0;
  for (const u of users) {
    try {
      if (imageUrl) {
        await bot.sendPhoto(u.id, imageUrl, { caption: text, parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(u.id, text, { parse_mode: 'Markdown' });
      }
      sent++;
    } catch (e) {
      failed++;
    }
  }
  dbLayer.db.get('broadcasts').push({ id: dbLayer.id('bcast'), text, imageUrl: imageUrl || null, sent, failed, total: users.length, createdAt: Date.now() }).write();
  res.json({ total: users.length, sent, failed });
});

// =======================================================================
// REVIEWS moderation
// =======================================================================
app.get('/api/reviews', requireAdmin, (req, res) => res.json(dbLayer.db.get('reviews').value()));
app.post('/api/reviews/:id/status', requireAdmin, (req, res) => {
  dbLayer.db.get('reviews').find({ id: req.params.id }).assign({ status: req.body.status }).write();
  res.json({ ok: true });
});

// =======================================================================
// RESELLERS
// =======================================================================
app.get('/api/resellers', requireAdmin, (req, res) => res.json(dbLayer.db.get('resellers').value()));
app.post('/api/resellers/:userId/status', requireAdmin, (req, res) => {
  const { status } = req.body; // approved | rejected | blocked
  dbLayer.updateUser(req.params.userId, { isReseller: status === 'approved', resellerStatus: status });
  dbLayer.log('reseller_status', 'admin', req.params.userId, status);
  res.json({ ok: true });
});

// =======================================================================
// PAYTM: checkout bridge page + webhook
// =======================================================================

// User taps "Pay Now" in Telegram -> lands here -> we initiate txn server-side -> auto-redirect to Paytm
app.get('/pay/:orderId', async (req, res) => {
  const order = dbLayer.getOrder(req.params.orderId);
  if (!order) return res.status(404).send('Order not found');
  if (order.status !== 'PAYMENT_PENDING') return res.send(`<h2>This order is ${order.status}. Return to Telegram.</h2>`);
  if (Date.now() > order.expiresAt) return res.send('<h2>This payment link has expired. Please create a new order in the bot.</h2>');

  try {
    const txnToken = await paytmApi.initiateTransaction(order);
    if (!txnToken) {
      console.error('Paytm initiate failed for order', order.id);
      return res.send('<h2>Unable to start payment right now. Please try again shortly or contact support.</h2>');
    }

    // Auto-submitting form straight into Paytm's hosted, secure transaction page.
    res.send(`
      <html><body onload="document.forms[0].submit()">
        <p>Redirecting to secure Paytm payment page...</p>
        <form method="post" action="https://${config.paytm.txnUrlHost}/theia/api/v1/showPaymentPage?mid=${config.paytm.mid}&orderId=${order.id}">
          <input type="hidden" name="mid" value="${config.paytm.mid}" />
          <input type="hidden" name="orderId" value="${order.id}" />
          <input type="hidden" name="txnToken" value="${txnToken}" />
        </form>
      </body></html>
    `);
  } catch (err) {
    console.error('Paytm initiate error:', err.message);
    res.status(500).send('<h2>Payment gateway error. Please try again shortly.</h2>');
  }
});

// Paytm posts the result here (server-to-server). This is the ONLY place
// an order can transition PAYMENT_PENDING -> PAID via the payment gateway.
app.post('/paytm/callback', async (req, res) => {
  const body = req.body;
  try {
    const receivedChecksum = body.CHECKSUMHASH;
    const paytmParamsCopy = { ...body };
    delete paytmParamsCopy.CHECKSUMHASH;

    const isValidChecksum = await PaytmChecksum.verifySignature(paytmParamsCopy, config.paytm.merchantKey, receivedChecksum);
    if (!isValidChecksum) {
      dbLayer.log('paytm_callback', 'paytm', body.ORDERID, 'invalid_checksum');
      return res.status(400).send('Checksum verification failed');
    }

    const orderId = body.ORDERID;
    const order = dbLayer.getOrder(orderId);
    if (!order) {
      dbLayer.log('paytm_callback', 'paytm', orderId, 'order_not_found');
      return res.status(404).send('Order not found');
    }

    // Never trust the callback body alone — re-confirm status directly with Paytm
    // through the same shared helper the "I Have Paid" button uses.
    const result = await paytmApi.checkStatus(orderId);

    dbLayer.finalizePayment(orderId, { status: result?.resultInfo?.resultStatus, txnRef: result?.txnId, raw: result });

    const amountMatches = result && Math.abs(parseFloat(result.txnAmount) - order.amount) < 0.01;
    const txnRefFresh = result?.txnId && !dbLayer.isTxnRefUsed(result.txnId);

    if (result?.resultInfo?.resultStatus === 'TXN_SUCCESS' && amountMatches && txnRefFresh) {
      const completion = dbLayer.completeOrderPayment(orderId, result.txnId);
      if (!completion.error) {
        await finalizeSuccessfulPayment(orderId, result.txnId, completion);
        dbLayer.log('paytm_callback', 'paytm', orderId, 'paid_and_delivered');
      } else {
        dbLayer.log('paytm_callback', 'paytm', orderId, `skipped_${completion.error}`);
      }
    } else {
      dbLayer.db.get('orders').find({ id: orderId }).assign({ status: 'FAILED' }).write();
      dbLayer.releaseVouchers(order.voucherIds);
      dbLayer.log('paytm_callback', 'paytm', orderId, 'payment_failed', { resultStatus: result?.resultInfo?.resultStatus, amountMatches, txnRefFresh });
      notifyAdmins(`⚠️ Payment failed/mismatched for order ${orderId}`);
    }

    res.send('OK');
  } catch (err) {
    console.error('Paytm callback error:', err.message);
    dbLayer.log('paytm_callback', 'paytm', req.body?.ORDERID || 'unknown', 'error', { message: err.message });
    res.status(500).send('Error processing callback');
  }
});

// =======================================================================
// Periodic sweep to release stock from expired unpaid orders
// =======================================================================
setInterval(() => dbLayer.expireStaleOrders(), 30 * 1000);

app.listen(config.server.port, () => {
  console.log(`✅ Admin panel + Paytm webhook server running on port ${config.server.port}`);
  console.log(`   Admin panel:     ${config.server.baseUrl}/admin/admin.html`);
  console.log(`   Paytm callback:  ${config.paytm.callbackUrl}`);
});
