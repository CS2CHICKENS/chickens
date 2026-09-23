import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const reject = () => {
  console.error("repo hygiene: check rejected");
  process.exit(1);
};
const git = (...args) => {
  const r = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) reject();
  return r.stdout;
};
const names = [
  "cl" + "aude",
  "anth" + "ropic",
  "chat" + "gpt",
  "open" + "ai",
  "l" + "lm",
];
if (process.argv[2] === "message") {
  const pattern = new RegExp(
    [
      ...names,
      "\\ba" + "i\\b",
      "co-authored-by",
      "generated with",
      String.fromCodePoint(0x1f916),
    ].join("|"),
    "i",
  );
  if (pattern.test(readFileSync(process.argv[3], "utf8"))) reject();
} else {
  if (process.env.TZ !== "UTC") reject();
  const paths = git(
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
    "-z",
  )
    .split("\0")
    .filter(Boolean);
  const personal = [
    "/" + "home/",
    "/" + "Users/",
    "C:" + "\\" + "Users",
    "C:" + "\\\\" + "Users",
    "C:" + "/Users",
    "/c/" + "Users",
  ];
  for (const path of paths) {
    if (
      path
        .split("/")
        .some(
          (p) =>
            /^(AGENTS\.md|CLAUDE.*|\.claude|\.codex|\.agents|private)$/i.test(
              p,
            ) ||
            (p.startsWith(".env") && p !== ".env.example"),
        )
    )
      reject();
    const content = git("show", ":" + path);
    if (personal.some((value) => content.includes(value)))
      reject();
  }
  const scan = spawnSync(
    "gitleaks",
    ["protect", "--staged", "--redact", "--no-banner"],
    { stdio: "inherit", windowsHide: true },
  );
  if (scan.error || scan.status !== 0) reject();
}
