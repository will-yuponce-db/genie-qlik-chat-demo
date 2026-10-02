"""FastAPI backend: the thin tier that holds the service principal and calls Genie.

This is the security boundary. The Databricks credential lives here (server-side),
never in the Qlik widget. The browser calls POST /api/chat with the user's existing
Qlik/SSO session; this process attaches the SP token and talks to Genie.

Run locally:
    pip install -r requirements.txt
    export GENIE_SPACE_ID=<32-hex-space-id>
    export DATABRICKS_CONFIG_PROFILE=<your-frm-profile>   # dev only
    uvicorn app:app --reload --port 8000
Then open http://localhost:8000
"""

import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from genie import GenieClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("genie-chat")

# Lock this down in production to the Qlik Cloud tenant origin, e.g.
#   ALLOWED_ORIGINS="https://your-tenant.us.qlikcloud.com"
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI(title="Genie Chat backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_client: GenieClient | None = None


def client() -> GenieClient:
    global _client
    if _client is None:
        _client = GenieClient()
    return _client


class ChatRequest(BaseModel):
    question: str
    conversation_id: str | None = None


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/api/chat")
def chat(req: ChatRequest, request: Request):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question is required")

    # Audit chokepoint: because OBO is unavailable under FRM, Databricks only ever sees
    # the service principal. Attribution to the real CBP user happens HERE. In production,
    # derive the user from the validated Qlik/SSO session rather than trusting a header.
    user = request.headers.get("X-Forwarded-User", "anonymous-demo-user")

    try:
        result = client().ask(req.question, req.conversation_id)
    except Exception as exc:  # noqa: BLE001 - surface a clean error to the widget
        logger.exception("Genie request failed")
        raise HTTPException(status_code=502, detail=f"Genie request failed: {exc}") from exc

    logger.info("audit user=%s conversation=%s question=%r", user, result.get("conversation_id"), req.question)
    return result


@app.get("/")
def index():
    # Serves the demo chat UI so the backend is runnable standalone.
    return FileResponse(FRONTEND_DIR / "index.html")
