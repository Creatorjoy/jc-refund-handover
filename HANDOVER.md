# JC / Affiliate Boss Refund System — Handover

Self-serve refund widget embedded on the SamCart page
(`ammarketing.mysamcart.com/7-days-refund-policy/`). Customer enters email →
gets a 6-digit code by email → (optional retention + offboarding survey) →
refunds their own order, without leaving the page.

```
SamCart page (Code/HTML block)
        │  iframe  →  Cloud Run service "jc-refund" (Node 20)
        │                 ├── SamCart API      (order lookup + the actual refund)
        │                 ├── Firestore        (OTP store)
        │                 ├── BigQuery          (offboarding survey log)
        │                 └── Resend            (OTP email)
        └── refund via SamCart fires SamCart's refund webhook → existing n8n → BQ + Slack #jc-churn
```

Order lookup and refunds go through the **SamCart API** (the durable source of
truth). We do **not** look orders up in BigQuery and do **not** call Stripe directly.

---

## 1. Repo layout

| Path | What it is |
|------|-----------|
| `backend/index.js` | The whole service. Endpoints: `/offboard`, `/send-otp`, `/verify-otp`, `/refund`, `/widget`, `/healthz`, `/assets/ab-icon.png`. |
| `backend/widget.test.html` | The widget HTML the service serves at `/widget`. **Generated from `frontend/widget.html`** (see Deploy step 1). |
| `backend/.env.example` | Copy to `.env` for local dev. Placeholders only — no real keys. |
| `backend/Dockerfile` | Used by Cloud Build on `--source` deploy. |
| `backend/assets/ab-icon.png` | AB logo; the OTP email references it at `/assets/ab-icon.png`. |
| `frontend/widget.html` | **Canonical** widget source. Edit here. `REFUND_API_BASE` = the Cloud Run URL. |
| `frontend/embed-samcart.html` | The block pasted into the SamCart page (logo + heading + iframe + the postMessage resize/scroll script). |

Repo: `github.com/atharva-karanjawane/jc-refund-system` (private).
**Always `git pull` before deploying** — several people deploy to the same Cloud Run
service from local copies and have clobbered each other before.

---

## 2. Environment variables

These are the ones `index.js` actually reads (`process.env`, top of the file).
Non-secret ones go in `--set-env-vars`; the three secrets come from Secret Manager
via `--set-secrets`.

| Var | Secret? | Value / notes |
|-----|---------|---------------|
| `GCP_PROJECT` | no | `jason-capital` |
| `BQ_DATASET` | no | `jc_scoreboard` (only used for the offboarding log table) |
| `REFUND_WINDOW_DAYS` | no | `7` |
| `ALLOWED_ORIGIN` | no | `https://ammarketing.mysamcart.com` (CORS; must match the SamCart page origin) |
| `SAMCART_API_BASE` | no | `https://api.samcart.com/v1` (central host; marketplace identified by the key) |
| `RESEND_TEMPLATE_ID` | no | `jc-refund-otp` |
| `MAIL_FROM` | no | `Affiliate Boss Refunds <no-reply@otp.joinaffiliateboss.com>` |
| `OTP_TTL_SECONDS` | no | `600` (10 min) |
| `OTP_MAX_ATTEMPTS` | no | `5` |
| `JWT_SECRET` | **yes** | Secret `jc-refund-jwt`. Any long random hex (`openssl rand -hex 32`). |
| `SAMCART_API_KEY` | **yes** | Secret `jc-samcart-key`. The `sc-api` key from SamCart. |
| `RESEND_API_KEY` | **yes** | Secret `jc-resend-key`. Resend API key. |

Legacy note: older `.env.example` / deploy commands set `BQ_TABLE` and
`SAMCART_MARKETPLACE`. **The current code ignores both** — safe to drop.

---

## 3. Secrets (Google Secret Manager, project `jason-capital`)

Three secrets, referenced by `:latest`:

| Secret | Holds |
|--------|-------|
| `jc-refund-jwt` | JWT signing key |
| `jc-samcart-key` | SamCart API key |
| `jc-resend-key` | Resend API key |

To rotate/fill a secret and redeploy so the new version is picked up:

```bash
printf "%s" "THE_REAL_VALUE" | gcloud secrets versions add jc-samcart-key --data-file=- --project jason-capital
gcloud run services update jc-refund --region us-central1 --project jason-capital
```

The Cloud Run runtime service account
(`486757944947-compute@developer.gserviceaccount.com`) needs:
`roles/secretmanager.secretAccessor`, `roles/datastore.user` (Firestore),
`roles/bigquery.jobUser`, `roles/bigquery.dataEditor` (offboarding writes),
and (for `--source` builds) `roles/cloudbuild.builds.builder` + `roles/storage.objectViewer`.

---

## 4. Databases

### Firestore (OTP store) — native mode, `nam5`
- Collection `refund_otps`, one doc per email in flight.
- Stores the scrypt-hashed code, expiry, attempt count, and the `attempt_id` that
  links the OTP to the offboarding row. Created/read/deleted by the service; no setup
  beyond the Firestore database existing in native mode.

### BigQuery (offboarding survey log) — durable table
- `jason-capital.jc_scoreboard.refund_offboarding`
- Written by `/offboard` (INSERT) and flipped to `refunded` by `/refund` (UPDATE on `attempt_id`).
- Columns the current code writes:

| Column | Type | Meaning |
|--------|------|---------|
| `attempt_id` | STRING | links OTP → offboarding row → refund outcome |
| `submitted_at` | TIMESTAMP | `CURRENT_TIMESTAMP()` at submit |
| `email` | STRING | |
| `order_id` / `order_date` | STRING | from the SamCart lookup |
| `within_window` | BOOL | inside the 7-day window |
| `q1_reason` | STRING | primary reason (Money/Time/Fit/Expectations/Other) |
| `q1_detail` | STRING | free text |
| `q2_used` | STRING | usage multi-select, joined |
| `q3_match` | INT64 | 1–5 expectation match (injected as validated literal, or NULL) |
| `q3_expected` | STRING | conditional free text |
| `q4_change` | STRING | optional free text |
| `action` | STRING | `get_otp` or `need_guidance` |
| `outcome` | STRING | `otp_requested` → `refunded`, or `saved_guidance` |
| `refunded_amount_cents` | INT64 | set when refunded |
| `resolved_at` | TIMESTAMP | when resolved |

> The table also has legacy columns `q1_tried` / `q2_why_quit` from the V1 survey
> (nullable, no longer written). Leave them — old rows use them.

If recreating the table from scratch, create it with those columns (the code only
INSERTs/UPDATEs — it does not auto-create the table).

---

## 5. Resend (OTP email)

- Account: the dedicated Affiliate Boss Resend account (its API key is `jc-resend-key`).
- Verified sending domain: **`otp.joinaffiliateboss.com`**.
- Sender: `Affiliate Boss Refunds <no-reply@otp.joinaffiliateboss.com>` (= `MAIL_FROM`).
- Published **template** `jc-refund-otp`: variables `CODE` (string) and `MINUTES`
  (number), used in the template as triple-brace `{{{CODE}}}` / `{{{MINUTES}}}`.
- Subject: `Your Refund Code | Affiliate Boss`. Body shows the AB logo (served by the
  backend at `/assets/ab-icon.png`) and a "do not reply, email
  support@joinaffiliateboss.com" line.
- The backend calls `POST https://api.resend.com/emails` with
  `template: { id, variables: { CODE, MINUTES } }`.

Resend template-API gotchas (if editing the template via API): each variable needs
`key` + `type`; Cloudflare 403s the `python-urllib` user agent, so use `curl`.

> Gmail's circular sender avatar can't be set through Resend — it needs BIMI
> (DMARC enforcement + a BIMI DNS record + a paid VMC). The logo is in the body instead.

---

## 6. Deploy (backend → Cloud Run)

```bash
cd backend

# 1) regenerate the served widget from the canonical frontend source,
#    pointing REFUND_API_BASE at same-origin ("") so /widget calls itself
cp ../frontend/widget.html widget.test.html
sed -i 's#var REFUND_API_BASE = "https://jc-refund-486757944947.us-central1.run.app";#var REFUND_API_BASE = "";#' widget.test.html

# 2) deploy
gcloud run deploy jc-refund \
  --source . \
  --project jason-capital \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "^@@^GCP_PROJECT=jason-capital@@BQ_DATASET=jc_scoreboard@@REFUND_WINDOW_DAYS=7@@ALLOWED_ORIGIN=https://ammarketing.mysamcart.com@@SAMCART_API_BASE=https://api.samcart.com/v1@@RESEND_TEMPLATE_ID=jc-refund-otp@@MAIL_FROM=Affiliate Boss Refunds <no-reply@otp.joinaffiliateboss.com>@@OTP_TTL_SECONDS=600@@OTP_MAX_ATTEMPTS=5" \
  --set-secrets "JWT_SECRET=jc-refund-jwt:latest,SAMCART_API_KEY=jc-samcart-key:latest,RESEND_API_KEY=jc-resend-key:latest" \
  --min-instances 1 --cpu-boost
```

(`--min-instances 1 --cpu-boost` removes the cold-start lag on the widget.)

**Public access:** the aircreator.ai org enforces `iam.allowedPolicyMemberDomains`
(Domain Restricted Sharing), which blocks `allUsers`. To let the public hit the
service, an org admin first overrode that policy at the project level, then bound
`allUsers` → `roles/run.invoker`. If a fresh deploy ever comes back private, that
binding has to be re-applied by an org admin — it is an org-admin action, not part of
the normal deploy.

---

## 7. Frontend (SamCart page)

The SamCart page has a **Code / Custom HTML block** containing
`frontend/embed-samcart.html`: the AB logo, the heading, an `<iframe>` pointing at
`<service-url>/widget`, a loading skeleton, and a small `postMessage` listener that
(a) auto-resizes the iframe to the widget height and (b) scrolls the current survey
question into view.

- `ORIGIN` in that block and the iframe `src` must both be the Cloud Run service URL.
- To change the widget itself, edit `frontend/widget.html` and redeploy (step 6);
  the iframe content updates automatically. The embed block only needs re-pasting if
  you change the block itself (logo/heading/script).

---

## 8. Quick smoke test after deploy

```bash
curl -s https://jc-refund-486757944947.us-central1.run.app/healthz      # -> ok
# open /widget in a browser, enter an email that has a real order within 7 days,
# confirm the code email arrives, then verify the refund button lists the charges.
```
