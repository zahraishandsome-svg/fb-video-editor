"""Background job runner.

One worker thread drains the queue so two renders never fight over the GPU.
Each stage writes its progress straight to the DB, which is what the phone
polls - no websockets needed for a single-operator tool.
"""
import os, random, re, subprocess, sys, threading, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import edit as E          # the pipeline built and tuned earlier
import store, publisher

_thread = None
_stop = threading.Event()

# Stage weights, so the bar moves at a believable rate rather than sitting at 0
# through the two slow stages. Roughly matches measured timings: a 2.5 min video
# spends ~10s downloading, ~18s in whisper, ~31s rendering.
STAGES = {"download": (0, 15), "transcribe": (15, 45), "render": (45, 97), "finish": (97, 100)}


def _span(stage, frac):
    lo, hi = STAGES[stage]
    return round(lo + (hi - lo) * max(0.0, min(1.0, frac)), 1)


def _ffmpeg_with_progress(cmd, jid, total_seconds):
    """Run ffmpeg, translating its -progress stream into a job percentage."""
    cmd = list(cmd) + ["-progress", "pipe:1", "-nostats"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, bufsize=1)
    last = 0.0
    for line in p.stdout:
        m = re.match(r"out_time_ms=(\d+)", line.strip())
        if m and total_seconds:
            secs = int(m.group(1)) / 1_000_000
            pct = _span("render", secs / total_seconds)
            if pct - last >= 1:
                store.update_job(jid, progress=pct)
                last = pct
    p.wait()
    err = p.stderr.read() if p.stderr else ""
    return p.returncode, err


def _run_job(job):
    jid = job["id"]
    ch = store.get_channel(job["channel_id"]) or {}
    outdir = store.get_setting("output_dir")
    workdir = os.path.join(outdir, f"job_{jid}")
    os.makedirs(workdir, exist_ok=True)

    seed = random.randrange(1, 2**31)
    rnd = random.Random(seed)

    # ---- download -------------------------------------------------------
    store.update_job(jid, status="running", stage="download", progress=_span("download", 0.1))
    cookies = store.get_setting("cookies_path") or None
    src = E.download(job["source_url"], workdir, cookies)
    src_dur = float(E.probe(src, "format=duration") or 0)
    store.update_job(jid, progress=_span("download", 1.0))

    # ---- parameters + captions -----------------------------------------
    p = E.draw_params(rnd, float(ch.get("speed", 1.1)), float(ch.get("jitter", 0.02)))
    p["seed"] = seed
    p["source_url"] = job["source_url"]

    if ch.get("captions", 1):
        store.update_job(jid, stage="transcribe", progress=_span("transcribe", 0.05))
        ass, margin_v = E.transcribe_to_ass(src, workdir, p["speed"], rnd)
        p["caption_margin_v"] = margin_v
    else:
        ass = None
    store.update_job(jid, progress=_span("transcribe", 1.0))

    # ---- render ---------------------------------------------------------
    encoder = ch.get("encoder", "auto")
    if encoder == "auto":
        encoder = "nvenc" if E.has_nvenc() else "x264"
    p["encoder"] = encoder

    out = os.path.join(outdir, f"job_{jid}.mp4")
    vf, af = E.build_filters(ass, None, p["speed"], p)
    if ass is None:
        # drop just the subtitles link out of the chain, keep everything else
        vf = ",".join(x for x in vf.split(",") if not x.startswith("subtitles="))

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-i", src, "-vf", vf, "-af", af,
           *E.video_codec_args(p, encoder, "medium"),
           "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
           "-map_metadata", "-1",
           "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
           "-metadata:s:v", "encoder=", "-metadata:s:a", "encoder=",
           "-movflags", "+faststart", out]

    store.update_job(jid, stage="render", progress=_span("render", 0))
    rc, err = _ffmpeg_with_progress(cmd, jid, src_dur / p["speed"])
    if rc != 0:
        raise RuntimeError(f"ffmpeg failed: {err.strip()[:400]}")

    # ---- thumbnail + stats ---------------------------------------------
    store.update_job(jid, stage="finish", progress=_span("finish", 0.3))
    thumb = os.path.join(outdir, f"job_{jid}.jpg")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "3", "-i", out,
                    "-frames:v", "1", "-vf", "scale=270:-2", "-q:v", "4", thumb],
                   capture_output=True)

    dur = float(E.probe(out, "format=duration") or 0)
    size = round(os.path.getsize(out) / 1048576, 2)
    p["output_duration"] = round(dur, 2)
    p["output_size_mb"] = size

    store.update_job(jid, out_path=out, thumb=thumb, duration=dur, size_mb=size, params=p)

    # ---- publish (placeholder) -----------------------------------------
    try:
        publisher.publish(ch, store.get_job(jid))
        store.update_job(jid, status="posted", stage="posted", progress=100,
                         finished_at=time.time())
    except publisher.NotConfigured as e:
        # Not an error - the render succeeded and is waiting for Facebook to be
        # wired up. Surfaced as 'ready' so nothing looks broken.
        store.update_job(jid, status="ready", stage=str(e), progress=100,
                         finished_at=time.time())


def _loop():
    store.reset_stuck()
    while not _stop.is_set():
        job = store.next_queued()
        if not job:
            _stop.wait(2)
            continue
        try:
            _run_job(job)
        except Exception as e:
            traceback.print_exc()
            store.update_job(job["id"], status="failed", stage="failed",
                             error=str(e)[:600], finished_at=time.time())


def start():
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, daemon=True, name="render-worker")
    _thread.start()


def stop():
    _stop.set()
