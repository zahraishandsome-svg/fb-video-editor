#!/usr/bin/env python3
"""
FB Video Editor - download a TikTok, edit it, emit a Facebook-ready file.

Everything is CPU-only and cross-platform, so it runs the same on a Windows PC,
a GitHub Actions runner, or a VPS.

Pipeline (single encode pass):
  download -> transcribe -> build captions -> render -> params sidecar

Per-video randomisation is the point: if every upload carries an identical
transform, the transform itself becomes the pattern. Every run draws a fresh
seed and writes the drawn values to <out>.params.json so a render is reproducible.
"""
import argparse, json, math, os, random, re, subprocess, sys, shutil, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1080, 1920


def run(cmd, **kw):
    print("+", " ".join(str(c) for c in cmd[:6]), "..." if len(cmd) > 6 else "")
    return subprocess.run(cmd, check=True, **kw)


def probe(path, entries, stream=None):
    cmd = ["ffprobe", "-v", "error"]
    if stream:
        cmd += ["-select_streams", stream]
    cmd += ["-show_entries", entries, "-of", "default=nw=1:nk=1", path]
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()


# --------------------------------------------------------------------------
# 1. download
# --------------------------------------------------------------------------
def download(url, workdir, cookies=None):
    out = os.path.join(workdir, "src.mp4")
    # TikTok's bytevc1 (h265) renditions advertise an audio track they do not
    # actually carry - the resulting file is silent. Force h264 first.
    fmt = ("bv*[vcodec^=avc1]+ba/b[vcodec^=avc1]/"
           "bv*[vcodec^=h264]+ba/b[vcodec^=h264]/b")
    cmd = ["yt-dlp", "-f", fmt, "--merge-output-format", "mp4",
           "-o", out, "--no-playlist", url]
    if cookies and os.path.exists(cookies):
        cmd += ["--cookies", cookies]
    run(cmd)

    if not probe(out, "stream=codec_type", "a:0"):
        sys.exit("ERROR: downloaded file has no audio track")
    return out


# --------------------------------------------------------------------------
# 2. captions
# --------------------------------------------------------------------------
def transcribe_to_ass(src, workdir, speed, rnd):
    wav = os.path.join(workdir, "audio.wav")
    run(["ffmpeg", "-y", "-v", "error", "-i", src,
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav])

    ass = os.path.join(workdir, "captions.ass")
    # caption position jitters a little per video so the text block does not
    # land on identical pixel rows every time
    margin_v = rnd.randint(280, 320)
    env = dict(os.environ, CAPTION_MARGIN_V=str(margin_v))
    run([sys.executable, os.path.join(HERE, "make_captions.py"),
         wav, ass, str(speed)], env=env)
    return ass, margin_v


# --------------------------------------------------------------------------
# 3. the edit
# --------------------------------------------------------------------------
def build_filters(ass_path, dur, speed, p):
    """Return (video_filter, audio_filter).

    Geometry notes:
      * the frame is scaled up by MARGIN so rotation and drift have room
      * a micro-rotation is applied, then the centre is cropped back to 1080x1920
      * the crop origin drifts on two slow sine waves, so no two frames share
        the same geometry and per-frame hashes never settle
    """
    margin = p["margin"]
    sw = int(round(W * margin / 2)) * 2
    sh = int(round(H * margin / 2)) * 2

    # available slack for the drifting crop window
    slack_x = (sw - W) / 2.0
    slack_y = (sh - H) / 2.0
    ax = max(0.0, min(p["drift_x"], slack_x - 4))
    ay = max(0.0, min(p["drift_y"], slack_y - 4))

    cx = f"({sw}-{W})/2 + {ax:.1f}*sin(2*PI*t/{p['period_x']:.1f})"
    cy = f"({sh}-{H})/2 + {ay:.1f}*sin(2*PI*t/{p['period_y']:.1f} + {p['phase']:.2f})"

    ass_esc = ass_path.replace("\\", "/").replace(":", r"\:")

    v = [f"setpts=PTS/{speed}"]

    # Drop one frame every N to shift temporal alignment. Deliberately do NOT
    # re-time afterwards: leaving the PTS gap lets the trailing fps filter fill
    # it with a duplicate, so the frame sequence changes but total duration -
    # and therefore audio sync - is untouched. Re-timing here would shorten the
    # video by 1/N and drift roughly a second out of sync by the end.
    if p["drop_every"]:
        v.append(f"select='not(eq(mod(n\\,{p['drop_every']})\\,0))'")

    v += [
        f"scale={sw}:{sh}:flags=lanczos",
        f"rotate={p['rotate']:.5f}:ow=iw:oh=ih:c=black",
        f"crop={W}:{H}:'{cx}':'{cy}'",
        (f"eq=contrast={p['contrast']:.4f}:saturation={p['saturation']:.4f}"
         f":gamma={p['gamma']:.4f}:brightness={p['brightness']:.4f}"),
        (f"curves=r='0/{p['lift_r']:.3f} 0.5/0.5 1/0.995'"
         f":b='0/0 0.5/{p['mid_b']:.3f} 1/1'"),
        f"unsharp=5:5:{p['sharpen']:.2f}:5:5:0.0",
        f"noise=alls={p['grain']}:allf=t",
        f"subtitles={ass_esc}",
        "fps=30000/1001",          # 30 -> 29.97, a gentle temporal resample
        "format=yuv420p",
    ]

    # audio: tempo is the heavy lever; the EQ moves spectral detail, and a
    # very low room-tone bed keeps the noise floor from matching the source
    a = [
        f"asetrate=44100*{p['pitch']:.5f}",
        "aresample=44100",
        f"atempo={speed / p['pitch']:.6f}",
        f"equalizer=f={p['eq1_f']}:t=q:w=1.2:g={p['eq1_g']:.2f}",
        f"equalizer=f={p['eq2_f']}:t=q:w=1.2:g={p['eq2_g']:.2f}",
        f"equalizer=f={p['notch_f']}:t=q:w=0.35:g=-4.5",
        "loudnorm=I=-14:TP=-1.5:LRA=11",
    ]
    return ",".join(v), ",".join(a)


