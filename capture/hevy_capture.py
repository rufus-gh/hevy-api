"""
mitmproxy addon to capture Hevy app traffic.

Usage:
    mitmweb -s capture/hevy_capture.py      # web UI at http://127.0.0.1:8081
    # or headless:
    mitmdump -s capture/hevy_capture.py

It records every request/response whose host matches a Hevy domain into
capture/flows/hevy-capture.jsonl (one JSON object per line) and prints a live
one-line summary so you can see it working. Bodies are decoded to text when
possible and pretty-kept as raw strings otherwise.

Each line looks like:
{
  "ts": 1719600000.123,
  "method": "POST",
  "url": "https://api.hevyapp.com/...",
  "host": "api.hevyapp.com",
  "path": "/workouts",
  "req_headers": {...},
  "req_body": "...",            # decoded text or null
  "status": 200,
  "res_headers": {...},
  "res_body": "..."             # decoded text or null
}
"""
import json
import os
from mitmproxy import http, ctx

# Hosts we care about. Add more if you see Hevy talking to other domains.
HEVY_HOST_SUBSTRINGS = ("hevy", "hevyapp")

OUT_DIR = os.path.join(os.path.dirname(__file__), "flows")
OUT_FILE = os.path.join(OUT_DIR, "hevy-capture.jsonl")


def _is_hevy(host: str) -> bool:
    host = (host or "").lower()
    return any(s in host for s in HEVY_HOST_SUBSTRINGS)


def _body_text(message) -> str | None:
    if not message or not message.content:
        return None
    try:
        return message.get_text(strict=False)
    except Exception:
        try:
            return message.content.decode("utf-8", "replace")
        except Exception:
            return None


class HevyCapture:
    def __init__(self):
        os.makedirs(OUT_DIR, exist_ok=True)
        self.count = 0

    def response(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host
        if not _is_hevy(host):
            return

        record = {
            "ts": flow.request.timestamp_start,
            "method": flow.request.method,
            "url": flow.request.pretty_url,
            "host": host,
            "path": flow.request.path,
            "req_headers": dict(flow.request.headers),
            "req_body": _body_text(flow.request),
            "status": flow.response.status_code,
            "res_headers": dict(flow.response.headers),
            "res_body": _body_text(flow.response),
        }

        with open(OUT_FILE, "a") as f:
            f.write(json.dumps(record) + "\n")

        self.count += 1
        ctx.log.alert(
            f"[hevy] #{self.count} {record['method']} {record['status']} {record['path']}"
        )

        # Automatically trigger token update if this record contains auth tokens
        is_refresh_token = "/auth/refresh_token" in record.get("path", "") and record.get("status") == 200 and record.get("res_body")
        has_auth_header = any(k.lower() == "authorization" for k in record.get("req_headers", {}).keys())

        if is_refresh_token or has_auth_header:
            import subprocess
            try:
                script_path = os.path.join(os.path.dirname(__file__), "use-latest-token.mjs")
                subprocess.run(
                    ["node", script_path],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except Exception as e:
                ctx.log.error(f"[hevy] Failed to run auto-token update: {e}")


addons = [HevyCapture()]
