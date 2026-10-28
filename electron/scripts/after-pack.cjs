// 1. copy the Next standalone server into Resources/server verbatim (ditto keeps node_modules +
//    turbopack's .next/node_modules symlinks, which electron-builder's file copier drops)
// 2. identity:null skips signing; Apple Silicon wants a coherent signature → ad-hoc sign the bundle
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== "darwin") return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const standalone = path.join(ctx.packager.projectDir, ".next", "standalone");
  const dest = path.join(app, "Contents", "Resources", "server");
  fs.rmSync(dest, { recursive: true, force: true });
  execFileSync("ditto", [standalone, dest], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
