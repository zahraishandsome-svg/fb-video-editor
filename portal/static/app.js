/* Repost Studio — front end.
   Single operator, one device at a time, so state lives in the DB and the page
   just polls. Polling backs off to 6s when nothing is running. */

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

let state = { channels: [], jobs: [], stats: {}, editingChannel: null };

/* ------------------------------- toast ------------------------------- */
let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

/* ------------------------------ routing ------------------------------ */
function goto(view) {
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== view));
  $$(".tab").forEach((t) => t.classList.toggle("is-on", t.dataset.goto === view));
  window.scrollTo(0, 0);
}
$$(".tab").forEach((t) => t.addEventListener("click", () => goto(t.dataset.goto)));

/* ------------------------------ sheets ------------------------------- */
let openSheet = null;
function showSheet(id) {
  openSheet = $(id);
  $("#scrim").hidden = false;
  openSheet.hidden = false;
  openSheet.classList.remove("closing");
}
function closeSheet() {
  if (!openSheet) return;
  const s = openSheet;
  s.classList.add("closing");
  $("#scrim").hidden = true;
  const v = $("#preview-video");
  if (v) v.pause();
  setTimeout(() => { s.hidden = true; s.classList.remove("closing"); }, 240);
  openSheet = null;
}
$("#scrim").addEventListener("click", closeSheet);
$$("[data-close]").forEach((b) => b.addEventListener("click", closeSheet));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

/* ------------------------------ render ------------------------------- */
const STATUS_LABEL = {
  queued: "queued", running: "rendering", ready: "ready",
  posted: "posted", failed: "failed",
};
const STAGE_LABEL = {
  download: "downloading", transcribe: "transcribing captions", render: "rendering",
  finish: "finishing",
};

function renderStats() {
  const s = state.stats;
  $("#statgrid").innerHTML = [
    ["channels", s.channels ?? 0, false],
    ["in queue", s.active ?? 0, (s.active ?? 0) > 0],
    ["ready", s.ready ?? 0, false],
    ["failed", s.failed ?? 0, false],
  ].map(([label, n, on]) =>
    `<div class="stat${on ? " on" : ""}"><b>${n}</b><span>${label}</span></div>`
  ).join("");

  const active = s.active ?? 0;
  $("#tally").innerHTML = active
    ? `<b>${active}</b> RUNNING`
    : `${s.ready ?? 0} READY`;
}

function jobCard(j) {
  const st = j.status === "running" ? "running" : j.status;
  const stageTxt = j.status === "running"
    ? (STAGE_LABEL[j.stage] || j.stage || "working")
    : (STATUS_LABEL[j.status] || j.status);

  const thumb = j.thumb
    ? `<img class="thumb" src="/api/jobs/${j.id}/thumb" alt="" loading="lazy">`
    : `<div class="thumb empty">${j.status === "running" ? "···" : "NO<br>FILE"}</div>`;

  const meta = [];
  if (j.duration) meta.push(fmtDur(j.duration));
  if (j.size_mb) meta.push(`${j.size_mb} MB`);
  if (j.status === "running") meta.push(`${Math.round(j.progress)}%`);
  if (j.created_at) meta.push(ago(j.created_at));

  const actions = [];
  if (j.out_path) actions.push(`<button class="btn ghost sm" data-preview="${j.id}">Preview</button>`);
  if (j.status === "failed") actions.push(`<button class="btn ghost sm" data-retry="${j.id}">Retry</button>`);

  return `
  <article class="card">
    <div class="bar" style="width:${j.status === "running" ? j.progress : 0}%"></div>
    <div class="job">
      ${thumb}
      <div class="job-main">
        <div class="job-top">
          <span class="job-name">${esc(j.channel_name || "No channel")}</span>
          <span class="chip ${st}">${esc(stageTxt)}</span>
        </div>
        <div class="job-url">${esc(j.source_url)}</div>
        <div class="job-meta">${meta.map(esc).join("<span>·</span>")}</div>
        ${j.error ? `<div class="err">${esc(j.error)}</div>` : ""}
        ${actions.length ? `<div class="job-actions">${actions.join("")}</div>` : ""}
      </div>
    </div>
  </article>`;
}

