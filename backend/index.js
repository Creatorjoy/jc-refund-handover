// =============================================================================
//  JC Self-Serve Refund Backend  (Cloud Run, Node 20+)
//  Endpoints called by the SamCart-embedded widget:
//    POST /send-otp    { email }                  -> emails a 6-digit code if an order exists
//    POST /verify-otp  { email, code }            -> short-lived JWT + order's refundable charges
//    POST /refund      { token, charge_ids[] }    -> refunds the SELECTED charges
//
//  Orders are looked up via the SamCart API (the durable source of truth) — NOT the
//  BigQuery `transactions` view, which only retains ~1 day of raw_events.
//  Refunds go through SamCart's own API (POST /refunds/charges/{id}/), which keeps
//  SamCart in sync AND fires its refund webhook -> existing n8n -> Slack.
//  Each SamCart charge is a separate transaction (base product vs 1-click upsell),
//  so the customer can refund one or several.
// =============================================================================

import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { Firestore } from "@google-cloud/firestore";
import { BigQuery } from "@google-cloud/bigquery";
import { readFileSync } from "node:fs";

// ---------- config (all via env; see .env.example) ----------
const {
  PORT = 8080,
  GCP_PROJECT = "jason-capital",
  BQ_DATASET = "jc_scoreboard",     // durable dataset for the offboarding survey log
  REFUND_WINDOW_DAYS = "7",
  ALLOWED_ORIGIN = "https://ammarketing.mysamcart.com",
  JWT_SECRET,                       // long random string
  SAMCART_API_BASE = "https://api.samcart.com/v1",  // central host; marketplace identified by the key
  SAMCART_API_KEY,                  // the sc-api key from SamCart
  RESEND_API_KEY,                   // Resend API key (transactional email)
  RESEND_TEMPLATE_ID = "jc-refund-otp",   // published Resend template (alias or UUID)
  MAIL_FROM = "Jason Capital Refunds <no-reply@aircreator.cloud>",  // domain verified in Resend
  OTP_TTL_SECONDS = "600",          // 10 min
  OTP_MAX_ATTEMPTS = "5",
} = process.env;

const WINDOW_DAYS = Number(REFUND_WINDOW_DAYS);
const SAMCART_BASE = SAMCART_API_BASE;

const db = new Firestore({ projectId: GCP_PROJECT });      // OTP + rate-limit store
const otps = db.collection("refund_otps");
const bq = new BigQuery({ projectId: GCP_PROJECT });       // offboarding survey log (durable table)
const OFFBOARD_TABLE = `${GCP_PROJECT}.${BQ_DATASET}.refund_offboarding`;

// Send the OTP email via Resend using the published "jc-refund-otp" template.
async function sendOtpEmail(to, code) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      template: {
        id: RESEND_TEMPLATE_ID,
        variables: { CODE: code, MINUTES: Math.round(Number(OTP_TTL_SECONDS) / 60) },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body}`);
  }
}

// ---------- helpers ----------
const norm = (e) => String(e || "").trim().toLowerCase();
const sixDigits = () => String(Math.floor(100000 + Math.random() * 900000));
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// ---------- order lookup via SamCart (source of truth) ----------
// NOTE: we deliberately do NOT use the BigQuery `transactions` view — it's parsed from
// `raw_events`, which an external job trims to ~1 day, so orders older than that vanish
// and the 7-day window silently breaks. SamCart holds every order permanently.

const toArr = (x) => (Array.isArray(x) ? x : (x && x.data) || []);

// SamCart order_date is "YYYY-MM-DD HH:MM:SS" (UTC) -> epoch ms.
function orderEpoch(order_date) {
  const t = Date.parse(String(order_date || "").replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : NaN;
}

function orderFrom(o) {
  const ms = orderEpoch(o.order_date);
  const within = Number.isFinite(ms) && (Date.now() - ms) < WINDOW_DAYS * 86400 * 1000; // strict 7×24h
  return {
    order_id: String(o.id),
    order_date: String(o.order_date || "").slice(0, 10),       // YYYY-MM-DD for display
    currency: o.currency || "USD",
    within_window: within,
    reason: within ? "" : `This order's ${WINDOW_DAYS}-day refund window has closed.`,
  };
}

// All SamCart customer ids for an email (case-insensitive exact match).
async function customerIdsByEmail(email) {
  const res = await scFetch(`/customers?email=${encodeURIComponent(email)}`);
  return toArr(await res.json()).map((c) => c.id).filter((x) => x != null);
}

