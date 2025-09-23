import { api } from "./api.js";
import { zipProject } from "./zip.js";
import { apiDocumentationContent } from "./apiDocs.js";

/* UI helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const tabs = $$(".tab");
const panels = $$(".tabpanel");
tabs.forEach(t => t.addEventListener("click", () => {
  tabs.forEach(x => x.classList.remove("active"));
  panels.forEach(p => p.classList.remove("active"));
  t.classList.add("active");
  $("#" + t.dataset.tab).classList.add("active");
}));

/* Docs dialog */
$("#docs-content").textContent = apiDocumentationContent;
const docsDialog = $("#docs-dialog");
$("#show-docs").addEventListener("click", () => docsDialog.showModal());
docsDialog.querySelector(".close").addEventListener("click", () => docsDialog.close());

/* Progress UI */
const progressSection = $("#progress");
const progressBar = $("#progress-bar");
const progressTitle = $("#progress-title");
const progressDetail = $("#progress-detail");
const cancelBtn = $("#cancel-btn");
let currentAbort = null;

function withProgress(title) {
  progressTitle.textContent = title;
  progressBar.style.width = "0%";
  progressDetail.textContent = "";
  progressSection.hidden = false;
  const ctrl = new AbortController();
  currentAbort = ctrl;
  cancelBtn.onclick = () => ctrl.abort();
  return ctrl.signal;
}
function updateProgress(frac, detail) {
  progressBar.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  if (detail) progressDetail.textContent = detail;
}
function endProgress() {
  progressSection.hidden = true;
  currentAbort = null;
}

/* Rendering cards */
function renderProjects(listEl, projects = []) {
  listEl.innerHTML = "";
  if (!projects.length) {
    listEl.innerHTML = `<div class="hint">No results.</div>`;
    return;
  }
  for (const p of projects) {
    const owner = p.created_by?.username || p.owner?.username || "unknown";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <h3 title="${p.title || ""}">${p.title || "(untitled)"}</h3>
      <div class="meta">${owner} • id: ${p.id} • v${p.current_version ?? p.version ?? "?"}</div>
      <div class="row">
        <button data-id="${p.id}" class="zip">Zip & Download</button>
        <a class="gh" href="https://websim.ai/${owner}/projects/${p.slug || p.id}" target="_blank" rel="noopener">Open</a>
      </div>
    `;
    card.querySelector(".zip").addEventListener("click", () => startZipByProjectId(p.id));
    listEl.appendChild(card);
  }
}

/* Fetch + zip pipeline */
async function resolveProject(input) {
  // Accept: full URL, id, or user/slug
  try {
    const u = new URL(input);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 3 && (parts[1] === "slugs" || parts[1] === "projects")) {
      try { return await api.getProjectBySlug(parts[0], parts[2]); } catch { /* fall through */ }
    }
    // Avoid treating slugs as IDs which can 400; defer to guess below
    throw new Error("treat as guess");
  } catch {
    if (input.includes("/")) {
      const [user, slug] = input.split("/");
      try { return await api.getProjectBySlug(user, slug); } catch { /* fallback below */ }
    }
    try { return await api.getProjectById(input); } catch {
      return await api.findProjectByGuess(input);
    }
  }
}

async function collectAssetsFromHTML(pageUrl, html, onProgress, signal) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const sel = [
    ["script[src]", "src"], ["link[rel=stylesheet][href]", "href"],
    ["img[src]", "src"], ["source[src]", "src"],
    ["video[src]", "src"], ["audio[src]", "src"], ["link[rel=icon][href]", "href"]
  ];
  const urls = new Set();
  for (const [q, attr] of sel) doc.querySelectorAll(q).forEach(el => {
    const v = el.getAttribute(attr); if (v && !v.startsWith("data:")) urls.add(abs(v, pageUrl));
  });
  const list = [...urls];
  const total = list.length || 1;
  let done = 0;
  const limit = 6;
  const results = [];
  const toPath = (u) => {
    const { host, pathname, search } = new URL(u);
    const cleanSearch = search ? `_${btoa(search).replace(/=+$/,"")}` : "";
    return `external/${host}${pathname}${cleanSearch}`;
  };
  async function worker() {
    while (list.length) {
      if (signal?.aborted) throw new Error("cancelled");
      const u = list.shift();
      try {
        const data = await api.fetchAnyBytes(u);
        results.push({ path: toPath(u), data });
      } catch { /* skip failed asset */ }
      finally {
        done++; onProgress?.(done / total, `Fetched asset ${done}/${total}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length || 1) }).map(() => worker()));
  return results;
}

async function startZipFromUrl(rawUrl) {
  const signal = withProgress("Fetching page…");
  const pageUrl = rawUrl;
  const html = await api.fetchAnyText(pageUrl);
  updateProgress(0.1, "Collecting assets…");
  const assets = await collectAssetsFromHTML(pageUrl, html, updateProgress, signal);
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim();
  const project = { id: pageUrl, title: title || new URL(pageUrl).hostname, slug: "", created_by: { username: "" } };
  updateProgress(0.85, "Building zip…");
  const blob = await zipProject(project, { assets, html, revision: null }, updateProgress, signal);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(project.title || "page").replace(/[^\w\-\.\s]/g,"_")}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  endProgress();
}

async function startZipByProjectId(projectId) {
  try {
    const project = await api.getProjectById(projectId);
    await startZip(project);
  } catch (e) {
    alert(`Failed to load project ${projectId}: ${e.message}`);
  }
}

