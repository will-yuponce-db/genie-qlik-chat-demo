# Genie Chat for Qlik — reference pattern

A minimal, deployable demo of embedding a **Databricks Genie** chatbot inside **Qlik**,
designed for the CBP **FedRAMP Moderate** constraints.

The pattern: a thin backend holds a **service principal** and calls the Genie
**Conversations API**; a Qlik visualization extension (or any web page) renders an inline
chat UI and talks only to that backend. **No Databricks credential ever reaches the
browser.**

```
Qlik user (browser)                 Backend (you host, in boundary)        Databricks (FRM)
──────────────────                  ───────────────────────────────       ────────────────
Qlik extension  ──POST /api/chat──▶  FastAPI (holds SP secret)      ──────▶ Genie
(user's SSO                          • SP OAuth (M2M) → token               Conversations API
 session only)   ◀──answer+SQL+rows──  • polls Genie start→poll→fetch  ◀────  (one space)
                                     • logs user ↔ conversation (audit)
```

## Why this shape (FedRAMP Moderate)

- **OBO (on-behalf-of-user) auth is HIPAA-only under FRM**, so Genie calls run as a
  **service principal**. The backend is where the real user is attributed for audit.
- **Browsers can't hold secrets** — an SP credential in client JS is credential spillage.
  It stays server-side here.
- There is **no first-party "Genie in Qlik" integration** and the Databricks UI can't be
  iframed. The Conversations API + your own UI is the supported path.

## Layout

```
backend/            FastAPI tier that holds the SP and calls Genie
  app.py            POST /api/chat, CORS, audit log; serves the demo UI
  genie.py          Genie Conversations API client (start → poll → fetch)
  requirements.txt
frontend/
  index.html        Self-contained chat UI (served by the backend for standalone demo)
qlik-extension/     Qlik Sense visualization extension (the production front end)
  genie-chat.qext
  genie-chat.js
.env.example
```

## Prerequisites

1. A **Genie space** in the FRM workspace (note its 32-hex space id). Because **data
   sampling is off under CSP**, the space needs good column comments + instructions for
   accurate NL→SQL.
2. A **service principal** with least privilege: `CAN_RUN` on the Genie space and
   `CAN_USE` on its SQL warehouse — nothing else.
3. Confirm the **Genie Conversations API is on the CBP CSP allowlist** before a production
   commit (Genie is supported; verify this specific surface).

## Demo it without Qlik

You do **not** need Qlik to run or show this. The backend + a browser page is the whole
working system; the Qlik extension is just the eventual host wrapper. Open the backend's
`/` route to get a **Qlik-style dashboard with the live Genie chat docked on the right**.

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # run in your own terminal (needs network)

# A ready-made demo Genie space (NYC taxi sample data) already exists:
export GENIE_SPACE_ID=01f1bea84fde1d539597ded074d75616
export DATABRICKS_CONFIG_PROFILE=fevm-will-wy-demo

uvicorn app:app --reload --port 8000
```

Then open:
- **http://localhost:8000** — Qlik-style dashboard + live chat (the demo surface)
- **http://localhost:8000/chat** — the bare chat UI (what the Qlik extension renders)

Ask e.g. *"average fare by pickup zip"* or *"top 5 pickup zips by trips"*. This exercises
the real start → poll → fetch loop against Genie (verified: returns answer + SQL + rows).

> For the CBP FRM target, only the env changes: `DATABRICKS_HOST` + SP `CLIENT_ID`/`SECRET`
> and a `GENIE_SPACE_ID` on `fe-sandbox-will-wy-frm` (re-auth that profile first). The code
> is identical.

## Deploy (production shape)

1. Host `backend/` on **CBP infrastructure inside the ATO boundary** (container / app
   service). Set env from `.env.example`:
   - `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET` from a **secret manager**, never
     in source or image.
   - `ALLOWED_ORIGINS` = your Qlik Cloud tenant origin only.
2. Replace the demo's `X-Forwarded-User` header with the **validated Qlik/SSO identity**
   for real audit attribution.
3. In **Qlik Cloud**: add the backend domain to the tenant **CSP allowlist**
   (`connect-src`), upload `qlik-extension/` (zipped) under Administration → Extensions,
   add **Genie Chat** to a sheet, and set the **Backend URL** property.

## Security notes

- The SP secret lives only in the backend process/secret manager. Inspect the shipped
  widget bundle and the browser network tab — there is no Databricks token client-side.
- Keep the SP least-privileged; a leak then only reaches the one Genie space.
- Because OBO is unavailable, the SP sees everything the space exposes — enforce any
  per-user data scoping in the space/underlying tables or at this backend tier.

> Demo-grade: in-memory client, no rate limiting/retries/tests. Harden before production.