// Most recent order for an email + whether it's within the refund window. null if none.
async function findRefundableOrder(email) {
  const ids = await customerIdsByEmail(email);
  if (!ids.length) return null;
  let orders = [];
  for (const id of ids) {
    const res = await scFetch(`/customers/${id}/orders`);
    orders = orders.concat(toArr(await res.json()));
  }
  orders = orders.filter((o) => o && o.id != null && o.order_date);
  if (!orders.length) return null;
  orders.sort((a, b) => orderEpoch(b.order_date) - orderEpoch(a.order_date));  // newest first
  return orderFrom(orders[0]);
}

// One specific order, verified to belong to `email` (used at refund time so we act on the
// exact order the customer verified — never trust the client's order id blindly).
async function getOrderForRefund(orderId, email) {
  let order, customer;
  try {
    const [oRes, cRes] = await Promise.all([
      scFetch(`/orders/${orderId}`),
      scFetch(`/orders/${orderId}/customer`),
    ]);
    order = await oRes.json();
    customer = await cRes.json();
  } catch (e) { return null; }                                 // 404 etc.
  if (!order || order.id == null) return null;
  if (norm(customer && customer.email) !== norm(email)) return null;   // ownership check
  return orderFrom(order);
}

// Tidy a long SamCart product name for the UI (drop the "(...)" clause, cap length).
function shortName(n) {
  if (!n) return null;
  const s = String(n).split(" (")[0].trim();
  return s.length > 52 ? s.slice(0, 50) + "…" : s;
}

// Individual charges on an order, each a separately-refundable transaction (SamCart only).
// Charges & cart_items map by index when their counts match; otherwise a generic label.
async function getRefundableItems(orderId) {
  const [cRes, oRes] = await Promise.all([
    scFetch(`/orders/${orderId}/charges`),
    scFetch(`/orders/${orderId}`),
  ]);
  const charges = toArr(await cRes.json()).filter((c) => c && c.id != null);
  const order = await oRes.json();
  const items = (order && order.cart_items) || [];
  const aligned = items.length === charges.length;
  return charges.map((c, i) => ({
    charge_id: c.id,
    product_name: (aligned && shortName(items[i] && (items[i].product_name || items[i].name)))
      || `Payment ${i + 1}`,
    amount_cents: Number(c.total) || 0,                        // SamCart charge total is in cents
    refunded: c.charge_refund_status === "refunded",
  }));
}

async function scFetch(path, init = {}) {
  const res = await fetch(SAMCART_BASE + path, {
    ...init,
    headers: { "sc-api": SAMCART_API_KEY, Accept: "application/json",
               "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok && res.status !== 409) {
    const body = await res.text().catch(() => "");
    throw new Error(`SamCart ${path} -> ${res.status} ${body}`);
  }
  return res;
}

// ---------- offboarding survey log (durable BigQuery table; append + one update) ----------
const clip = (s, n = 4000) => String(s == null ? "" : s).slice(0, n);

async function logOffboard(row) {
  // q3_match is a validated 1-5 integer (or NULL) injected as a literal, so no param typing needed.
  const q3 = (Number.isInteger(row.q3_match) && row.q3_match >= 1 && row.q3_match <= 5)
    ? String(row.q3_match) : "NULL";
  const sql = `INSERT INTO \`${OFFBOARD_TABLE}\`
    (attempt_id, submitted_at, email, order_id, order_date, within_window,
     q1_reason, q1_detail, q2_used, q3_match, q3_expected, q4_change,
     action, outcome, refunded_amount_cents, resolved_at)
    VALUES (@attempt_id, CURRENT_TIMESTAMP(), @email, @order_id, @order_date, @within_window,
     @q1_reason, @q1_detail, @q2_used, ${q3}, @q3_expected, @q4_change,
     @action, @outcome, NULL, ${row.resolved ? "CURRENT_TIMESTAMP()" : "NULL"})`;
  await bq.query({ query: sql, location: "US", params: {
    attempt_id: row.attempt_id, email: row.email, order_id: row.order_id || "",
    order_date: row.order_date || "", within_window: !!row.within_window,
    q1_reason: clip(row.q1_reason, 100), q1_detail: clip(row.q1_detail),
    q2_used: clip(row.q2_used, 500), q3_expected: clip(row.q3_expected),
    q4_change: clip(row.q4_change), action: row.action, outcome: row.outcome,
  }});
}

// Flip an "otp_requested" row to "refunded" once the customer actually completes the refund.
async function markRefunded(attemptId, amountCents) {
  if (!attemptId) return;
  const sql = `UPDATE \`${OFFBOARD_TABLE}\`
    SET outcome = 'refunded', refunded_amount_cents = @amt, resolved_at = CURRENT_TIMESTAMP()
    WHERE attempt_id = @id AND outcome != 'refunded'`;
  await bq.query({ query: sql, location: "US", params: { id: attemptId, amt: amountCents } });
}

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN, methods: ["POST"] }));

