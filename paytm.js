/**
 * paytm.js
 * -----------------------------------------------------------------------
 * All direct Paytm API calls live here so both bot.js (for the in-chat
 * "I Have Paid" button) and server.js (for the webhook + browser fallback
 * page) verify payments through the exact same code path.
 *
 * Nothing in this file ever marks anything as paid — it only talks to
 * Paytm and returns what Paytm actually said. The caller (bot.js /
 * server.js) is responsible for deciding what to do with that result.
 * -----------------------------------------------------------------------
 */
const axios = require('axios');
const PaytmChecksum = require('paytmchecksum');
const config = require('./config');

async function initiateTransaction(order) {
  const body = {
    requestType: 'Payment',
    mid: config.paytm.mid,
    websiteName: config.paytm.website,
    orderId: order.id,
    callbackUrl: config.paytm.callbackUrl,
    txnAmount: { value: order.amount.toFixed(2), currency: 'INR' },
    userInfo: { custId: order.userId },
  };
  const signature = await PaytmChecksum.generateSignature(JSON.stringify(body), config.paytm.merchantKey);
  const response = await axios.post(
    `${config.paytm.initiateTxnUrl}${order.id}`,
    { body, head: { signature } },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return response.data?.body?.txnToken || null;
}

/**
 * Asks Paytm to generate a UPI intent/QR string tied to this exact order + txnToken.
 * Returns the raw UPI payload string (used to render our own QR image) or null if
 * this MID/product isn't set up for UPI intent — caller should fall back to the
 * "Pay Now" browser link in that case.
 *
 * NOTE: Paytm's exact response field for this can vary slightly by onboarding —
 * this checks the common field names. If your account returns something different,
 * check Paytm's "Process Transaction" docs for your MID and adjust the field list below.
 */
async function getUpiIntent(order, txnToken) {
  try {
    const body = { requestType: 'NATIVE', mid: config.paytm.mid, orderId: order.id, paymentMode: 'UPI_QR' };
    const signature = await PaytmChecksum.generateSignature(JSON.stringify(body), config.paytm.merchantKey);
    const response = await axios.post(
      `https://${config.paytm.txnUrlHost}/theia/api/v1/processTransaction?mid=${config.paytm.mid}&orderId=${order.id}`,
      { body, head: { signature, txnToken } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const b = response.data?.body || {};
    return b.qrData || b.deepLinkInfo?.deepLink || b.qrCodeUrl || null;
  } catch (err) {
    console.error('Paytm UPI intent error:', err.message);
    return null;
  }
}

/** Re-confirms a transaction directly with Paytm — never trust a callback or a user's "I paid" tap alone. */
async function checkStatus(orderId) {
  const body = { mid: config.paytm.mid, orderId };
  const signature = await PaytmChecksum.generateSignature(JSON.stringify(body), config.paytm.merchantKey);
  const response = await axios.post(
    config.paytm.transactionStatusUrl,
    { body, head: { signature } },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return response.data?.body || null;
}

module.exports = { initiateTransaction, getUpiIntent, checkStatus };
