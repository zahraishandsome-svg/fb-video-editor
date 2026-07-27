/* Repost Studio — front end.
   Single operator, so state lives in the DB and the page polls: 1.2s while a
   render is running, 6s when idle. */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtDur = (s) => {
  if (!s) return "—";
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};
const ago = (ts) => {
  if (!ts) return "";
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};
const handle = (u) => String(u || "").replace(/^https?:\/\/(www\.)?tiktok\.com\//, "").replace(/\/video\/.*$/, "");

const state = { channels: [], jobs: [], stats: {}, editing: null, view: "queue" };

/* ─────────────────────────── toast ─────────────────────────── */
let toastT;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 3200);
}

/* ─────────────────────────── nav ───────────────────────────── */
const CRUMB = { queue: "Render queue", channels: "Channels", setup: "Setup" };

function goto(view) {
  state.view = view;
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== view));
  $$(".nav[data-goto]").forEach((n) => n.classList.toggle("on", n.dataset.goto === view));
  $("#crumb").textContent = CRUMB[view] || view;
  closeDrawer();
  window.scrollTo(0, 0);
}
document.addEventListener("click", (e) => {
  const n = e.target.closest(".nav[data-goto]");
  if (n) goto(n.dataset.goto);
});

function openDrawer()  { $("#sb").classList.add("open");  $("#scrim2").classList.add("on"); }
function closeDrawer() { $("#sb").classList.remove("open"); $("#scrim2").classList.remove("on"); }
$("#hamb").addEventListener("click", openDrawer);
$("#scrim2").addEventListener("click", closeDrawer);

addEventListener("scroll", () => $("#tbar").classList.toggle("stuck", scrollY > 4), { passive: true });

/* ────────────────────────── modals ─────────────────────────── */
let openModal = null;
function show(id) {
  openModal = $(id);
  $("#scrim").hidden = false;
  openModal.hidden = false;
}
function close() {
  if (!openModal) return;
  const v = $("#pvVideo");
  if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
  openModal.hidden = true;
  $("#scrim").hidden = true;
  openModal = null;
}
$("#scrim").addEventListener("click", close);
document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(); closeDrawer(); } });

/* ────────────────────────── rendering ──────────────────────── */
const STAGE = {
  download: "downloading", transcribe: "captions", render: "rendering", finish: "finishing",
};
const BADGE = { running: "b-run", queued: "b-que", ready: "b-ok", posted: "b-ok", failed: "b-err" };

function renderStats() {
  const s = state.stats;
  const cells = [
    ["channels", s.channels ?? 0, "active pairings", ""],
    ["in queue", s.active ?? 0, (s.active ?? 0) ? "working now" : "nothing waiting", (s.active ?? 0) ? "act" : ""],
    ["ready", s.ready ?? 0, "waiting to post", (s.ready ?? 0) ? "ok" : ""],
    ["failed", s.failed ?? 0, (s.failed ?? 0) ? "needs a retry" : "none", (s.failed ?? 0) ? "bad" : ""],
  ];
  $("#stats").innerHTML = cells.map(([lb, vl, ft, cls], i) =>
    `<div class="stat ${cls}" style="animation-delay:${i * 40}ms">
       <div class="lb">${lb}</div><div class="vl">${vl}</div><div class="ft">${ft}</div>
     </div>`).join("");

  const busy = (s.active ?? 0) > 0;
  const running = state.jobs.find((j) => j.status === "running");
  $("#beat").className = "beat" + (busy ? " busy" : (s.failed ? " err" : ""));
  $("#beatTxt").textContent = busy
    ? `${STAGE[running?.stage] || "working"}${running ? " " + Math.round(running.progress) + "%" : ""}`
    : "idle";
  $("#sbPip").className = "pip " + (busy ? "a" : "g");
  $("#sbFoot").textContent = busy ? `${s.active} in queue` : `${s.ready ?? 0} ready to post`;
  $("#navQueueN").textContent = state.jobs.length || "";
  $("#navChanN").textContent = state.channels.length || "";
  $("#jobsN").textContent = state.jobs.length ? `· ${state.jobs.length}` : "";
}

