"""Portal API + static host.

Runs on the PC that does the rendering and is reached from the phone over the
local network, so it binds 0.0.0.0 rather than localhost.
"""
import os, socket, subprocess, sys

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import store, worker, publisher

store.init()
app = FastAPI(title="Repost Studio")


# ----------------------------- models -----------------------------
class ChannelIn(BaseModel):
    name: str
    tiktok_url: str
    fb_page_name: str = ""
    fb_page_id: str = ""
    speed: float = 1.1
    jitter: float = 0.02
    captions: int = 1
    encoder: str = "auto"
    per_day: int = 1
    post_times: list[str] = ["14:00"]
    enabled: int = 1


class ChannelPatch(BaseModel):
    name: str | None = None
    tiktok_url: str | None = None
    fb_page_name: str | None = None
    fb_page_id: str | None = None
    speed: float | None = None
    jitter: float | None = None
    captions: int | None = None
    encoder: str | None = None
    per_day: int | None = None
    post_times: list[str] | None = None
    enabled: int | None = None


class JobIn(BaseModel):
    channel_id: int
    url: str
    title: str = ""


class SettingsIn(BaseModel):
    cookies_path: str | None = None
    output_dir: str | None = None


# ----------------------------- api --------------------------------
@app.get("/api/overview")
def overview():
    return {"stats": store.stats(), "fb_ready": publisher.is_configured(None)}


@app.get("/api/channels")
def channels():
    return store.list_channels()


@app.post("/api/channels")
def add_channel(c: ChannelIn):
    cid = store.create_channel(c.model_dump())
    return store.get_channel(cid)


@app.patch("/api/channels/{cid}")
def patch_channel(cid: int, c: ChannelPatch):
    data = {k: v for k, v in c.model_dump().items() if v is not None}
    store.update_channel(cid, data)
    return store.get_channel(cid)


@app.delete("/api/channels/{cid}")
def remove_channel(cid: int):
    store.delete_channel(cid)
    return {"ok": True}


@app.get("/api/jobs")
def jobs(limit: int = 60, channel_id: int | None = None):
    return store.list_jobs(limit, channel_id)


@app.post("/api/jobs")
def add_job(j: JobIn):
    if not store.get_channel(j.channel_id):
        raise HTTPException(404, "channel not found")
    jid = store.create_job(j.channel_id, j.url.strip(), j.title)
    return store.get_job(jid)


@app.post("/api/jobs/{jid}/retry")
def retry(jid: int):
    if not store.get_job(jid):
        raise HTTPException(404, "job not found")
    store.update_job(jid, status="queued", progress=0, stage="", error="")
    return store.get_job(jid)


@app.get("/api/jobs/{jid}/video")
def job_video(jid: int):
    j = store.get_job(jid)
    if not j or not j["out_path"] or not os.path.exists(j["out_path"]):
        raise HTTPException(404, "no render")
    return FileResponse(j["out_path"], media_type="video/mp4")


@app.get("/api/jobs/{jid}/thumb")
def job_thumb(jid: int):
    j = store.get_job(jid)
    if not j or not j["thumb"] or not os.path.exists(j["thumb"]):
        raise HTTPException(404, "no thumb")
    return FileResponse(j["thumb"], media_type="image/jpeg")


@app.get("/api/settings")
def settings():
    s = store.all_settings()
    s["nvenc"] = _nvenc_cached()
    return s


@app.post("/api/settings")
def save_settings(s: SettingsIn):
    for k, v in s.model_dump().items():
        if v is not None:
            store.set_setting(k, v)
    return store.all_settings()


_nvenc = None


def _nvenc_cached():
    global _nvenc
    if _nvenc is None:
        sys.path.insert(0, os.path.dirname(HERE))
        import edit as E
        _nvenc = E.has_nvenc()
    return _nvenc


# ----------------------------- static -----------------------------
STATIC = os.path.join(HERE, "static")
app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")


@app.on_event("startup")
def _startup():
    worker.start()


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8791))
    print("\n  Repost Studio")
    print(f"  on this PC : http://localhost:{port}")
    print(f"  on phone   : http://{lan_ip()}:{port}   (same Wi-Fi)\n")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