app.get("/healthz", (_req, res) => res.send("ok"));

// Production embeddable widget. Served same-origin, so its own API calls need no CORS.
// Embed on the SamCart page with: <iframe src="<this-service>/widget" ...></iframe>
let WIDGET_HTML = null;
try { WIDGET_HTML = readFileSync(new URL("./widget.test.html", import.meta.url), "utf8"); }
catch (e) { console.warn("widget asset missing:", e.message); }
if (WIDGET_HTML) app.get(["/widget", "/test"], (_req, res) =>
  res.type("html").set("Cache-Control", "no-cache, no-store, must-revalidate").send(WIDGET_HTML));

// Affiliate Boss logo, referenced by the OTP email template (must be a public URL).
let AB_ICON = null;
try { AB_ICON = readFileSync(new URL("./assets/ab-icon.png", import.meta.url)); }
catch (e) { console.warn("ab-icon missing:", e.message); }
if (AB_ICON) app.get("/assets/ab-icon.png", (_req, res) =>
  res.type("png").set("Cache-Control", "public, max-age=86400").send(AB_ICON));

// 0) offboarding survey -> get OTP, or deflect to Nic --------------------
app.post("/offboard", async (req, res) => {
  const b = req.body || {};
  const email = norm(b.email);
  const survey = {
    q1_reason: b.q1_reason, q1_detail: b.q1_detail, q2_used: b.q2_used,
    q3_match: Number(b.q3_match), q3_expected: b.q3_expected, q4_change: b.q4_change,
  };
  const action = b.action === "need_guidance" ? "need_guidance" : "get_otp";
  const generic = () => res.json(action === "need_guidance" ? { saved: true } : { ok: true });
  try {
    if (!isEmail(email)) return generic();
    const order = await findRefundableOrder(email);

    // Deflection: always show the community screen; log the save only if they truly have an order.
    if (action === "need_guidance") {
      if (order) await logOffboard({ attempt_id: randomUUID(), email, order_id: order.order_id,
        order_date: order.order_date, within_window: order.within_window,
        ...survey, action, outcome: "saved_guidance", resolved: true }).catch((e) => console.error("log", e));
      return res.json({ saved: true });
    }

    // Get OTP: no order -> generic ok (anti-enumeration), no code, no log.
    if (!order) return res.json({ ok: true });

    const attempt_id = randomUUID();
    await logOffboard({ attempt_id, email, order_id: order.order_id, order_date: order.order_date,
      within_window: order.within_window, ...survey, action, outcome: "otp_requested", resolved: false })
      .catch((e) => console.error("log", e));

    const code = sixDigits();
    await otps.doc(email).set({
      codeHash: await hash(code), expires_at: Date.now() + Number(OTP_TTL_SECONDS) * 1000,
      attempts: 0, created_at: Date.now(), attempt_id,
    });
    await sendOtpEmail(email, code);
    return res.json({ ok: true });
  } catch (err) {
    console.error("offboard", err);
    return generic();
  }
});

// 1) resend OTP (keeps the same offboarding attempt) ---------------------
app.post("/send-otp", async (req, res) => {
  const email = norm(req.body?.email);
  const generic = () => res.json({ ok: true });         // anti-enumeration
  try {
    if (!isEmail(email)) return generic();
    const order = await findRefundableOrder(email);
    if (!order) return generic();
    const prev = await otps.doc(email).get();
    const attempt_id = prev.exists ? (prev.data().attempt_id || null) : null;
    const code = sixDigits();
    await otps.doc(email).set({
      codeHash: await hash(code), expires_at: Date.now() + Number(OTP_TTL_SECONDS) * 1000,
      attempts: 0, created_at: Date.now(), attempt_id,
    });
    await sendOtpEmail(email, code);
    return generic();
  } catch (err) {
    console.error("send-otp", err);
    return generic();
  }
});

