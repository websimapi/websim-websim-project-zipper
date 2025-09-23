const BASE = "https://api.websim.com";

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { headers: { "accept": "application/json" }, ...opts });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export const api = {
  async getTrending(offset = 0, limit = 50) {
    const u = new URL(`${BASE}/api/v1/feed/trending`);
    u.searchParams.set("offset", offset);
    u.searchParams.set("limit", limit);
    return fetchJSON(u.toString());
  },
  async getUser(user) {
    return fetchJSON(`${BASE}/api/v1/users/${encodeURIComponent(user)}`);
  },
  async listUserProjects(user) {
    return fetchJSON(`${BASE}/api/v1/users/${encodeURIComponent(user)}/projects`);
  },
  async listFollowing(user) {
    return fetchJSON(`${BASE}/api/v1/users/${encodeURIComponent(user)}/following/projects`);
  },
  async getProjectById(id) {
    return fetchJSON(`${BASE}/api/v1/projects/${encodeURIComponent(id)}`);
  },
  async getProjectBySlug(user, slug) {
    return fetchJSON(`${BASE}/api/v1/users/${encodeURIComponent(user)}/slugs/${encodeURIComponent(slug)}`);
  },
  async getRevision(projectId, version) {
    return fetchJSON(`${BASE}/api/v1/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(version)}`);
  },
  async listAssets(projectId, version) {
    return fetchJSON(`${BASE}/api/v1/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(version)}/assets`);
  },
  async getAssetContent(projectId, version, path) {
    const encodedPath = encodeURIComponent(path).replaceAll("%2F", "/");
    const url = `${BASE}/api/v1/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(version)}/assets/${encodedPath}/content`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  },
  async getRevisionHTML(projectId, version) {
    const url = `${BASE}/api/v1/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(version)}/html`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.text();
  },
  async searchFeed(sort = "best", search = "", { offset = 0, limit = 50 } = {}) {
    const u = new URL(`${BASE}/api/v1/feed/search/${encodeURIComponent(sort)}/${encodeURIComponent(search)}`);
    u.searchParams.set("offset", offset);
    u.searchParams.set("limit", limit);
    return fetchJSON(u.toString());
  },
  async findProjectByGuess(term) {
    const sorts = ["best", "newest", "best_template"];
    for (const s of sorts) {
      try {
        const data = await this.searchFeed(s, term, { limit: 10 });
        const items = data.items || data.results || data || [];
        const projects = items.map(x => x.project || x).filter(Boolean);
        const exact = projects.find(p => p.slug === term || String(p.id) === term);
        const chosen = exact || projects[0];
        if (chosen?.id) return this.getProjectById(chosen.id);
      } catch { /* ignore and try next sort */ }
    }
    throw new Error("Project not found by guess");
  }
};