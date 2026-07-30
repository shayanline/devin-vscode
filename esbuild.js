const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const extensionCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "info"
  });

  const webviewCtx = await esbuild.context({
    entryPoints: ["webview/main.js"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    platform: "browser",
    target: "es2020",
    outfile: "dist/webview.js",
    logLevel: "info"
  });

  // Mermaid ships as its own bundle, injected on demand by the webview so its
  // multi-MB weight never loads unless a diagram actually appears.
  const mermaidCtx = await esbuild.context({
    entryPoints: ["webview/mermaid-entry.js"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    platform: "browser",
    target: "es2020",
    outfile: "dist/mermaid.js",
    logLevel: "info"
  });

  if (watch) {
    await Promise.all([extensionCtx.watch(), webviewCtx.watch(), mermaidCtx.watch()]);
  } else {
    await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild(), mermaidCtx.rebuild()]);
    await Promise.all([extensionCtx.dispose(), webviewCtx.dispose(), mermaidCtx.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
