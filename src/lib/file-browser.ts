/** File Browser (filebrowser/filebrowser) opens a directory at `{base}/files/{path}/`. */
export function fileBrowserHref(baseUrl: string, filePath: string, root = ""): string | null {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const file = filePath.trim().replace(/\\/g, "/");
  if (!base || !file) return null;

  const slash = file.lastIndexOf("/");
  let directory = slash > 0 ? file.slice(0, slash) : "/";
  const prefix = root.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (prefix) {
    const rooted = directory === prefix || directory.startsWith(`${prefix}/`);
    if (!rooted) return null;
    directory = directory.slice(prefix.length) || "/";
  }
  if (!directory.startsWith("/")) directory = `/${directory}`;

  const encoded = directory
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/files${encoded}/`;
}
