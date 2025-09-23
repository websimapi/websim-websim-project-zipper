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
    // Try forms like /{user}/slugs/{slug} or /{user}/projects/{slug}
    if (parts.length >= 3 && parts[1] === "slugs") {
      return api.getProjectBySlug(parts[0], parts[2]);
    }
    if (parts.length >= 3 && parts[1] === "projects") {
      return api.getProjectBySlug(parts[0], parts[2]);
    }
    // Fallback: if it looks like an id at the end
    return api.getProjectById(parts.at(-1));
  } catch {
    // Not a URL
    if (input.includes("/")) {
      const [user, slug] = input.split("/");
      return api.getProjectBySlug(user, slug);
    }
    return api.getProjectById(input);
  }
}

async function collectAssets(projectId, version, onProgress, signal) {
  const assetsIndex = await api.listAssets(projectId, version);
  const files = assetsIndex?.assets || assetsIndex || [];
  const total = files.length || 1;
  let done = 0;
  const limit = 6;
  const queue = [...files];
  const results = [];
  async function worker() {
    while (queue.length) {
      if (signal?.aborted) throw new Error("cancelled");
      const f = queue.shift();
      try {
        const data = await api.getAssetContent(projectId, version, f.path || f);
        results.push({ path: f.path || f, data });
      } catch (e) {
        console.warn("asset failed", f.path || f, e);
      } finally {
        done++;
        onProgress?.(done / total, `Fetched ${f.path || f}`);
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, files.length || 1) }, worker);
  await Promise.all(workers.map(fn => fn()));
  return results;
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
    progressSection.hidden = false; // ensure visible early
    const signal = withProgress("Resolving project…");
    if (typeof projectLikeOrIdOrSlugInput === "object" && projectLikeOrIdOrSlugInput.id) {
      project = projectLikeOrIdOrSlugInput;
    } else {
      project = await resolveProject(String(projectLikeOrIdOrSlugInput));
    }
    const version = project.current_version ?? project.version ?? 1;

    updateProgress(0.02, "Fetching HTML…");
    const [html, revision] = await Promise.all([
      api.getRevisionHTML(project.id, version).catch(() => ""),
      api.getRevision(project.id, version).catch(() => null)
    ]);

    updateProgress(0.05, "Listing assets…");
    const assets = await collectAssets(project.id, version, updateProgress, currentAbort);

    updateProgress(0.85, "Building zip…");
    const blob = await zipProject(project, { assets, html, revision }, updateProgress, currentAbort);
    const name = (project.title || project.slug || project.id) + ".zip";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    if (String(e.message).includes("cancelled")) {
      // silent
    } else {
      alert(`Download failed: ${e.message}`);
    }
  } finally {
    endProgress();
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

