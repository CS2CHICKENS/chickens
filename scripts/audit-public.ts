import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const forbidden = [
  "cl" + "aude",
  "anth" + "ropic",
  "chat" + "gpt",
  "open" + "ai",
  "l" + "lm",
];
const paths = [
  "/" + "home/",
  "/" + "Users/",
  "C:" + "\\" + "Users",
  "C:" + "/Users",
  "/c/" + "Users",
];
const errors: string[] = [];
for (const path of files) {
  if (path === ".gitignore" || path.startsWith(".githooks/")) continue;
  if (
    path
      .split("/")
      .some(
        (p) =>
          p === "private" ||
          p === "AGENTS.md" ||
          (p.startsWith(".env") && p !== ".env.example"),
      )
  )
    errors.push("Forbidden path: " + path);
  if (/\.(png|webp|avif|mp4|webm|pem|key)$/.test(path))
    errors.push("Unexpected asset: " + path);
  try {
    const content = readFileSync(path, "utf8");
    if (paths.some((p) => content.includes(p)))
      errors.push("Local path in " + path);
    if (forbidden.some((p) => new RegExp("\\b" + p + "\\b", "i").test(content)))
      errors.push("Disallowed wording in " + path);
  } catch {
    errors.push("Unreadable file: " + path);
  }
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else console.log("Public repository audit passed.");
