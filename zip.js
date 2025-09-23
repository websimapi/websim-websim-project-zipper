import JSZip from "jszip";

function safeName(s) {
  return String(s || "project").replace(/[^\w\-\.\s]/g, "_");
}

export async function zipProject(project, { assets, html, revision }, onProgress, signal) {
  const zip = new JSZip();
  const root = zip.folder(safeName(project.title || project.slug || project.id));

  root.file("project.json", JSON.stringify({ project, revision }, null, 2));
  if (html) root.file("index.html", html);

  const total = assets.length;
  let done = 0;

  for (const a of assets) {
    if (signal?.aborted) throw new Error("cancelled");
    root.file(a.path, a.data);
    done++;
    onProgress?.(done / total, `Added ${a.path}`);
  }

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } }, (meta) => {
    onProgress?.(done / total, `Compressing… ${Math.round(meta.percent)}%`);
  });
  return blob;
}

