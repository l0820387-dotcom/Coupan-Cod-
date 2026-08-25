# Voucher Store — Telegram Bot + Admin Panel

5 core files, one local JSON database, real Paytm payment verification.

```
voucherbot/
├── package.json         (manifest — not a feature file)
├── .env.example          (copy to .env and fill in — not a feature file)
├── config.js              ① all settings, loaded from .env
├── database.js            ② local JSON database + all business rules
├── paytm.js                ③ shared Paytm API calls (checksum, initiate, status, UPI QR)
├── bot.js                   ④ Telegram bot (menus, buy flow, delivery)
├── server.js                 ⑤ admin API + Paytm payment bridge (entry point)
├── public/admin.html          ⑥ admin panel (open in any browser)
└── db.json                (auto-created on first run — your live data)
```

## What's new in this version

- **Real colored buttons** — Telegram added native green/blue/red button colors in Bot API 9.4 (Feb 2026). Every button now uses this; no Mini App needed. Change colors anytime in the admin panel's **Bot Buttons** tab.
- **One message per screen** — navigating categories → products → quantity → confirm now edits your current message instead of spamming new ones.
- **Fixed channel-verify bug** — re-tapping "Verify Membership" with nothing changed no longer throws an error.
- **In-chat UPI QR payment** — tapping to pay now shows a QR code (generated from a real Paytm-issued UPI intent tied to that exact order) directly in the chat, with an **"✅ I Have Paid"** button. Tapping it re-checks the payment *live* with Paytm's Transaction Status API — it never marks an order paid just because the button was tapped. If your Paytm account/product doesn't support UPI intent generation, it automatically falls back to the browser payment link instead — nothing breaks either way.
- **Pay from Wallet** — if a user's wallet balance covers the order, they can pay instantly with no Paytm step at all.
- **WhatsApp + Telegram support options** — set both in **Settings**; users get separate buttons for each.
- **Voucher codes: edit & delete** — the **Voucher Inventory** tab now lists available codes individually with Edit/Delete buttons (sold/reserved codes are protected and can't be edited or removed).
- **Broadcast with image** — optional image URL field sends a photo broadcast instead of text-only.
- **Refer-to-unlock coupon** — configure in **Settings → Refer-to-Unlock**: after a user gets N friends to complete a paid order, they're automatically sent a specific promo code, once.
- **`/admin` command** — any ID listed in `ADMIN_TELEGRAM_IDS` can type `/admin` in the bot for a quick dashboard summary + a button straight to the full panel. (This is a lightweight summary, not a full replacement for the browser admin panel — see below.)
- Removed the duplicate "Buy Now" button by default (Bot Buttons tab still lets you re-enable it if you want two).

## About `/admin` inside Telegram

You asked for the whole admin panel to work from `/admin` in the bot. What's implemented: `/admin` gives admins a live stats summary and a one-tap link to the full panel. Rebuilding *all* of categories/products/vouchers/users/settings management as native Telegram menus (instead of the web admin panel) is a much larger, separate project — happy to build out specific pieces of that (e.g. "approve a reseller from Telegram", "add a voucher code from Telegram") if you tell me which actions matter most day-to-day.

## About the crash you reported

I couldn't fix "bar bar crash ho raha hai" without the actual error text — please send the crash screenshot (the red/white error output in Termux) so it can be looked at directly instead of guessed at.


---

## 1. Install & Run

```bash
cd voucherbot
npm install
cp .env.example .env
# edit .env — fill in your bot token, Paytm MID/key, admin password
node server.js
```

Open the admin panel at: `http://localhost:3000/admin/admin.html`
Log in with the `ADMIN_PANEL_USERNAME` / `ADMIN_PANEL_PASSWORD` from `.env`.

Your bot starts polling automatically the moment `server.js` runs (it requires `bot.js`).

## 2. Telegram Bot Setup

1. Talk to **@BotFather** on Telegram → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN` in `.env`.
2. Get your own numeric Telegram user ID (e.g. via **@userinfobot**) and put it in `ADMIN_TELEGRAM_IDS` — this is who receives admin notifications (new sales, failed payments, etc).
3. For **each required channel**: add your bot as an **admin** of that channel (Telegram only lets a bot check membership if it's an admin there). Then add the channel in the admin panel's *Required Channels* tab, using either `@channelusername` or the numeric chat ID (`-100...`) as the "Chat ID or @username" field.

## 3. Paytm Merchant Setup (real, not simulated)

You said you have a merchant account but weren't sure which product — here's how to find out and configure it:

1. Log in to the [Paytm Business Dashboard](https://dashboard.paytm.com) → **API Keys / Developer Settings**.
2. If you see **MID**, **Merchant Key**, and a **Website** name — that's the **Payment Gateway (Checkout)** product, which is exactly what this project is wired for.
3. Put those into `.env`:
   - `PAYTM_MID`, `PAYTM_MERCHANT_KEY`, `PAYTM_WEBSITE` (use `WEBSTAGING` first for testing)
   - `PAYTM_ENV=stage` while testing, then `production` once you go live with your production MID/key
4. In the Paytm dashboard, set your **callback/webhook URL** to:
   `https://yourdomain.com/paytm/callback`
   (must be a real public HTTPS URL — use a reverse proxy/hosting with SSL, or `ngrok`/`cloudflared` while testing locally)
5. Set `BASE_URL` in `.env` to that same public URL.

**How the flow works (real verification, no shortcuts):**
`/pay/:orderId` → server calls Paytm's *Initiate Transaction* API → redirects the user into Paytm's own hosted, secure payment page → Paytm calls your `/paytm/callback` → server verifies the **checksum**, then independently calls Paytm's **Transaction Status API** to reconfirm the order id, amount, and MID before ever marking anything paid. Nothing is trusted from the callback body alone.

If your account turns out to be a different Paytm product (e.g. All-in-One SDK or Business Payments API instead of Payment Gateway), the checksum/initiate/status calls in `server.js` (search for `PAYTM:` comments) are the only places that need to change — everything else (order lifecycle, inventory, delivery) stays the same.

## 4. What's fully built vs. simplified

Everything from your spec is *present* — nothing was silently dropped — but given the 5-file limit, some admin surfaces are intentionally lean rather than deeply skinned:

**Fully implemented:** channel-gate verification, configurable main menu buttons, categories/products/stock, atomic-enough voucher reservation (no double-selling), quantity picker, order lifecycle with 7-min configurable timeout + auto-release of stock, real Paytm initiate/verify/callback, wallet + wallet transactions, referral rewards, ranks, reviews (submit/moderate), promo codes, reseller approval, broadcast, admin logs, low-stock/dashboard analytics, manual-mark-paid (restricted + logged), maintenance mode.

**Present but simple, easy to extend:** offers (schema + CRUD API exist; no dedicated admin tab yet — add one following the pattern of `promoCodes` in `admin.html`), reseller-specific pricing tiers (status workflow is there; per-reseller price overrides would need one more field on products), bulk/multi-item cart purchases (currently one product per order — supports quantity, not mixed carts).

## 5. Security checklist

- [ ] `.env` is **not** committed to git and not reachable via the web server (it isn't served — only `public/` is static).
- [ ] Change `ADMIN_PANEL_PASSWORD` and `ADMIN_SESSION_SECRET` from the defaults.
- [ ] Run behind HTTPS in production (required by Paytm anyway).
- [ ] Confirm `/paytm/callback` re-verifies against Paytm's Transaction Status API (it does, in `server.js`) rather than trusting the POSTed body.
- [ ] Confirm duplicate `txnId` can't complete two orders (`isTxnRefUsed` check — it can't).
- [ ] Review `adminLogs` periodically (`db.json` → `adminLogs`) — every manual admin action is logged with actor + reason.

## 6. Testing checklist

- [ ] `/start` with no required channels joined → gate message appears, "Verify Membership" re-checks correctly.
- [ ] Add a test category + product + a few voucher codes via admin panel → confirm they show in the bot.
- [ ] Buy flow: quantity +/- respects stock, order expires automatically after the configured timeout and releases the voucher back to AVAILABLE.
- [ ] Pay with Paytm **staging** credentials end-to-end → confirm voucher is delivered exactly once and marked SOLD (not still AVAILABLE).
- [ ] Try replaying the same Paytm callback twice → second attempt must be rejected as already-processed.
- [ ] Wallet adjust from admin panel reflects instantly in the bot's 💰 Wallet screen.
- [ ] Block a user from admin panel → bot should refuse to serve them.

## 7. Deployment notes

- Any Node.js host works (VPS + PM2, Railway, Render, etc.) as long as it can serve HTTPS and keep a long-running process for bot polling.
- `db.json` is your entire database — back it up regularly (`cp db.json db.backup.json`).
- If you outgrow single-file JSON storage (very high order volume), swap `database.js`'s lowdb calls for a real database — the exported function signatures were kept stable specifically so nothing else needs to change.
