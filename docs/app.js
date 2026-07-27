/* ══════════════════════════════════════════════════════════════
   Repost Studio

   One source file, two ways to run — the same split the Million
   Dollars App uses:

     local   served by portal/server.py on :8791. Renders run on this
             PC with the GPU: ~50s for a 2:17 video.
     hosted  served from GitHub Pages. No server of ours anywhere.
             Renders run on GitHub Actions (~7 min) and come back as
             release assets. Works from any network, any device.

   Everything below the Backend split is shared, so the interface is
   identical either way.
   ══════════════════════════════════════════════════════════════ */

const OWNER = "zahraishandsome-svg";
const REPO  = "fb-video-editor";
const WORKFLOW = "render.yml";
const RELEASE_TAG = "renders";

const MODE = location.port === "8791" ? "local" : "hosted";

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtDur = (s) => {
  if (!s) return "—";
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};
const ago = (ts) => {
  if (!ts) return "";
  const d = Date.now() / 1000 - (typeof ts === "string" ? Date.parse(ts) / 1000 : ts);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};
const handle = (u) => String(u || "")
  .replace(/^https?:\/\/(www\.)?tiktok\.com\//, "").replace(/\/video\/.*$/, "");

const state = { channels: [], jobs: [], stats: {}, editing: null, view: "queue" };

/* ═══════════════════════ token (hosted only) ═══════════════════════

   The token never ships inside this file. It arrives once per device
   through a setup link (#setup=<token>) or the setup screen, and lives
   in this browser's localStorage only — a URL fragment is never sent to
   the server.                                                          */

const TOK_KEY = "repost_studio_token";

function loadToken() {
  const m = location.hash.match(/setup=([A-Za-z0-9_-]+)/);
  if (m) {
    localStorage.setItem(TOK_KEY, m[1]);
    history.replaceState(null, "", location.pathname);
  }
  return localStorage.getItem(TOK_KEY) || "";
}
let TOKEN = MODE === "hosted" ? loadToken() : "";

/* ═════════════════════════ local backend ═════════════════════════ */

const LocalBackend = {
  label: "this PC · GPU",

  async load() {
    const [ov, chans, jobs] = await Promise.all([
      fetch("/api/overview").then((r) => r.json()),
      fetch("/api/channels").then((r) => r.json()),
      fetch("/api/jobs?limit=40").then((r) => r.json()),
    ]);
    return {
      stats: ov.stats,
      channels: chans,
      jobs: jobs.map((j) => ({
        id: j.id,
        channel: j.channel_name,
        url: j.source_url,
        status: j.status,
        stage: j.stage,
        progress: j.progress,
        duration: j.duration,
        size_mb: j.size_mb,
        error: j.error,
        created: j.created_at,
        params: (() => { try { return JSON.parse(j.params || "{}"); } catch { return {}; } })(),
        video: j.out_path ? `/api/jobs/${j.id}/video` : "",
        thumb: j.thumb ? `/api/jobs/${j.id}/thumb` : "",
      })),
    };
  },

  async saveChannel(body, id) {
    const r = await fetch(id ? `/api/channels/${id}` : "/api/channels", {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
  },

  async deleteChannel(id) {
    await fetch(`/api/channels/${id}`, { method: "DELETE" });
  },

  async queue(channel, url) {
    const r = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: channel.id, url }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
  },

  async retry(id) {
    await fetch(`/api/jobs/${id}/retry`, { method: "POST" });
  },

  async settings() {
    return fetch("/api/settings").then((r) => r.json());
  },

  async saveSettings(body) {
    await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
};

/* ════════════════════════ github backend ════════════════════════

   Reads state straight out of the repo and drives renders through the
   Actions API. Nothing of ours sits between the phone and GitHub.     */

const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const RAW = (p) => `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${p}?t=${Date.now()}`;

const GitHubBackend = {
  label: "GitHub Actions",

  async gh(path, opts = {}) {
    const r = await fetch(path.startsWith("http") ? path : API + path, {
      ...opts,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 401 || r.status === 403) throw new Error("Token rejected — check it in Setup");
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 140)}`);
    return r.status === 204 ? null : r.json();
  },

  async readJson(path, fallback) {
    try {
      const r = await fetch(RAW(path));
      if (!r.ok) return fallback;
      return await r.json();
    } catch { return fallback; }
  },

  async load() {
    const [chanFile, jobFile, runs] = await Promise.all([
      this.readJson("state/channels.json", { channels: [] }),
      this.readJson("state/jobs.json", { jobs: [] }),
      TOKEN ? this.gh(`/actions/workflows/${WORKFLOW}/runs?per_page=15`).catch(() => null) : null,
    ]);

    const channels = chanFile.channels || [];
    const done = (jobFile.jobs || []).slice().reverse();

    // A run that has not finished yet is not in jobs.json, so surface it from
    // the Actions API. Match on the run id we stamp into the job entries.
    const seen = new Set(done.map((j) => String(j.run_id)));
    const live = (runs?.workflow_runs || [])
      .filter((r) => r.status !== "completed" && !seen.has(String(r.id)))
      .map((r) => ({
        id: r.id, run_id: r.id,
        channel: r.display_title?.replace(/^Render video:?\s*/i, "") || "Render",
        url: "", status: "running",
        stage: r.status === "queued" ? "waiting for a runner" : "rendering",
        progress: r.status === "queued" ? 4 : 50,
        created: r.created_at, params: {}, video: "", thumb: "",
        html_url: r.html_url,
      }));

    const jobs = [...live, ...done];
    return {
      channels,
      jobs,
      stats: {
        channels: channels.filter((c) => c.enabled !== 0).length,
        active: live.length,
        ready: done.filter((j) => j.status === "ready").length,
        failed: done.filter((j) => j.status === "failed").length,
      },
    };
  },

  /** Channels live in the repo, so the phone edits them through the
      Contents API. Needs the file's current sha, hence the read first. */
  async writeChannels(channels, message) {
    let sha;
    try {
      const meta = await this.gh("/contents/state/channels.json");
      sha = meta.sha;
    } catch { /* first write, no file yet */ }
    const content = btoa(unescape(encodeURIComponent(
      JSON.stringify({ channels }, null, 2) + "\n")));
    await this.gh("/contents/state/channels.json", {
      method: "PUT",
      body: { message, content, sha, branch: "main" },
    });
  },

  async saveChannel(body, id) {
    const channels = state.channels.slice();
    if (id) {
      const i = channels.findIndex((c) => c.id === id);
      channels[i] = { ...channels[i], ...body };
    } else {
      channels.push({ ...body, id: "c" + Date.now().toString(36), enabled: 1 });
    }
    await this.writeChannels(channels, `portal: ${id ? "update" : "add"} channel ${body.name}`);
  },

  async deleteChannel(id) {
    await this.writeChannels(state.channels.filter((c) => c.id !== id), "portal: delete channel");
  },

  async queue(channel, url) {
    await this.gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      body: {
        ref: "main",
        inputs: {
          url,
          channel: channel.name,
          speed: String(channel.speed ?? 1.1),
          jitter: String(channel.jitter ?? 0.02),
          captions: channel.captions ? "true" : "false",
        },
      },
    });
  },

  async retry(job) {
    if (job.url) return this.queue({ name: job.channel, speed: 1.1, jitter: 0.02, captions: 1 }, job.url);
    throw new Error("No source URL stored for this job");
  },

  async settings() {
    return { hosted: true, token: TOKEN ? "configured" : "not set" };
  },
};

const Backend = MODE === "local" ? LocalBackend : GitHubBackend;

/* ═══════════════════════════ toast ═══════════════════════════ */
let toastT;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 3600);
}

/* ════════════════════════════ nav ════════════════════════════ */
const CRUMB = { queue: "Render queue", channels: "Channels", setup: "Setup" };

function goto(view) {
  state.view = view;
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== view));
  $$(".nav[data-goto]").forEach((n) => n.classList.toggle("on", n.dataset.goto === view));
  $("#crumb").textContent = CRUMB[view] || view;
  closeDrawer();
  scrollTo(0, 0);
}
document.addEventListener("click", (e) => {
  const n = e.target.closest(".nav[data-goto]");
  if (n) goto(n.dataset.goto);
});

const openDrawer  = () => { $("#sb").classList.add("open");    $("#scrim2").classList.add("on"); };
const closeDrawer = () => { $("#sb").classList.remove("open"); $("#scrim2").classList.remove("on"); };
$("#hamb").addEventListener("click", openDrawer);
$("#scrim2").addEventListener("click", closeDrawer);
addEventListener("scroll", () => $("#tbar").classList.toggle("stuck", scrollY > 4), { passive: true });

/* ══════════════════════════ modals ═══════════════════════════ */
let openM = null;
let blobUrl = null;

function show(id) { openM = $(id); $("#scrim").hidden = false; openM.hidden = false; }
function close() {
  if (!openM) return;
  const v = $("#pvVideo");
  if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  $("#pvNote").hidden = true;
  openM.hidden = true; $("#scrim").hidden = true; openM = null;
}

/** Play a finished render.
 *
 *  Release assets come back as application/octet-stream whatever the file is
 *  called. Chrome sniffs the container and plays anyway; iOS Safari refuses and
 *  shows a struck-through play button. So: try the URL directly, and if the
 *  element errors, pull the bytes down and hand them back as a typed blob,
 *  which sidesteps the server's header entirely. */
function playInto(v, url) {
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  const note = $("#pvNote");
  note.hidden = true;

  v.onerror = async () => {
    v.onerror = null;
    note.textContent = "Loading video…";
    note.hidden = false;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      const buf = await r.arrayBuffer();
      blobUrl = URL.createObjectURL(new Blob([buf], { type: "video/mp4" }));
      v.src = blobUrl;
      v.load();
      note.hidden = true;
    } catch (e) {
      note.textContent = "Could not load the video here — use Save to open it.";
      note.hidden = false;
    }
  };

  v.src = url;
  v.load();
}
$("#scrim").addEventListener("click", close);
document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(); closeDrawer(); } });

/* ════════════════════════ rendering ══════════════════════════ */
const STAGE = { download: "downloading", transcribe: "captions", render: "rendering", finish: "finishing" };
const BADGE = { running: "b-run", queued: "b-que", ready: "b-ok", posted: "b-ok", failed: "b-err" };

function renderStats() {
  const s = state.stats;
  const cells = [
    ["channels", s.channels ?? 0, "active pairings", ""],
    ["rendering", s.active ?? 0, (s.active ?? 0) ? "in progress" : "nothing running", (s.active ?? 0) ? "act" : ""],
    ["ready", s.ready ?? 0, "waiting to post", (s.ready ?? 0) ? "ok" : ""],
    ["failed", s.failed ?? 0, (s.failed ?? 0) ? "needs a retry" : "none", (s.failed ?? 0) ? "bad" : ""],
  ];
  $("#stats").innerHTML = cells.map(([lb, vl, ft, cls], i) =>
    `<div class="stat ${cls}" style="animation-delay:${i * 40}ms">
       <div class="lb">${lb}</div><div class="vl">${vl}</div><div class="ft">${ft}</div></div>`).join("");

  const busy = (s.active ?? 0) > 0;
  const run = state.jobs.find((j) => j.status === "running");
  $("#beat").className = "beat" + (busy ? " busy" : (s.failed ? " err" : ""));
  $("#beatTxt").textContent = busy ? (STAGE[run?.stage] || run?.stage || "rendering") : "idle";
  $("#sbPip").className = "pip " + (busy ? "a" : "g");
  $("#sbFoot").textContent = Backend.label;
  $("#navQueueN").textContent = state.jobs.length || "";
  $("#navChanN").textContent = state.channels.length || "";
  $("#jobsN").textContent = state.jobs.length ? `· ${state.jobs.length}` : "";
}

function jobCard(j, i) {
  const running = j.status === "running";
  const label = running ? (STAGE[j.stage] || j.stage || "rendering") : j.status;
  const thumb = j.thumb
    ? `<img class="thumb" src="${esc(j.thumb)}" alt="" loading="lazy">`
    : `<div class="thumb ph${running ? " load" : ""}">${running ? "" : "NO<br>FILE"}</div>`;

  const mets = [];
  if (running && MODE === "local") mets.push(["progress", Math.round(j.progress) + "%"]);
  if (j.duration) mets.push(["length", fmtDur(j.duration)]);
  if (j.size_mb) mets.push(["size", j.size_mb + " MB"]);
  mets.push(["added", ago(j.created)]);

  const acts = [];
  if (j.video) acts.push(`<button class="btn" data-preview="${j.id}">
    <svg viewBox="0 0 24 24"><path d="M9 7l9 5-9 5z"/></svg><span>Preview</span></button>`);
  if (j.video) acts.push(`<a class="btn" href="${esc(j.video)}" download target="_blank" rel="noopener">
    <svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 11L12 15.5 16.5 11M5 19h14"/></svg><span>Save</span></a>`);
  if (j.status === "failed") acts.push(`<button class="btn" data-retry="${j.id}">
    <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.6"/><path d="M20 5v6h-6"/></svg><span>Retry</span></button>`);
  if (running && j.html_url) acts.push(`<a class="btn" href="${esc(j.html_url)}" target="_blank" rel="noopener">
    <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg><span>Log</span></a>`);

  return `<article class="card" style="animation-delay:${Math.min(i, 8) * 35}ms">
    <div class="rbar" style="width:${running ? j.progress : 0}%"></div>
    <div class="job">${thumb}
      <div class="jb">
        <div class="jb-top">
          <div style="min-width:0">
            <div class="jb-nm">${esc(j.channel || "Render")}</div>
            <div class="jb-src">${esc(handle(j.url) || j.url || "—")}</div>
          </div>
          <span class="badge ${BADGE[j.status] || "b-off"}">${esc(label)}</span>
        </div>
        <div class="mets">${mets.map(([k, v]) =>
          `<div class="met"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join("")}</div>
        ${j.error ? `<div class="err">${esc(j.error)}</div>` : ""}
        ${acts.length ? `<div class="jb-foot">${acts.join("")}</div>` : ""}
      </div></div></article>`;
}

function renderJobs() {
  $("#jobs").innerHTML = state.jobs.length
    ? state.jobs.map(jobCard).join("")
    : `<div class="empty"><b>Nothing rendered yet</b><span>Add a channel, then queue a TikTok URL.</span></div>`;
}

function chanCard(c, i) {
  const fb = c.fb_page ? esc(c.fb_page) : `<span class="none">no page set</span>`;
  const initial = esc((c.name || "?").trim()[0] || "?").toUpperCase();
  return `<article class="card ch" style="animation-delay:${Math.min(i, 8) * 35}ms">
    <div class="ch-top">
      <div class="ch-av">${initial}</div>
      <div class="ch-id">
        <div class="ch-nm">${esc(c.name)}</div>
        <div class="route"><span>${esc(handle(c.tiktok))}</span><span class="ar">&rarr;</span><span>${fb}</span></div>
      </div>
      <span class="badge ${c.enabled !== 0 ? "b-ok" : "b-off"}">${c.enabled !== 0 ? "on" : "paused"}</span>
    </div>
    <div class="tags">
      <span class="tag">speed <b>${c.speed}&times;</b> &plusmn;${c.jitter}</span>
      <span class="tag">captions <b>${c.captions ? "on" : "off"}</b></span>
      <span class="tag"><b>${c.per_day || 1}</b>/day</span>
    </div>
    <div class="ch-foot">
      <button class="btn pri" data-render="${c.id}">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>Render a video</span></button>
      <button class="btn" data-edit="${c.id}">Edit</button>
      <button class="btn dgr" data-del="${c.id}">Delete</button>
    </div></article>`;
}

function renderChannels() {
  $("#channels").innerHTML = state.channels.length
    ? state.channels.map(chanCard).join("")
    : `<div class="empty"><b>No channels yet</b><span>A channel is one TikTok creator paired with one Facebook page.</span></div>`;

  $("#sbChannels").innerHTML = state.channels.length
    ? state.channels.map((c) => `<button class="nav" data-edit="${c.id}">
        <span class="pip ${c.enabled !== 0 ? "g" : "d"}"></span>
        <span class="nm">${esc(c.name)}</span></button>`).join("")
    : `<div class="sb-foot" style="border:0;padding:6px 9px">none yet</div>`;
}

/* ═════════════════════════ data ══════════════════════════ */
async function refresh() {
  try {
    const d = await Backend.load();
    Object.assign(state, d);
    // normalise the local shape onto the hosted field names
    if (MODE === "local") {
      state.channels = state.channels.map((c) => ({ ...c, tiktok: c.tiktok_url, fb_page: c.fb_page_name }));
    }
    renderStats(); renderJobs(); renderChannels();
    // The public state files load fine without a token, so a successful read is
    // not proof this device can do anything - only a token is.
    $("#gate").hidden = MODE === "local" || !!TOKEN;
  } catch (e) {
    if (MODE === "hosted" && !TOKEN) { $("#gate").hidden = false; return; }
    console.error(e);
    toast(e.message, true);
  }
}

let pollT;
function poll() {
  clearTimeout(pollT);
  const busy = (state.stats.active ?? 0) > 0;
  // GitHub's API is rate limited, so hosted polls far less often than local
  const every = MODE === "local" ? (busy ? 1200 : 6000) : (busy ? 12000 : 60000);
  pollT = setTimeout(async () => { await refresh(); poll(); }, every);
}

/* ═══════════════════════ interactions ════════════════════ */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;

  if (b.dataset.retry) {
    const j = state.jobs.find((x) => String(x.id) === b.dataset.retry);
    try { await (MODE === "local" ? Backend.retry(j.id) : Backend.retry(j)); toast("Queued again"); refresh(); poll(); }
    catch (err) { toast(err.message, true); }
  }

  if (b.dataset.preview) {
    const j = state.jobs.find((x) => String(x.id) === b.dataset.preview);
    if (!j) return;
    $("#pvTitle").textContent = j.channel || "Render";
    playInto($("#pvVideo"), j.video);
    const p = j.params || {};
    $("#pvParams").innerHTML = [
      ["Length", fmtDur(j.duration)],
      ["Size", j.size_mb ? `${j.size_mb} MB` : "—"],
      ["Speed", p.speed ? `${p.speed}×` : "—"],
      ["Pitch", p.pitch ? `+${((p.pitch - 1) * 100).toFixed(2)}%` : "—"],
      ["Squeeze", p.squeeze_pct != null ? `${p.squeeze_pct}%` : "—"],
      ["Frame drop", p.drop_every ? `1 in ${p.drop_every}` : "off"],
      ["Encoder", p.encoder || "—"],
      ["Seed", p.seed ?? "—"],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    show("#mPreview");
  }

  if (b.dataset.del) {
    const c = state.channels.find((x) => String(x.id) === b.dataset.del);
    if (!confirm(`Delete "${c?.name}"? Existing renders are kept.`)) return;
    try { await Backend.deleteChannel(c.id); toast("Channel deleted"); refresh(); }
    catch (err) { toast(err.message, true); }
  }

  if (b.dataset.edit) {
    const c = state.channels.find((x) => String(x.id) === b.dataset.edit);
    if (c) { closeDrawer(); channelModal(c); }
  }

  if (b.dataset.render) jobModal(b.dataset.render);
});

/* ════════════════════════ channels ═══════════════════════ */
function channelModal(c = null) {
  state.editing = c?.id ?? null;
  $("#mChannelTitle").textContent = c ? "Edit channel" : "New channel";
  $("#chName").value    = c?.name ?? "";
  $("#chTiktok").value  = c?.tiktok ?? "";
  $("#chFb").value      = c?.fb_page ?? "";
  $("#chSpeed").value   = c?.speed ?? 1.1;
  $("#chJitter").value  = c?.jitter ?? 0.02;
  $("#chCaptions").checked = c ? !!c.captions : true;
  $("#chPerDay").value  = c?.per_day ?? 1;
  show("#mChannel");
}
$("#btnNewChannel").addEventListener("click", () => channelModal());

$("#btnSaveChannel").addEventListener("click", async () => {
  const name = $("#chName").value.trim();
  const tiktok = $("#chTiktok").value.trim();
  if (!name || !tiktok) return toast("Name and TikTok link are required", true);

  const common = {
    name,
    speed: parseFloat($("#chSpeed").value) || 1.1,
    jitter: parseFloat($("#chJitter").value) || 0,
    captions: $("#chCaptions").checked ? 1 : 0,
    per_day: parseInt($("#chPerDay").value) || 1,
  };
  const body = MODE === "local"
    ? { ...common, tiktok_url: tiktok, fb_page_name: $("#chFb").value.trim(), encoder: "auto" }
    : { ...common, tiktok, fb_page: $("#chFb").value.trim() };

  const btn = $("#btnSaveChannel");
  btn.disabled = true;
  try {
    await Backend.saveChannel(body, state.editing);
    toast(state.editing ? "Channel updated" : "Channel added");
    close(); await refresh();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
});

/* ══════════════════════════ jobs ═════════════════════════ */
function jobModal(channelId = null) {
  if (!state.channels.length) { toast("Add a channel first", true); return goto("channels"); }
  $("#jobChannel").innerHTML = state.channels
    .map((c) => `<option value="${c.id}"${String(c.id) === String(channelId) ? " selected" : ""}>${esc(c.name)}</option>`).join("");
  $("#jobUrl").value = "";
  show("#mJob");
}
$("#btnNewJob").addEventListener("click", () => jobModal());

$("#btnQueueJob").addEventListener("click", async () => {
  const url = $("#jobUrl").value.trim();
  if (!/tiktok\.com/.test(url)) return toast("Paste a TikTok video link", true);
  const ch = state.channels.find((c) => String(c.id) === $("#jobChannel").value);
  const btn = $("#btnQueueJob");
  btn.disabled = true;
  try {
    await Backend.queue(ch, url);
    close();
    toast(MODE === "local" ? "Render queued" : "Sent to GitHub Actions — about 7 minutes");
    goto("queue"); await refresh(); poll();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
});

/* ════════════════════════ setup ══════════════════════════ */
async function loadSettings() {
  $("#modeName").textContent = MODE === "local" ? "Local — this PC" : "Hosted — GitHub Pages";
  $("#modeWhere").textContent = Backend.label;

  if (MODE === "local") {
    const s = await Backend.settings();
    $("#setCookies").value = s.cookies_path || "";
    $("#setOutput").value = s.output_dir || "";
    $("#machine").innerHTML = [
      ["Run mode", "local — renders on this PC"],
      ["GPU encoder", s.nvenc ? "NVENC available" : "not available — using CPU"],
      ["Typical render", "about 50 seconds"],
      ["Renders saved to", s.output_dir || "—"],
      ["TikTok cookies", s.cookies_path ? "configured" : "not set"],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
  } else {
    $("#localOnly").hidden = true;
    $("#tokenBox").hidden = false;
    $("#setToken").value = TOKEN ? "••••••••••••••••" : "";
    $("#machine").innerHTML = [
      ["Run mode", "hosted — no server of ours"],
      ["Renders on", "GitHub Actions"],
      ["Typical render", "about 7 minutes"],
      ["Access token", TOKEN ? "configured" : "not set"],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
  }
}

$("#btnSaveSettings")?.addEventListener("click", async () => {
  try {
    await Backend.saveSettings({
      cookies_path: $("#setCookies").value.trim(),
      output_dir: $("#setOutput").value.trim(),
    });
    const n = $("#setSaved"); n.hidden = false; setTimeout(() => (n.hidden = true), 2000);
    loadSettings();
  } catch (e) { toast(e.message, true); }
});

async function useToken(t) {
  if (!t) return toast("Paste a token first", true);
  TOKEN = t.trim();
  localStorage.setItem(TOK_KEY, TOKEN);
  $("#gate").hidden = true;
  await refresh();
  await loadSettings();
  poll();
  toast("Connected");
}
$("#btnGateSave").addEventListener("click", () => useToken($("#gateToken").value));
$("#btnSaveToken")?.addEventListener("click", () => useToken($("#setToken").value));

/* ═════════════════════════ boot ══════════════════════════ */
(async () => {
  document.body.dataset.mode = MODE;
  if (MODE === "hosted" && !TOKEN) { $("#gate").hidden = false; }
  await refresh();
  await loadSettings();
  poll();
})();
