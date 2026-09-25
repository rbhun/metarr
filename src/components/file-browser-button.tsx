import { Button } from "@/components/ui/button";
import { fileBrowserHref } from "@/lib/file-browser";

export function FileBrowserButton({
  filePath,
  baseUrl,
  root = "",
}: {
  filePath: string | null;
  baseUrl: string;
  root?: string;
}) {
  const href = filePath ? fileBrowserHref(baseUrl, filePath, root) : null;
  if (!href) return null;
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={href} target="_blank" rel="noreferrer">
        Open in File Browser
      </a>
    </Button>
  );
}
