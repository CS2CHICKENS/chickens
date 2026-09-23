import { run } from "./cli";
import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { createHmac, createHash } from "node:crypto";

async function main() {
  const account = process.env.R2_ACCOUNT_ID,
    key = process.env.R2_ACCESS_KEY_ID,
    secret = process.env.R2_SECRET_ACCESS_KEY,
    bucket = process.env.R2_BUCKET || "coop-assets";
  if (!account || !key || !secret) throw Error("R2 environment required.");
  if (!process.argv.includes("--execute"))
    throw Error("Operator upload requires --execute.");
  const root = join("apps", "web", "public", "img"),
    hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
  const hmac = (k: string | Buffer, v: string) =>
    createHmac("sha256", k).update(v).digest();
  for (const file of await readdir(root)) {
    const body = await readFile(join(root, file)),
      date = new Date().toISOString().replace(/[:-]|\.[0-9]{3}/g, ""),
      day = date.slice(0, 8),
      host = account + ".r2.cloudflarestorage.com",
      path = "/" + bucket + "/" + encodeURIComponent(file),
      digest = hash(body);
    const canonical = [
      "PUT",
      path,
      "",
      "host:" +
        host +
        "\nx-amz-content-sha256:" +
        digest +
        "\nx-amz-date:" +
        date +
        "\n",
      "host;x-amz-content-sha256;x-amz-date",
      digest,
    ].join("\n");
    const scope = day + "/auto/s3/aws4_request",
      signing = hmac(
        hmac(hmac(hmac("AWS4" + secret, day), "auto"), "s3"),
        "aws4_request",
      );
    const signature = createHmac("sha256", signing)
      .update(
        "AWS4-HMAC-SHA256\n" + date + "\n" + scope + "\n" + hash(canonical),
      )
      .digest("hex");
    const types: Record<string, string> = {
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".webmanifest": "application/manifest+json",

      ".webp": "image/webp",
      ".avif": "image/avif",
      ".json": "application/json",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
    };
    const response = await fetch("https://" + host + path, {
      method: "PUT",
      headers: {
        "x-amz-date": date,
        "x-amz-content-sha256": digest,
        authorization:
          "AWS4-HMAC-SHA256 Credential=" +
          key +
          "/" +
          scope +
          ", SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=" +
          signature,
        "content-type": types[extname(file)] || "application/octet-stream",
        "cache-control": "public, max-age=86400",
      },
      body,
    });
    if (!response.ok)
      throw Error("Upload failed for " + file + ": " + response.status);
    console.log("Uploaded " + file);
  }
}
run(main);
