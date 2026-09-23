export function run(main: () => Promise<void>) {
  void main().catch((error: unknown) => {
    const issue = error as {
      code?: string;
      shortMessage?: string;
      message?: string;
    };
    const message =
      issue.code === "ENOENT"
        ? "Required local input is missing."
        : issue.shortMessage ||
          issue.message?.split("\n")[0] ||
          "Command failed.";
    const sanitized = message
      .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, "[local resource]")
      .replace(/https?:[^\s]+/g, "[endpoint]");
    console.error(sanitized);
    process.exitCode = 1;
  });
}