def draw_params(rnd, speed_base, jitter):
    speed = round(rnd.uniform(speed_base - jitter, speed_base + jitter), 4) if jitter else speed_base
    return {
        "speed": speed,
        "pitch": round(rnd.uniform(1.012, 1.028), 5),
        "margin": round(rnd.uniform(1.035, 1.055), 4),
        "drift_x": round(rnd.uniform(8, 16), 1),
        "drift_y": round(rnd.uniform(10, 22), 1),
        "period_x": round(rnd.uniform(23, 41), 1),
        "period_y": round(rnd.uniform(17, 37), 1),
        "phase": round(rnd.uniform(0, 6.28), 2),
        "rotate": round(rnd.choice([-1, 1]) * rnd.uniform(0.0035, 0.0075), 5),
        "contrast": round(rnd.uniform(1.045, 1.085), 4),
        "saturation": round(rnd.uniform(1.06, 1.14), 4),
        "gamma": round(rnd.uniform(1.015, 1.04), 4),
        "brightness": round(rnd.uniform(0.004, 0.014), 4),
        "lift_r": round(rnd.uniform(0.004, 0.014), 3),
        "mid_b": round(rnd.uniform(0.482, 0.496), 3),
        "sharpen": round(rnd.uniform(0.6, 0.9), 2),
        "grain": rnd.randint(1, 3),
        "drop_every": rnd.choice([0, 137, 149, 163, 179]),
        "eq1_f": rnd.choice([180, 220, 260, 300]),
        "eq1_g": round(rnd.uniform(-1.4, -0.5), 2),
        "eq2_f": rnd.choice([2600, 3100, 3600, 4200]),
        "eq2_g": round(rnd.uniform(0.4, 1.2), 2),
        "notch_f": rnd.choice([6300, 7100, 8200, 9400]),
        "crf": rnd.randint(19, 21),
        "keyint": rnd.choice([48, 54, 60, 66, 72]),
    }


def render(src, ass, out, p, preset):
    vf, af = build_filters(ass, None, p["speed"], p)
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stats",
        "-i", src,
        "-vf", vf, "-af", af,
        "-c:v", "libx264", "-preset", preset, "-crf", str(p["crf"]),
        "-profile:v", "high", "-level", "4.2",
        "-x264-params", f"keyint={p['keyint']}:min-keyint={p['keyint']//2}:scenecut=40",
        "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
        # strip every identifying string: container metadata AND the encoder
        # signature libx264/lavf normally bake into the file
        "-map_metadata", "-1",
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
        "-movflags", "+faststart",
        out,
    ]
    run(cmd)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", default="final.mp4")
    ap.add_argument("--speed", type=float, default=1.1)
    ap.add_argument("--jitter", type=float, default=0.02,
                    help="randomise speed by +/- this much (0 to pin it exactly)")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--cookies", default=None)
    ap.add_argument("--workdir", default=None)
    args = ap.parse_args()

    seed = args.seed if args.seed is not None else random.randrange(1, 2**31)
    rnd = random.Random(seed)

    workdir = args.workdir or tempfile.mkdtemp(prefix="fbedit_")
    os.makedirs(workdir, exist_ok=True)
    print(f"seed={seed}  workdir={workdir}")

    src = download(args.url, workdir, args.cookies)
    src_dur = float(probe(src, "format=duration") or 0)
    print(f"source: {src_dur:.1f}s")

    p = draw_params(rnd, args.speed, args.jitter)
    ass, margin_v = transcribe_to_ass(src, workdir, p["speed"], rnd)
    p["caption_margin_v"] = margin_v
    p["seed"] = seed
    p["preset"] = args.preset
    p["source_url"] = args.url

    render(src, ass, args.out, p, args.preset)

    out_dur = float(probe(args.out, "format=duration") or 0)
    p["source_duration"] = round(src_dur, 2)
    p["output_duration"] = round(out_dur, 2)
    p["output_size_mb"] = round(os.path.getsize(args.out) / 1048576, 2)

    with open(args.out + ".params.json", "w", encoding="utf-8") as f:
        json.dump(p, f, indent=2)

    print(f"\nOK -> {args.out}  ({p['output_size_mb']} MB, {out_dur:.1f}s)")
    print(f"params -> {args.out}.params.json")


if __name__ == "__main__":
    main()
