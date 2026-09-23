import { spawnSync } from "node:child_process";
for (const project of ["tsconfig.json", "apps/web/tsconfig.json"]) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "--noEmit", "-p", project],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
