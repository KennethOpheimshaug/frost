// File icons using Monaco's bundled codicon font, colored per file type.

const byExt: Record<string, [string, string]> = {
  cs: ["codicon-symbol-class", "#9b7bd4"],
  csproj: ["codicon-package", "#9b7bd4"],
  sln: ["codicon-library", "#9b7bd4"],
  slnx: ["codicon-library", "#9b7bd4"],
  razor: ["codicon-code", "#9b7bd4"],
  cshtml: ["codicon-code", "#9b7bd4"],
  ts: ["codicon-symbol-method", "#3178c6"],
  tsx: ["codicon-symbol-method", "#3178c6"],
  js: ["codicon-symbol-method", "#e8d44d"],
  jsx: ["codicon-symbol-method", "#e8d44d"],
  json: ["codicon-json", "#cbcb41"],
  jsonc: ["codicon-json", "#cbcb41"],
  md: ["codicon-markdown", "#519aba"],
  html: ["codicon-code", "#e44d26"],
  css: ["codicon-symbol-color", "#42a5f5"],
  scss: ["codicon-symbol-color", "#f06292"],
  xml: ["codicon-code", "#e37933"],
  yml: ["codicon-settings", "#a074c4"],
  yaml: ["codicon-settings", "#a074c4"],
  toml: ["codicon-settings", "#9c4221"],
  py: ["codicon-symbol-method", "#3572a5"],
  rs: ["codicon-symbol-method", "#dea584"],
  ps1: ["codicon-terminal-powershell", "#2671be"],
  sh: ["codicon-terminal", "#89e051"],
  png: ["codicon-file-media", "#a074c4"],
  jpg: ["codicon-file-media", "#a074c4"],
  svg: ["codicon-file-media", "#ffb13b"],
  zip: ["codicon-file-zip", "#afb42b"],
  pdf: ["codicon-file-pdf", "#e53935"],
  lock: ["codicon-lock", "#888888"],
};

export function fileIcon(name: string): { icon: string; color?: string } {
  const lower = name.toLowerCase();
  if (lower === ".gitignore" || lower === ".gitattributes") return { icon: "codicon-source-control", color: "#e44d26" };
  if (lower === "dockerfile") return { icon: "codicon-package", color: "#0db7ed" };
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  const hit = byExt[ext];
  return hit ? { icon: hit[0], color: hit[1] } : { icon: "codicon-file" };
}
