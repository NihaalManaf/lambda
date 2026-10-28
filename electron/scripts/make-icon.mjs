// Renders electron/build/icon.icns: lowercase STIX "λ" in ink on a paper squircle, faint lilac glow.
// node electron/scripts/make-icon.mjs   (needs playwright's chromium + macOS iconutil/sips)
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.join(here, "..", "build");
const font = fs.readFileSync(path.join(build, "stix-greek.woff2")).toString("base64");

const html = `<!doctype html><html><head><style>
@font-face{font-family:STIX;src:url(data:font/woff2;base64,${font}) format("woff2")}
html,body{margin:0;width:1024px;height:1024px;background:transparent}
.tile{position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:186px;overflow:hidden;
  background:radial-gradient(120% 90% at 50% 0%,#ffffff 0%,#f8f8f6 55%,#efede7 100%);
  box-shadow:0 22px 40px -12px rgba(24,24,24,.38),0 2px 6px rgba(24,24,24,.12),inset 0 0 0 1.5px rgba(24,24,24,.06)}
.glow{position:absolute;left:50%;top:52%;width:560px;height:560px;transform:translate(-50%,-50%);
  background:radial-gradient(circle,rgba(231,163,255,.55) 0%,rgba(231,163,255,.18) 42%,rgba(231,163,255,0) 70%);filter:blur(8px)}
.l{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-family:STIX,"Times New Roman",serif;font-size:640px;line-height:1;color:#181818;padding-top:110px;
  text-shadow:0 0 60px rgba(231,163,255,.6)}
</style></head><body><div class="tile"><div class="glow"></div><div class="l">λ</div></div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
const master = path.join(build, "icon-1024.png");
await page.screenshot({ path: master, omitBackground: true });
await browser.close();

const set = fs.mkdtempSync(path.join(os.tmpdir(), "lambda-icon-")) + "/icon.iconset";
fs.mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) {
  execFileSync("sips", ["-z", String(s), String(s), master, "--out", `${set}/icon_${s}x${s}.png`], { stdio: "ignore" });
  execFileSync("sips", ["-z", String(s * 2), String(s * 2), master, "--out", `${set}/icon_${s}x${s}@2x.png`], { stdio: "ignore" });
}
execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(build, "icon.icns")]);
console.log("wrote", path.join(build, "icon.icns"));
