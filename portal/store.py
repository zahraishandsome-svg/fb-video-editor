"""SQLite store for the portal. One file, no server, no migrations to run."""
import json, os, sqlite3, threading, time

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "portal.db")
_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS channels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  tiktok_url    TEXT NOT NULL,
  fb_page_name  TEXT DEFAULT '',
  fb_page_id    TEXT DEFAULT '',
  speed         REAL DEFAULT 1.1,
  jitter        REAL DEFAULT 0.02,
  captions      INTEGER DEFAULT 1,
  encoder       TEXT DEFAULT 'auto',
  per_day       INTEGER DEFAULT 1,
  post_times    TEXT DEFAULT '["14:00"]',
  enabled       INTEGER DEFAULT 1,
  created_at    REAL
);

CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    INTEGER,
  source_url    TEXT,
  title         TEXT DEFAULT '',
  status        TEXT DEFAULT 'queued',
  stage         TEXT DEFAULT '',
  progress      REAL DEFAULT 0,
  out_path      TEXT DEFAULT '',
  thumb         TEXT DEFAULT '',
  duration      REAL DEFAULT 0,
  size_mb       REAL DEFAULT 0,
  params        TEXT DEFAULT '{}',
  error         TEXT DEFAULT '',
  created_at    REAL,
  finished_at   REAL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
"""

DEFAULTS = {
    "cookies_path": "",
    "output_dir": os.path.join(os.path.dirname(os.path.abspath(__file__)), "renders"),
}


def conn():
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    return c


def init():
    with _lock, conn() as c:
        c.executescript(SCHEMA)
        for k, v in DEFAULTS.items():
            c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v))
    os.makedirs(get_setting("output_dir"), exist_ok=True)


# ---------- settings ----------
def get_setting(key, default=""):
    with conn() as c:
        r = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return r["value"] if r else default


def set_setting(key, value):
    with _lock, conn() as c:
        c.execute("INSERT INTO settings (key, value) VALUES (?,?) "
                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))


def all_settings():
    with conn() as c:
        return {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM settings")}


# ---------- channels ----------
CHANNEL_FIELDS = ("name", "tiktok_url", "fb_page_name", "fb_page_id", "speed",
                  "jitter", "captions", "encoder", "per_day", "post_times", "enabled")


def list_channels():
    with conn() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM channels ORDER BY id DESC")]
    for r in rows:
        r["post_times"] = json.loads(r["post_times"] or "[]")
        with conn() as c:
            r["job_count"] = c.execute(
                "SELECT COUNT(*) n FROM jobs WHERE channel_id=?", (r["id"],)).fetchone()["n"]
    return rows


def get_channel(cid):
    with conn() as c:
        r = c.execute("SELECT * FROM channels WHERE id=?", (cid,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["post_times"] = json.loads(d["post_times"] or "[]")
    return d


def create_channel(data):
    d = {k: data.get(k) for k in CHANNEL_FIELDS}
    d["post_times"] = json.dumps(data.get("post_times") or ["14:00"])
    d["created_at"] = time.time()
    cols = ", ".join(d.keys())
    marks = ", ".join("?" for _ in d)
    with _lock, conn() as c:
        cur = c.execute(f"INSERT INTO channels ({cols}) VALUES ({marks})", tuple(d.values()))
        return cur.lastrowid


def update_channel(cid, data):
    sets, vals = [], []
    for k in CHANNEL_FIELDS:
        if k in data:
            v = json.dumps(data[k]) if k == "post_times" else data[k]
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        return
    vals.append(cid)
    with _lock, conn() as c:
        c.execute(f"UPDATE channels SET {', '.join(sets)} WHERE id=?", tuple(vals))


def delete_channel(cid):
    with _lock, conn() as c:
        c.execute("DELETE FROM channels WHERE id=?", (cid,))


# ---------- jobs ----------
def create_job(channel_id, source_url, title=""):
    with _lock, conn() as c:
        cur = c.execute(
            "INSERT INTO jobs (channel_id, source_url, title, status, created_at) "
            "VALUES (?,?,?,'queued',?)", (channel_id, source_url, title, time.time()))
        return cur.lastrowid


def update_job(jid, **fields):
    if not fields:
        return
    if "params" in fields and not isinstance(fields["params"], str):
        fields["params"] = json.dumps(fields["params"])
    sets = ", ".join(f"{k}=?" for k in fields)
    with _lock, conn() as c:
        c.execute(f"UPDATE jobs SET {sets} WHERE id=?", (*fields.values(), jid))


def get_job(jid):
    with conn() as c:
        r = c.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
    return dict(r) if r else None


def list_jobs(limit=60, channel_id=None):
    q = ("SELECT j.*, c.name AS channel_name, c.fb_page_name "
         "FROM jobs j LEFT JOIN channels c ON c.id = j.channel_id ")
    args = []
    if channel_id:
        q += "WHERE j.channel_id=? "
        args.append(channel_id)
    q += "ORDER BY j.id DESC LIMIT ?"
    args.append(limit)
    with conn() as c:
        return [dict(r) for r in c.execute(q, tuple(args))]


def next_queued():
    with _lock, conn() as c:
        r = c.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY id ASC LIMIT 1").fetchone()
        if not r:
            return None
        c.execute("UPDATE jobs SET status='running' WHERE id=?", (r["id"],))
    return dict(r)


def reset_stuck():
    """Anything left mid-flight by a crash or restart goes back in the queue."""
    with _lock, conn() as c:
        c.execute("UPDATE jobs SET status='queued', progress=0, stage='' WHERE status='running'")


def stats():
    with conn() as c:
        row = c.execute(
            "SELECT "
            " (SELECT COUNT(*) FROM channels WHERE enabled=1) AS channels,"
            " (SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')) AS active,"
            " (SELECT COUNT(*) FROM jobs WHERE status='ready') AS ready,"
            " (SELECT COUNT(*) FROM jobs WHERE status='failed') AS failed,"
            " (SELECT COUNT(*) FROM jobs WHERE status='posted') AS posted"
        ).fetchone()
    return dict(row)
