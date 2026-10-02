"""Minimal Databricks Genie Conversations API client.

Auth is resolved by the Databricks SDK `Config`, which transparently supports:
  - service principal OAuth (M2M): DATABRICKS_HOST + DATABRICKS_CLIENT_ID + DATABRICKS_CLIENT_SECRET
  - a local profile for dev:        DATABRICKS_CONFIG_PROFILE
  - a PAT:                          DATABRICKS_HOST + DATABRICKS_TOKEN

The credential NEVER leaves this process. The browser talks only to the FastAPI
backend (see app.py); it never sees a Databricks token.
"""

import os
import time

import requests
from databricks.sdk.core import Config

POLL_INTERVAL_SECONDS = 2
POLL_TIMEOUT_SECONDS = 180
TERMINAL_STATES = {"COMPLETED", "FAILED", "CANCELLED"}


class GenieClient:
    def __init__(self, space_id: str | None = None, config: Config | None = None):
        self._cfg = config or Config()
        self.space_id = space_id or os.environ["GENIE_SPACE_ID"]
        self.host = self._cfg.host.rstrip("/")

    # The SDK mints/refreshes the bearer token per call (OAuth M2M, PAT, or profile).
    def _headers(self) -> dict:
        return {**self._cfg.authenticate(), "Content-Type": "application/json"}

    def _base(self) -> str:
        return f"{self.host}/api/2.0/genie/spaces/{self.space_id}"

    def ask(self, question: str, conversation_id: str | None = None) -> dict:
        """Ask Genie a question. Pass conversation_id to continue a thread."""
        if conversation_id:
            url = f"{self._base()}/conversations/{conversation_id}/messages"
        else:
            url = f"{self._base()}/start-conversation"

        resp = requests.post(url, headers=self._headers(), json={"content": question}, timeout=30)
        resp.raise_for_status()
        body = resp.json()

        # Response shape varies slightly between start-conversation and create-message.
        conv = body.get("conversation") or {}
        msg = body.get("message") or body
        conversation_id = body.get("conversation_id") or conv.get("id") or conversation_id
        message_id = body.get("message_id") or msg.get("id") or msg.get("message_id")

        final = self._poll(conversation_id, message_id)
        return self._format(conversation_id, message_id, final)

    def _poll(self, conversation_id: str, message_id: str) -> dict:
        url = f"{self._base()}/conversations/{conversation_id}/messages/{message_id}"
        deadline = time.time() + POLL_TIMEOUT_SECONDS
        while True:
            resp = requests.get(url, headers=self._headers(), timeout=30)
            resp.raise_for_status()
            msg = resp.json()
            if msg.get("status") in TERMINAL_STATES or time.time() > deadline:
                return msg
            time.sleep(POLL_INTERVAL_SECONDS)

    def _format(self, conversation_id: str, message_id: str, msg: dict) -> dict:
        status = msg.get("status")
        out = {
            "conversation_id": conversation_id,
            "message_id": message_id,
            "status": status,
            "answer": None,
            "sql": None,
            "columns": None,
            "rows": None,
            "error": None,
        }

        if status == "FAILED":
            err = msg.get("error") or {}
            out["error"] = err.get("error") or str(err) or "Genie returned FAILED"
            return out

        # Genie returns text and SQL in SEPARATE attachments (verified against the live
        # API). Prefer the natural-language text; fall back to the query description.
        text_parts: list[str] = []
        desc_parts: list[str] = []
        for att in msg.get("attachments") or []:
            text = att.get("text") or {}
            if text.get("content"):
                text_parts.append(text["content"])

            query = att.get("query")
            if query:
                out["sql"] = query.get("query")
                if query.get("description"):
                    desc_parts.append(query["description"])
                att_id = att.get("attachment_id") or att.get("id")
                if att_id:
                    self._attach_query_result(conversation_id, message_id, att_id, out)

        out["answer"] = "\n\n".join(text_parts) if text_parts else ("\n\n".join(desc_parts) or None)
        return out

    def _attach_query_result(self, conversation_id: str, message_id: str, attachment_id: str, out: dict) -> None:
        url = (
            f"{self._base()}/conversations/{conversation_id}"
            f"/messages/{message_id}/attachments/{attachment_id}/query-result"
        )
        try:
            resp = requests.get(url, headers=self._headers(), timeout=60)
            resp.raise_for_status()
            sr = (resp.json() or {}).get("statement_response") or {}
            columns = (((sr.get("manifest") or {}).get("schema") or {}).get("columns")) or []
            out["columns"] = [c.get("name") for c in columns]
            out["rows"] = ((sr.get("result") or {}).get("data_array")) or []
        except requests.HTTPError:
            # Non-fatal for the demo: keep the text answer even if result fetch fails.
            pass
