// Maps file names to Shiki/TextMate language ids.
import { bundledLanguagesInfo } from "shiki";
import { basename } from "./api";

const byExtension: Record<string, string> = {
  cs: "csharp", csx: "csharp", razor: "razor", cshtml: "razor",
  csproj: "xml", props: "xml", targets: "xml", slnx: "xml", xml: "xml", xaml: "xml",
  config: "xml", resx: "xml", nuspec: "xml", axaml: "xml", sln: "ini",
  fs: "fsharp", fsx: "fsharp", vb: "vb",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "json5",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  vue: "vue", svelte: "svelte",
  md: "markdown", markdown: "markdown", mdx: "mdx",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", env: "dotenv",
  py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  ps1: "powershell", psm1: "powershell", bat: "bat", cmd: "bat",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "docker", lua: "lua", rb: "ruby", php: "php", swift: "swift", dart: "dart",
  proto: "proto", tf: "terraform", diff: "diff", patch: "diff", log: "log",
};

const byName: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  ".editorconfig": "ini",
  "directory.build.props": "xml",
  "directory.packages.props": "xml",
};

const known = new Set(bundledLanguagesInfo.flatMap((l) => [l.id, ...(l.aliases ?? [])]));

/** Returns a Shiki language id for the file, or "plaintext". */
export function languageForPath(path: string): string {
  const name = basename(path).toLowerCase();
  const lang = byName[name] ?? byExtension[name.includes(".") ? name.split(".").pop()! : ""];
  return lang && known.has(lang) ? lang : "plaintext";
}

const display = new Map(bundledLanguagesInfo.map((l) => [l.id, l.name]));
export const languageName = (id: string) => (id === "plaintext" ? "Plain Text" : display.get(id) ?? id);
