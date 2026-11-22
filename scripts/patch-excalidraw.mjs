// Idempotently patches Excalidraw's freedraw renderer so each stroke can carry
// its own pen settings in element.customData.pen (see src/pens.js).
// Hook: globalThis.__penOptions(element, defaultOptions) -> perfect-freehand options
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("node_modules/@excalidraw/excalidraw/dist");
const MARK = "__penOptions";
let patched = 0;

for (const flavor of ["dev", "prod"]) {
  const dir = path.join(root, flavor);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const file = path.join(dir, f);
    let src = fs.readFileSync(file, "utf8");
    if (!src.includes("streamline")) continue;
    if (src.includes(MARK)) { patched++; continue; }
    const before = src;
    // dev (readable) build
    src = src.replace(
      "return getSvgPathFromStroke2(getStroke(inputPoints, options));",
      "return getSvgPathFromStroke2(getStroke(inputPoints, globalThis.__penOptions ? globalThis.__penOptions(element, options) : options));",
    );
    // prod (minified) build: ...last:!!e.lastCommittedPoint};return Om(vm(t,n))}
    src = src.replace(
      /last:!!(\w+)\.lastCommittedPoint\};return (\w+)\((\w+)\((\w+),(\w+)\)\)\}/,
      (_m, el, svg, stroke, pts, opts) =>
        `last:!!${el}.lastCommittedPoint};return ${svg}(${stroke}(${pts},globalThis.${MARK}?globalThis.${MARK}(${el},${opts}):${opts}))}`,
    );
    if (src !== before) {
      fs.writeFileSync(file, src);
      patched++;
      console.log("[patch-excalidraw] patched", path.relative(process.cwd(), file));
    }
  }
}
if (patched < 2) {
  console.error("[patch-excalidraw] WARNING: could not patch both dev and prod builds; custom pens will fall back to default ink.");
  process.exitCode = 0;
}

// Serve Excalidraw's fonts locally (window.EXCALIDRAW_ASSET_PATH = "/") so the app works offline.
const fontsSrc = path.join(root, "prod", "fonts");
const fontsDst = path.resolve("public", "fonts");
if (fs.existsSync(fontsSrc) && !fs.existsSync(fontsDst)) {
  fs.cpSync(fontsSrc, fontsDst, { recursive: true });
  console.log("[patch-excalidraw] copied fonts to public/fonts");
}
