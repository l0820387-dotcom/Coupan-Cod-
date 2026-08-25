/**
 * config.js
 * -----------------------------------------------------------------------
 * Single source of truth for all environment-driven configuration.
 * Nothing secret is ever hard-coded here - everything comes from .env
 * (which must NEVER be committed / exposed to the frontend).
 * -----------------------------------------------------------------------
 */
require('dotenv').config();

function requireEnv(name, fallback = undefined) {
  const val = process.env[name];
  if (val === undefined || val === '') {
    if (fallback !== undefined) return fallback;
    console.warn(`⚠️  Missing environment variable: ${name} (set it in .env before going live)`);
    return '';
  }
  return val;
}

module.exports = {
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    adminIds: requireEnv('ADMIN_TELEGRAM_IDS', '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  },

  server: {
    port: parseInt(requireEnv('PORT', '3000'), 10),
    baseUrl: requireEnv('BASE_URL', 'http://localhost:3000'),
  },

  adminPanel: {
    username: requireEnv('ADMIN_PANEL_USERNAME', 'admin'),
    password: requireEnv('ADMIN_PANEL_PASSWORD', 'admin123'),
    sessionSecret: requireEnv('ADMIN_SESSION_SECRET', 'insecure-dev-secret-change-me'),
  },

  paytm: {
    mid: requireEnv('PAYTM_MID'),
    merchantKey: requireEnv('PAYTM_MERCHANT_KEY'),
    website: requireEnv('PAYTM_WEBSITE', 'WEBSTAGING'),
    channelId: requireEnv('PAYTM_CHANNEL_ID', 'WEB'),
    industryType: requireEnv('PAYTM_INDUSTRY_TYPE', 'Retail'),
    env: requireEnv('PAYTM_ENV', 'stage'), // 'stage' | 'production'
    get txnUrlHost() {
      return this.env === 'production' ? 'securegw.paytm.in' : 'securegw-stage.paytm.in';
    },
    get initiateTxnUrl() {
      return `https://${this.txnUrlHost}/theia/api/v1/initiateTransaction?mid=${this.mid}&orderId=`;
    },
    get transactionStatusUrl() {
      return `https://${this.txnUrlHost}/v3/order/status`;
    },
    get callbackUrl() {
      return `${module.exports.server.baseUrl}/paytm/callback`;
    },
  },
};
