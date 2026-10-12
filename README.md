# JC Self-Serve Refund System

Lets a customer refund their own order **without leaving the SamCart landing page**:
enter email → receive a 6-digit code → confirm → refund is issued via SamCart's API.

```
SamCart page (Custom HTML widget)  →  Cloud Run backend  →  SamCart Refund API
                                            │                      │
                                       BigQuery lookup        SamCart fires refund webhook
                                       (7-day check)          → existing n8n → BQ + Slack
```

## Pieces

| Path | What it is |
|------|-----------|
| `frontend/widget.html` | Paste into a SamCart **Code / Custom HTML** block. Self-contained. Set `REFUND_API_BASE`. |
| `backend/` | Node service for Cloud Run. 3 endpoints: `/send-otp`, `/verify-otp`, `/refund`. |

## How the refund actually works

SamCart processes payments through Stripe, but you do **not** call Stripe directly.
SamCart's own API has a refund endpoint:

```
POST https://{marketplace}.samcart.com/v1/refunds/charges/{chargeId}/
headers: sc-api: <API_KEY>, Accept: application/json
body: {}                      # omit amount = full refund; {"amount": <cents>} = partial
```

Refunding through SamCart (rather than Stripe direct) keeps SamCart's dashboard in
sync **and** triggers its refund webhook, which the existing **“JC Samcart - Sales,Refund & Cancel”**
n8n workflow already logs to BigQuery (`raw_events`) and posts to `#jc-churn`. No extra logging needed.

The refund endpoint needs SamCart's **internal charge id** (an integer), not the Stripe
`ch_…` id stored in BigQuery — so the backend looks up the order in BQ (for the 7-day
eligibility check), then calls `GET /orders/{id}` on SamCart to resolve the charge id.

## Security model

- The **SamCart API key never touches the frontend** — only the Cloud Run backend holds it.
- **OTP** proves the requester owns the order email. Codes are hashed (scrypt), single-use,
  expire in 10 min, max 5 attempts.
- `/send-otp` always returns `200` (no email is ever sent for a non-existent order) to
  prevent email/order enumeration.
- The **7-day window is re-checked server-side at refund time** — the client and JWT are
  never trusted for eligibility.
- CORS is locked to the SamCart page origin.

## Setup status (as of 2026-07-12)

Already done on `jason-capital` (project owner: atharva@aircreator.ai):
- ✅ APIs enabled: Firestore, Cloud Run, Cloud Build, Secret Manager, Artifact Registry
- ✅ Firestore database created (native, `nam5` US multi-region) — OTP store
- ✅ Secrets in Secret Manager: `jc-refund-jwt` (real), `jc-resend-key` (real), `jc-samcart-key` (placeholder)
- ✅ OTP email via **Resend** template `jc-refund-otp` (published; vars CODE/MINUTES; from `no-reply@aircreator.cloud`, the Resend-verified domain)
- ✅ Runtime SA `486757944947-compute@developer.gserviceaccount.com` granted bigquery.jobUser, bigquery.dataViewer, datastore.user, secretmanager.secretAccessor
- ✅ Backend deployed to Cloud Run `jc-refund` (us-central1), reads `jc_scoreboard.transactions`
- ✅ BQ eligibility query validated against real data (per-order sum, 7-day check, already-refunded detection)

Pending (needs external input):
- ⏳ `jc-samcart-key` — real SamCart API key (waiting on support@samcart.com)
- ⏳ Confirm SamCart API base host / marketplace slug, then verify `GET /orders/{id}/charges` shape on a real order

To fill a pending secret later and redeploy:
```bash
printf "%s" "THE_REAL_VALUE" | gcloud secrets versions add jc-samcart-key --data-file=- --project jason-capital
gcloud run services update jc-refund --region us-central1 --project jason-capital  # picks up :latest
```

## Deploy (backend → Cloud Run)

```bash
cd backend
gcloud run deploy jc-refund \
  --source . \
  --project jason-capital \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "^@@^GCP_PROJECT=jason-capital@@BQ_DATASET=jc_scoreboard@@BQ_TABLE=transactions@@ALLOWED_ORIGIN=https://ammarketing.mysamcart.com@@SAMCART_MARKETPLACE=ammarketing@@RESEND_TEMPLATE_ID=jc-refund-otp@@MAIL_FROM=Jason Capital Refunds <no-reply@aircreator.cloud>" \
  --set-secrets "JWT_SECRET=jc-refund-jwt:latest,SAMCART_API_KEY=jc-samcart-key:latest,RESEND_API_KEY=jc-resend-key:latest"
```

The Cloud Run service account needs `roles/bigquery.dataViewer` + `roles/bigquery.jobUser`
on `jason-capital`, and `roles/datastore.user` (Firestore, for the OTP store).

Then put the resulting `https://…run.app` URL into `frontend/widget.html` → `REFUND_API_BASE`,
and paste the widget into the SamCart page.

## Blockers to resolve before go-live

1. **SamCart API key** — issued only by SamCart support (private beta). Email
   support@samcart.com to request one for the marketplace.
2. **Confirm the marketplace API subdomain** — docs use `https://{marketplace}.samcart.com/v1`.
   Verify whether it's `ammarketing.samcart.com` vs the `mysamcart.com` host.
3. **Verify the `GET /orders/{id}` charge-id shape** against a real order once the key exists,
   and adjust `getChargeIdsForOrder()` if the field path differs.
4. **Firestore** must be enabled in `jason-capital` (Native mode) for the OTP store — or swap
   that store for Redis/Memorystore.
```
