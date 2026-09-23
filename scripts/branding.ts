import sharp from "sharp";
import { access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli";

export async function buildBrandAssets() {
  const source = join("private", "assets-generated");
  const output = join("apps", "web", "public", "img");
  const logo = join(source, "brand-logo.png"),
    icon = join(source, "brand-icon.png");
  try {
    await access(logo);
    await access(icon);
  } catch {
    console.log("Brand sources absent; existing exports retained.");
    return;
  }
  for (const size of [16, 32, 48, 64, 192, 512])
    await sharp(icon)
      .resize(size, size)
      .png()
      .toFile(join(output, "brand-icon-" + size + ".png"));
  for (const [name, size] of [
    ["apple-touch-icon", 180],
    ["brand-maskable", 512],
  ] as const) {
    const inner = Math.round(size * 0.78);
    const mark = await sharp(icon).resize(inner, inner).png().toBuffer();
    await sharp({
      create: { width: size, height: size, channels: 4, background: "#111316" },
    })
      .composite([{ input: mark, gravity: "centre" }])
      .png()
      .toFile(join(output, name + ".png"));
  }
  const sizes = [16, 32, 48],
    frames = await Promise.all(
      sizes.map((size) => sharp(icon).resize(size, size).png().toBuffer()),
    );
  const directory = Buffer.alloc(6 + 16 * frames.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach((frame, i) => {
    const start = 6 + i * 16;
    directory[start] = sizes[i];
    directory[start + 1] = sizes[i];
    directory.writeUInt16LE(1, start + 4);
    directory.writeUInt16LE(32, start + 6);
    directory.writeUInt32LE(frame.length, start + 8);
    directory.writeUInt32LE(offset, start + 12);
    offset += frame.length;
  });
  await writeFile(
    join(output, "brand-favicon.ico"),
    Buffer.concat([directory, ...frames]),
  );
  const wordmark = await sharp(logo).resize({ width: 1040 }).png().toBuffer();
  await sharp({
    create: { width: 1200, height: 630, channels: 4, background: "#111316" },
  })
    .composite([{ input: wordmark, gravity: "centre" }])
    .png()
    .toFile(join(output, "brand-social.png"));
  console.log("Brand icons and share card exported without metadata.");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  run(buildBrandAssets);