function renderJobs() {
  const el = $("#joblist");
  if (!state.jobs.length) {
    el.innerHTML = `<div class="empty-state">
      <p>Nothing rendered yet</p>
      <small>Add a channel, then queue a TikTok URL.</small>
    </div>`;
    return;
  }
  el.innerHTML = state.jobs.map(jobCard).join("");
}

function channelCard(c) {
  const fb = c.fb_page_name
    ? esc(c.fb_page_name)
    : `<span class="off">no page set</span>`;
  return `
  <article class="card chan">
    <div class="chan-head">
      <div>
        <div class="chan-name">${esc(c.name)}</div>
        <div class="route">
          <span>${esc(c.tiktok_url.replace(/^https?:\/\/(www\.)?tiktok\.com\//, ""))}</span>
          <span class="arrow">→</span>
          <span>${fb}</span>
        </div>
      </div>
      <span class="chip ${c.enabled ? "ready" : "queued"}">${c.enabled ? "on" : "paused"}</span>
    </div>
    <div class="preset">
      <span class="tagv">speed <b>${c.speed}×</b> ±${c.jitter}</span>
      <span class="tagv">captions <b>${c.captions ? "on" : "off"}</b></span>
      <span class="tagv">${esc(c.encoder)}</span>
      <span class="tagv"><b>${c.per_day}</b>/day</span>
      <span class="tagv"><b>${c.job_count ?? 0}</b> renders</span>
    </div>
    <div class="job-actions">
      <button class="btn ghost sm" data-render="${c.id}">Render a video</button>
      <button class="btn ghost sm" data-edit="${c.id}">Edit</button>
      <button class="btn danger sm" data-del="${c.id}">Delete</button>
    </div>
  </article>`;
}

function renderChannels() {
  const el = $("#channellist");
  if (!state.channels.length) {
    el.innerHTML = `<div class="empty-state">
      <p>No channels yet</p>
      <small>A channel is one TikTok creator paired with one Facebook page.</small>
    </div>`;
    return;
  }
  el.innerHTML = state.channels.map(channelCard).join("");
}

/* ------------------------------- data -------------------------------- */
async function refresh() {
  try {
    const [ov, chans, jobs] = await Promise.all([
      api("/api/overview"), api("/api/channels"), api("/api/jobs?limit=40"),
    ]);
    state.stats = ov.stats;
    state.channels = chans;
    state.jobs = jobs;
    renderStats(); renderJobs(); renderChannels();
  } catch (e) {
    console.error(e);
  }
}

let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = (state.stats.active ?? 0) > 0;
  pollTimer = setTimeout(async () => { await refresh(); schedulePoll(); }, busy ? 1200 : 6000);
}

/* ----------------------------- interactions --------------------------- */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  if (btn.dataset.retry) {
    await api(`/api/jobs/${btn.dataset.retry}/retry`, { method: "POST" });
    toast("Queued again"); refresh();
  }

  if (btn.dataset.preview) {
    const j = state.jobs.find((x) => x.id == btn.dataset.preview);
    if (!j) return;
    $("#preview-title").textContent = j.channel_name || "Render";
    $("#preview-video").src = `/api/jobs/${j.id}/video`;
    let p = {};
    try { p = JSON.parse(j.params || "{}"); } catch {}
    const rows = [
      ["Duration", fmtDur(j.duration)],
      ["Size", `${j.size_mb} MB`],
      ["Speed", p.speed ? `${p.speed}×` : "—"],
      ["Pitch", p.pitch ? `+${((p.pitch - 1) * 100).toFixed(2)}%` : "—"],
      ["Squeeze", p.squeeze_pct != null ? `${p.squeeze_pct}%` : "—"],
      ["Frame drop", p.drop_every ? `1 in ${p.drop_every}` : "off"],
      ["Encoder", p.encoder || "—"],
      ["Seed", p.seed ?? "—"],
    ];
    $("#preview-params").innerHTML = rows
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    showSheet("#sheet-preview");
  }

  if (btn.dataset.del) {
    const c = state.channels.find((x) => x.id == btn.dataset.del);
    if (!confirm(`Delete "${c?.name}"? Existing renders stay on disk.`)) return;
    await api(`/api/channels/${btn.dataset.del}`, { method: "DELETE" });
    toast("Channel deleted"); refresh();
  }

  if (btn.dataset.edit) {
    const c = state.channels.find((x) => x.id == btn.dataset.edit);
    if (c) openChannelSheet(c);
  }

  if (btn.dataset.render) {
    openJobSheet(Number(btn.dataset.render));
  }
});