function jobCard(j, i) {
  const running = j.status === "running";
  const label = running ? (STAGE[j.stage] || "working") : j.status;
  const thumb = j.thumb
    ? `<img class="thumb" src="/api/jobs/${j.id}/thumb" alt="" loading="lazy">`
    : `<div class="thumb ph${running ? " load" : ""}">${running ? "" : "NO<br>FILE"}</div>`;

  const mets = [];
  if (running) mets.push(["progress", Math.round(j.progress) + "%"]);
  if (j.duration) mets.push(["length", fmtDur(j.duration)]);
  if (j.size_mb) mets.push(["size", j.size_mb + " MB"]);
  mets.push(["added", ago(j.created_at)]);

  const acts = [];
  if (j.out_path) acts.push(`<button class="btn" data-preview="${j.id}">
    <svg viewBox="0 0 24 24"><path d="M9 7l9 5-9 5z"/></svg><span>Preview</span></button>`);
  if (j.status === "failed") acts.push(`<button class="btn" data-retry="${j.id}">
    <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.6"/><path d="M20 5v6h-6"/></svg><span>Retry</span></button>`);

  return `<article class="card" style="animation-delay:${Math.min(i, 8) * 35}ms">
    <div class="rbar" style="width:${running ? j.progress : 0}%"></div>
    <div class="job">
      ${thumb}
      <div class="jb">
        <div class="jb-top">
          <div style="min-width:0">
            <div class="jb-nm">${esc(j.channel_name || "No channel")}</div>
            <div class="jb-src">${esc(handle(j.source_url) || j.source_url)}</div>
          </div>
          <span class="badge ${BADGE[j.status] || "b-off"}">${esc(label)}</span>
        </div>
        <div class="mets">${mets.map(([k, v]) =>
          `<div class="met"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join("")}</div>
        ${j.error ? `<div class="err">${esc(j.error)}</div>` : ""}
        ${acts.length ? `<div class="jb-foot">${acts.join("")}</div>` : ""}
      </div>
    </div>
  </article>`;
}

function renderJobs() {
  $("#jobs").innerHTML = state.jobs.length
    ? state.jobs.map(jobCard).join("")
    : `<div class="empty"><b>Nothing rendered yet</b><span>Add a channel, then queue a TikTok URL.</span></div>`;
}

function chanCard(c, i) {
  const fb = c.fb_page_name ? esc(c.fb_page_name) : `<span class="none">no page set</span>`;
  const initial = esc((c.name || "?").trim()[0] || "?").toUpperCase();
  return `<article class="card ch" style="animation-delay:${Math.min(i, 8) * 35}ms">
    <div class="ch-top">
      <div class="ch-av">${initial}</div>
      <div class="ch-id">
        <div class="ch-nm">${esc(c.name)}</div>
        <div class="route"><span>${esc(handle(c.tiktok_url))}</span><span class="ar">&rarr;</span><span>${fb}</span></div>
      </div>
      <span class="badge ${c.enabled ? "b-ok" : "b-off"}">${c.enabled ? "on" : "paused"}</span>
    </div>
    <div class="tags">
      <span class="tag">speed <b>${c.speed}&times;</b> &plusmn;${c.jitter}</span>
      <span class="tag">captions <b>${c.captions ? "on" : "off"}</b></span>
      <span class="tag">${esc(c.encoder)}</span>
      <span class="tag"><b>${c.per_day}</b>/day</span>
      <span class="tag"><b>${c.job_count ?? 0}</b> renders</span>
    </div>
    <div class="ch-foot">
      <button class="btn pri" data-render="${c.id}">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>Render a video</span></button>
      <button class="btn" data-edit="${c.id}">Edit</button>
      <button class="btn dgr" data-del="${c.id}">Delete</button>
    </div>
  </article>`;
}

function renderChannels() {
  $("#channels").innerHTML = state.channels.length
    ? state.channels.map(chanCard).join("")
    : `<div class="empty"><b>No channels yet</b><span>A channel is one TikTok creator paired with one Facebook page.</span></div>`;

  $("#sbChannels").innerHTML = state.channels.length
    ? state.channels.map((c) =>
        `<button class="nav" data-edit="${c.id}">
           <span class="pip ${c.enabled ? "g" : "d"}"></span>
           <span class="nm">${esc(c.name)}</span>
           <span class="mini">${c.job_count ?? 0}</span>
         </button>`).join("")
    : `<div class="sb-foot" style="border:0;padding:6px 9px">none yet</div>`;
}

/* ──────────────────────────── data ─────────────────────────── */
async function refresh() {
  try {
    const [ov, chans, jobs] = await Promise.all([
      api("/api/overview"), api("/api/channels"), api("/api/jobs?limit=40"),
    ]);
    Object.assign(state, { stats: ov.stats, channels: chans, jobs });
    renderStats(); renderJobs(); renderChannels();
  } catch (e) { console.error(e); }
}

let pollT;
function poll() {
  clearTimeout(pollT);
  const busy = (state.stats.active ?? 0) > 0;
  pollT = setTimeout(async () => { await refresh(); poll(); }, busy ? 1200 : 6000);
}

/* ──────────────────────── interactions ─────────────────────── */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;

  if (b.dataset.retry) {
    await api(`/api/jobs/${b.dataset.retry}/retry`, { method: "POST" });
    toast("Queued again"); refresh(); poll();
  }

  if (b.dataset.preview) {
    const j = state.jobs.find((x) => x.id == b.dataset.preview);
    if (!j) return;
    $("#pvTitle").textContent = j.channel_name || "Render";
    $("#pvVideo").src = `/api/jobs/${j.id}/video`;
    let p = {};
    try { p = JSON.parse(j.params || "{}"); } catch {}
    $("#pvParams").innerHTML = [
      ["Length", fmtDur(j.duration)],
      ["Size", `${j.size_mb} MB`],
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
    const c = state.channels.find((x) => x.id == b.dataset.del);
    if (!confirm(`Delete "${c?.name}"? Existing renders stay on disk.`)) return;
    await api(`/api/channels/${b.dataset.del}`, { method: "DELETE" });
    toast("Channel deleted"); refresh();
  }

  if (b.dataset.edit) {
    const c = state.channels.find((x) => x.id == b.dataset.edit);
    if (c) { closeDrawer(); channelModal(c); }
  }

  if (b.dataset.render) jobModal(Number(b.dataset.render));
});

/* ───────────────────────── channels ────────────────────────── */
function channelModal(c = null) {
  state.editing = c?.id ?? null;
  $("#mChannelTitle").textContent = c ? "Edit channel" : "New channel";
  $("#chName").value     = c?.name ?? "";
  $("#chTiktok").value   = c?.tiktok_url ?? "";
  $("#chFb").value       = c?.fb_page_name ?? "";
  $("#chSpeed").value    = c?.speed ?? 1.1;
  $("#chJitter").value   = c?.jitter ?? 0.02;
  $("#chCaptions").checked = c ? !!c.captions : true;
  $("#chEncoder").value  = c?.encoder ?? "auto";
  $("#chPerDay").value   = c?.per_day ?? 1;
  show("#mChannel");
}
$("#btnNewChannel").addEventListener("click", () => channelModal());

$("#btnSaveChannel").addEventListener("click", async () => {
  const body = {
    name: $("#chName").value.trim(),
    tiktok_url: $("#chTiktok").value.trim(),
    fb_page_name: $("#chFb").value.trim(),
    speed: parseFloat($("#chSpeed").value) || 1.1,
    jitter: parseFloat($("#chJitter").value) || 0,
    captions: $("#chCaptions").checked ? 1 : 0,
    encoder: $("#chEncoder").value,
    per_day: parseInt($("#chPerDay").value) || 1,
  };
  if (!body.name || !body.tiktok_url) return toast("Name and TikTok link are required", true);
  try {
    if (state.editing) {
      await api(`/api/channels/${state.editing}`, { method: "PATCH", body });
      toast("Channel updated");
    } else {
      await api("/api/channels", { method: "POST", body });
      toast("Channel added");
    }
    close(); refresh();
  } catch (e) { toast(e.message, true); }
});

/* ─────────────────────────── jobs ──────────────────────────── */
function jobModal(channelId = null) {
  if (!state.channels.length) { toast("Add a channel first", true); return goto("channels"); }
  $("#jobChannel").innerHTML = state.channels
    .map((c) => `<option value="${c.id}"${c.id === channelId ? " selected" : ""}>${esc(c.name)}</option>`).join("");
  $("#jobUrl").value = "";
  show("#mJob");
}
$("#btnNewJob").addEventListener("click", () => jobModal());

$("#btnQueueJob").addEventListener("click", async () => {
  const url = $("#jobUrl").value.trim();
  if (!/tiktok\.com/.test(url)) return toast("Paste a TikTok video link", true);
  try {
    await api("/api/jobs", { method: "POST", body: { channel_id: Number($("#jobChannel").value), url } });
    close(); toast("Render queued"); goto("queue"); refresh(); poll();
  } catch (e) { toast(e.message, true); }
});

/* ──────────────────────── settings ─────────────────────────── */
async function loadSettings() {
  const s = await api("/api/settings");
  $("#setCookies").value = s.cookies_path || "";
  $("#setOutput").value = s.output_dir || "";
  $("#machine").innerHTML = [
    ["GPU encoder", s.nvenc ? "NVENC available" : "not available — using CPU"],
    ["Renders saved to", s.output_dir || "—"],
    ["TikTok cookies", s.cookies_path ? "configured" : "not set"],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
}
$("#btnSaveSettings").addEventListener("click", async () => {
  try {
    await api("/api/settings", {
      method: "POST",
      body: { cookies_path: $("#setCookies").value.trim(), output_dir: $("#setOutput").value.trim() },
    });
    const n = $("#setSaved");
    n.hidden = false; setTimeout(() => (n.hidden = true), 2000);
    loadSettings();
  } catch (e) { toast(e.message, true); }
});

/* ───────────────────────────  boot ─────────────────────────── */
(async () => { await refresh(); await loadSettings(); poll(); })();