// 2) verify OTP -----------------------------------------------------------
app.post("/verify-otp", async (req, res) => {
  const email = norm(req.body?.email);
  const code = String(req.body?.code || "").trim();
  try {
    const snap = await otps.doc(email).get();
    if (!snap.exists) return res.status(400).json({ error: "Invalid or expired code." });
    const rec = snap.data();
    if (Date.now() > rec.expires_at) { await otps.doc(email).delete(); return res.status(400).json({ error: "Code expired. Request a new one." }); }
    if (rec.attempts >= Number(OTP_MAX_ATTEMPTS)) return res.status(429).json({ error: "Too many attempts. Request a new code." });

    if (!(await verifyHash(code, rec.codeHash))) {
      await otps.doc(email).update({ attempts: rec.attempts + 1 });
      return res.status(400).json({ error: "Invalid code." });
    }
    const attempt_id = rec.attempt_id || null;          // link back to the offboarding survey row
    await otps.doc(email).delete();                     // one-time use

    const order = await findRefundableOrder(email);
    if (!order) return res.status(404).json({ error: "No order found for this email." });

    const items = await getRefundableItems(order.order_id);
    // Short-lived token binds the refund action to this verified email + order.
    const token = jwt.sign(
      { email, order_id: order.order_id, currency: order.currency, attempt_id },
      JWT_SECRET, { expiresIn: "10m" });
    return res.json({ token, order, items, currency: order.currency });
  } catch (err) {
    console.error("verify-otp", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// 3) refund (only the selected charges) -----------------------------------
app.post("/refund", async (req, res) => {
  try {
    let claims;
    try { claims = jwt.verify(String(req.body?.token || ""), JWT_SECRET); }
    catch { return res.status(401).json({ error: "Session expired. Please start over." }); }

    const requested = Array.isArray(req.body?.charge_ids)
      ? [...new Set(req.body.charge_ids.map(Number).filter((n) => Number.isInteger(n)))]
      : [];
    if (!requested.length) return res.status(400).json({ error: "Select at least one item to refund." });

    // RE-VERIFY server-side against the SPECIFIC order in the token (not "most recent").
    const order = await getOrderForRefund(claims.order_id, claims.email);
    if (!order)
      return res.status(409).json({ error: "Order not found." });
    if (!order.within_window)
      return res.status(409).json({ error: order.reason || "This order is no longer refundable." });

    const items = await getRefundableItems(order.order_id);
    const refundable = new Set(items.filter((i) => !i.refunded).map((i) => i.charge_id));
    const toRefund = requested.filter((id) => refundable.has(id));
    if (!toRefund.length)
      return res.status(409).json({ error: "Those items can't be refunded (already refunded?)." });

    const refunded = [];
    for (const id of toRefund) {
      const r = await scFetch(`/refunds/charges/${id}/`, { method: "POST", body: JSON.stringify({}) });
      if (r.status === 409) { console.warn(`charge ${id} already refunded`); continue; }
      const it = items.find((i) => i.charge_id === id);
      refunded.push({ charge_id: id, amount_cents: it ? it.amount_cents : 0 });
    }
    // SamCart fires its refund webhook -> existing n8n -> Slack. No manual logging needed.
    const total = refunded.reduce((s, d) => s + d.amount_cents, 0);
    // Record the outcome on the offboarding survey row (awaited so it isn't cut off after response).
    if (refunded.length) await markRefunded(claims.attempt_id, total).catch((e) => console.error("markRefunded", e));
    return res.json({ ok: true, refunded, total_cents: total, currency: order.currency });
  } catch (err) {
    console.error("refund", err);
    return res.status(500).json({ error: "Refund could not be completed. Please contact support." });
  }
});

// ---------- tiny password-hash helpers (avoid extra deps) ----------
import { scrypt as _scrypt, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(_scrypt);
async function hash(code) {
  const salt = randomBytes(16);
  const dk = await scrypt(code, salt, 32);
  return salt.toString("hex") + ":" + dk.toString("hex");
}
async function verifyHash(code, stored) {
  const [saltHex, dkHex] = String(stored).split(":");
  const dk = await scrypt(code, Buffer.from(saltHex, "hex"), 32);
  const a = Buffer.from(dkHex, "hex");
  return a.length === dk.length && timingSafeEqual(a, dk);
}

app.listen(PORT, () => console.log(`refund backend listening on :${PORT} (window=${WINDOW_DAYS}d)`));