/* ------------------------------ channels ------------------------------ */
function openChannelSheet(c = null) {
  state.editingChannel = c?.id ?? null;
  $("#sheet-channel-title").textContent = c ? "Edit channel" : "New channel";
  $("#ch-name").value     = c?.name ?? "";
  $("#ch-tiktok").value   = c?.tiktok_url ?? "";
  $("#ch-fbpage").value   = c?.fb_page_name ?? "";
  $("#ch-speed").value    = c?.speed ?? 1.1;
  $("#ch-jitter").value   = c?.jitter ?? 0.02;
  $("#ch-captions").checked = c ? !!c.captions : true;
  $("#ch-encoder").value  = c?.encoder ?? "auto";
  $("#ch-perday").value   = c?.per_day ?? 1;
  showSheet("#sheet-channel");
}

$("#btn-new-channel").addEventListener("click", () => openChannelSheet());

$("#btn-save-channel").addEventListener("click", async () => {
  const body = {
    name: $("#ch-name").value.trim(),
    tiktok_url: $("#ch-tiktok").value.trim(),
    fb_page_name: $("#ch-fbpage").value.trim(),
    speed: parseFloat($("#ch-speed").value) || 1.1,
    jitter: parseFloat($("#ch-jitter").value) || 0,
    captions: $("#ch-captions").checked ? 1 : 0,
    encoder: $("#ch-encoder").value,
    per_day: parseInt($("#ch-perday").value) || 1,
  };
  if (!body.name || !body.tiktok_url) return toast("Name and TikTok link are required", true);
  try {
    if (state.editingChannel) {
      await api(`/api/channels/${state.editingChannel}`, { method: "PATCH", body });
      toast("Channel updated");
    } else {
      await api("/api/channels", { method: "POST", body });
      toast("Channel added");
    }
    closeSheet(); refresh();
  } catch (e) { toast(e.message, true); }
});

/* -------------------------------- jobs -------------------------------- */
function openJobSheet(channelId = null) {
  if (!state.channels.length) { toast("Add a channel first", true); return goto("channels"); }
  $("#job-channel").innerHTML = state.channels
    .map((c) => `<option value="${c.id}"${c.id === channelId ? " selected" : ""}>${esc(c.name)}</option>`)
    .join("");
  $("#job-url").value = "";
  showSheet("#sheet-job");
}

$("#btn-new-job").addEventListener("click", () => openJobSheet());

$("#btn-queue-job").addEventListener("click", async () => {
  const url = $("#job-url").value.trim();
  if (!/tiktok\.com/.test(url)) return toast("Paste a TikTok video link", true);
  try {
    await api("/api/jobs", {
      method: "POST",
      body: { channel_id: Number($("#job-channel").value), url },
    });
    closeSheet(); toast("Render queued");
    goto("queue"); refresh(); schedulePoll();
  } catch (e) { toast(e.message, true); }
});

/* ------------------------------- settings ------------------------------ */
async function loadSettings() {
  const s = await api("/api/settings");
  $("#set-cookies").value = s.cookies_path || "";
  $("#set-output").value = s.output_dir || "";
  $("#machine").innerHTML = [
    ["GPU encoder", s.nvenc ? "NVENC available" : "not available — using CPU"],
    ["Renders saved to", s.output_dir || "—"],
    ["TikTok cookies", s.cookies_path ? "configured" : "not set"],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
}

$("#btn-save-settings").addEventListener("click", async () => {
  try {
    await api("/api/settings", {
      method: "POST",
      body: { cookies_path: $("#set-cookies").value.trim(), output_dir: $("#set-output").value.trim() },
    });
    const n = $("#settings-saved");
    n.hidden = false; setTimeout(() => (n.hidden = true), 2000);
    loadSettings();
  } catch (e) { toast(e.message, true); }
});

/* -------------------------------- boot --------------------------------- */
(async function boot() {
  await refresh();
  await loadSettings();
  schedulePoll();
})();