async function startZip(projectLikeOrIdOrSlugInput) {
  let project;
  try {
    progressSection.hidden = false;
    const signal = withProgress("Resolving project…");
    if (typeof projectLikeOrIdOrSlugInput === "object" && projectLikeOrIdOrSlugInput.id) {
      project = projectLikeOrIdOrSlugInput;
    } else {
      try {
        project = await resolveProject(String(projectLikeOrIdOrSlugInput));
      } catch (e) {
        if (isURL(String(projectLikeOrIdOrSlugInput))) {
          try {
            await startZipFromUrl(String(projectLikeOrIdOrSlugInput));
            return;
          } catch (urlError) {
            throw new Error(`Failed to fetch URL: ${urlError.message}`);
          }
        }
        throw e;
      }
    }
    const version = project.current_version ?? project.version ?? 1;

    updateProgress(0.02, "Fetching HTML…");
    let html = "";
    let revision = null;
    try {
      [html, revision] = await Promise.all([
        api.getRevisionHTML(project.id, version).catch(() => ""),
        api.getRevision(project.id, version).catch(() => null)
      ]);
    } catch (htmlError) {
      console.warn("Failed to fetch HTML/revision:", htmlError.message);
      html = "";
      revision = null;
    }

    updateProgress(0.05, "Listing assets…");
    let assets = [];
    try {
      assets = await collectAssets(project.id, version, updateProgress, currentAbort);
    } catch (assetError) {
      console.warn("Failed to collect assets:", assetError.message);
      assets = [];
    }

    updateProgress(0.85, "Building zip…");
    const blob = await zipProject(project, { assets, html, revision }, updateProgress, currentAbort);
    const name = (project.title || project.slug || project.id) + ".zip";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    if (isURL(String(projectLikeOrIdOrSlugInput))) {
      try { 
        await startZipFromUrl(String(projectLikeOrIdOrSlugInput)); 
        return; 
      } catch (ee) { 
        alert(`Download failed: ${ee.message}`); 
      }
    } else {
      if (!String(e.message).includes("cancelled")) {
        alert(`Download failed: ${e.message}`);
      }
    }
  } finally {
    endProgress();
  }
}

async function collectAssets(projectId, version, onProgress, signal) {
  try {
    const data = await api.listAssets(projectId, version);
    const assetList = data.assets || data.items || data || [];
    const total = assetList.length || 1;
    let done = 0;
    const results = [];
    
    for (const asset of assetList) {
      if (signal?.aborted) throw new Error("cancelled");
      try {
        const data = await api.getAssetContent(projectId, version, asset.path);
        results.push({ path: asset.path, data });
      } catch (assetError) {
        console.warn(`Failed to fetch asset ${asset.path}:`, assetError.message);
      } finally {
        done++;
        onProgress?.(done / total, `Collected asset ${done}/${total}`);
      }
    }
    return results;
  } catch (error) {
    console.warn("Failed to list assets:", error.message);
    return [];
  }
}

/* Trending */
async function loadTrending() {
  $("#trending-list").innerHTML = `<div class="hint">Loading…</div>`;
  try {
    const data = await api.getTrending(0, 50);
    const items = (data.items || data.projects || data) ?? [];
    // Normalize possibly nested structures
    const projects = items.map(x => x.project || x.site || x).map(p => ({
      id: p.id, title: p.title, current_version: p.current_version, slug: p.slug, created_by: p.created_by || p.owner
    }));
    renderProjects($("#trending-list"), projects);
  } catch (e) {
    $("#trending-list").innerHTML = `<div class="hint">Failed to load trending: ${e.message}</div>`;
  }
}
$("#refresh-trending").addEventListener("click", loadTrending);
loadTrending();

/* User projects */
$("#user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const user = $("#user-handle").value.trim();
  if (!user) return;
  $("#user-list").innerHTML = `<div class="hint">Loading…</div>`;
  try {
    const data = await api.listUserProjects(user);
    const list = data.items || data.projects || data || [];
    renderProjects($("#user-list"), list);
  } catch (err) {
    $("#user-list").innerHTML = `<div class="hint">Error: ${err.message}</div>`;
  }
});

/* Following projects */
$("#following-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const user = $("#following-handle").value.trim();
  if (!user) return;
  $("#following-list").innerHTML = `<div class="hint">Loading…</div>`;
  try {
    const data = await api.listFollowing(user);
    const list = data.items || data.projects || data || [];
    renderProjects($("#following-list"), list);
  } catch (err) {
    $("#following-list").innerHTML = `<div class="hint">Error or not available publicly: ${err.message}</div>`;
  }
});

/* Search */
$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#search-query").value.trim();
  const sort = $("#search-sort").value;
  if (!q) return;
  $("#search-list").innerHTML = `<div class="hint">Searching…</div>`;
  try {
    const data = await api.searchFeed(sort, q, { limit: 50 });
    const items = data.items || data.results || data || [];
    const projects = items.map(x => x.project || x).filter(Boolean);
    renderProjects($("#search-list"), projects);
  } catch (err) {
    $("#search-list").innerHTML = `<div class="hint">Search failed: ${err.message}</div>`;
  }
});

/* Quick form */
$("#quick-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("#quick-input").value.trim();
  if (!v) return;
  await startZip(v);
});

function isURL(s) { try { new URL(s); return true; } catch { return false; } }
function abs(u, base) { try { return new URL(u, base).toString(); } catch { return u; } }