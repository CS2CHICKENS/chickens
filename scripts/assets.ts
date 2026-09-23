import { run } from "./cli";
import { buildBrandAssets } from "./branding";
import sharp from "sharp";
import { readdir, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";

async function main() {
  const source = join("private", "assets-src", "CS2 Chickens"),
    output = join("apps", "web", "public", "img"),
    cache = join("private", "upscaled");
  await mkdir(output, { recursive: true });
  await mkdir(cache, { recursive: true });
  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((e) =>
          e.isDirectory()
            ? walk(join(dir, e.name))
            : Promise.resolve([join(dir, e.name)]),
        ),
      )
    ).flat();
  }
  const files = (await walk(source)).filter((p) => p.endsWith(".png"));
  try {
    files.push(
      ...(await walk(join("private", "assets-generated"))).filter((p) =>
        p.endsWith(".png"),
      ),
    );
  } catch {}
  const upscaler = process.env.UPSCALER_BIN || "realesrgan-ncnn-vulkan";
  const check = spawnSync(upscaler, ["--version"], {
    windowsHide: true,
    stdio: "ignore",
  });
  const available = !check.error;
  const selection = process.argv
    .find((v) => v.startsWith("--only="))
    ?.slice(7)
    .split(",");
  const manifest: Record<string, unknown> = selection
    ? JSON.parse(
        await readFile(join(output, "manifest.json"), "utf8").catch(() => "{}"),
      )
    : {};
  for (const path of files) {
    const name = basename(path, ".png");
    const id =
      name === "CS2Chickens-banner"
        ? "banner"
        : name === "CS2Chickens-avatar"
          ? "avatar"
          : name.replace(/^chicken-/, "");
    if (selection && !selection.includes(id)) continue;
    const meta = await sharp(path).metadata(),
      originalWidth = meta.width!;
    const character = ![
      "banner",
      "avatar",
      "incubator",
      "kitchen",
      "nest",
      "cook-egg",
      "brand-logo",
      "brand-icon",
    ].includes(id);
    let rgba = await sharp(path).ensureAlpha().toBuffer();
    let upscaled = false;
    if ((character || id === "banner") && available) {
      const rgb = join(cache, id + "-rgb.png"),
        scaled = join(cache, id + "-4x.png");
      await sharp(rgba).flatten({ background: "#35332f" }).png().toFile(rgb);
      try {
        await access(scaled);
        upscaled = true;
      } catch {
        const result = spawnSync(
          upscaler,
          [
            "-i",
            rgb,
            "-o",
            scaled,
            "-s",
            "4",
            "-n",
            "realesrgan-x4plus",
            "-t",
            "128",
            "-m",
            join(dirname(upscaler), "models"),
          ],
          { windowsHide: true, stdio: "ignore", timeout: 240000 },
        );
        upscaled = result.status === 0;
      }
      if (upscaled) {
        const alpha = await sharp(rgba)
          .extractChannel(3)
          .resize(meta.width! * 4, meta.height! * 4)
          .raw()
          .toBuffer();
        const rgbOnly = await sharp(scaled).removeAlpha().png().toBuffer();
        rgba = await sharp(rgbOnly)
          .joinChannel(alpha, {
            raw: {
              width: meta.width! * 4,
              height: meta.height! * 4,
              channels: 1,
            },
          })
          .png()
          .toBuffer();
      }
    }
    if (character) {
      const trimmed = await sharp(rgba).trim({ threshold: 10 }).toBuffer();
      const canvas = await sharp(trimmed)
        .resize(896, 832, { fit: "inside" })
        .toBuffer();
      const cm = await sharp(canvas).metadata();
      rgba = await sharp({
        create: {
          width: 1024,
          height: 1024,
          channels: 4,
          background: "#00000000",
        },
      })
        .composite([
          {
            input: canvas,
            left: Math.round((1024 - cm.width!) / 2),
            top: 928 - cm.height!,
          },
        ])
        .png()
        .toBuffer();
    }
    const widths =
      id === "banner" ? [256, 512, 1024, 1920, 2560, 3840] : [256, 512, 1024];
    for (const width of widths) {
      await sharp(rgba)
        .resize({ width })
        .webp({ quality: id === "banner" ? 91 : 86 })
        .toFile(join(output, id + "-" + width + ".webp"));
      await sharp(rgba)
        .resize({ width })
        .avif({ quality: id === "banner" ? 68 : 58, effort: 3 })
        .toFile(join(output, id + "-" + width + ".avif"));
    }
    await sharp(rgba)
      .resize({ width: 24 })
      .blur(1)
      .webp({ quality: 35 })
      .toFile(join(output, id + "-blur.webp"));
    if (character) {
      const alpha = await sharp(rgba).extractChannel(3).raw().toBuffer();
      await sharp({
        create: {
          width: 1024,
          height: 1024,
          channels: 3,
          background: "#07090a",
        },
      })
        .joinChannel(alpha, { raw: { width: 1024, height: 1024, channels: 1 } })
        .resize(512)
        .webp()
        .toFile(join(output, id + "-locked.webp"));
      await sharp(rgba)
        .resize(256)
        .blur(20)
        .modulate({ saturation: 1.4, brightness: 1.2 })
        .webp()
        .toFile(join(output, id + "-glow.webp"));
    }
    manifest[id] = {
      originalWidth,
      upscaled,
      maxDisplayWidth:
        id === "banner" && upscaled
          ? 3840
          : upscaled
            ? 1024
            : originalWidth * 1.5,
    };
    console.log("Processed " + id + (upscaled ? " (4x)" : " (native)"));
  }
  await buildBrandAssets();
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  console.log(
    "Asset processing complete; exported files contain no source metadata.",
  );
}
run(main);
