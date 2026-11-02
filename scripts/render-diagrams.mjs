// Renders the Excalidraw sources in docs/diagrams-src to the SVG files the
// documentation site embeds from docs/public/diagrams. The export runs in a
// browser, so it needs Chrome or Chromium: CHROME_PATH names the binary,
// otherwise the usual install locations and the PATH are searched.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const SOURCE_DIR = "docs/diagrams-src";
const OUTPUT_DIR = "docs/public/diagrams";
const EXPORT_TIMEOUT_MS = 120_000;

const WINDOWS_BROWSERS = [
  join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
  join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
];
const MAC_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const PATH_BROWSERS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome.exe"];

function findOnPath(command) {
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return directories.map((directory) => join(directory, command)).find((candidate) => existsSync(candidate));
}

function resolveBrowser() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }
  const knownLocations =
    process.platform === "win32" ? WINDOWS_BROWSERS : process.platform === "darwin" ? MAC_BROWSERS : [];
  const found =
    knownLocations.find((candidate) => existsSync(candidate)) ?? PATH_BROWSERS.map(findOnPath).find(Boolean);
  if (!found) {
    throw new Error("No Chrome or Chromium binary found. Install one or set CHROME_PATH to its path.");
  }
  return found;
}

// Bundled into the page: exports every scene as an SVG string.
const EXPORT_ENTRY = `
import { exportScene } from "@excalidraw/utils";

window.exportDiagrams = async (sources) => {
  const svgs = {};
  for (const [name, source] of Object.entries(sources)) {
    const svg = await exportScene({
      type: "svg",
      data: { elements: source.elements, appState: source.appState },
      config: { padding: 20, environment: { loadFonts: async () => {} } },
    });
    svgs[name] = svg.outerHTML;
  }
  return svgs;
};
`;

// The top-level "title" of each source becomes the accessible name of its SVG.
function loadSources() {
  const files = readdirSync(SOURCE_DIR).filter((file) => file.endsWith(".excalidraw"));
  return Object.fromEntries(
    files.map((file) => {
      const source = JSON.parse(readFileSync(join(SOURCE_DIR, file), "utf8"));
      if (typeof source.title !== "string" || source.title === "") {
        throw new Error(`${join(SOURCE_DIR, file)} needs a non-empty "title" field`);
      }
      return [basename(file, ".excalidraw"), source];
    }),
  );
}

function addTitle(svg, title) {
  const escaped = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return svg.replace(/<svg[^>]*>/, (opening) => `${opening}<title>${escaped}</title>`);
}

async function bundleExporter() {
  const result = await build({
    stdin: { contents: EXPORT_ENTRY, resolveDir: process.cwd(), loader: "js" },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  });
  return result.outputFiles[0].text;
}

// Chrome prints the DevTools port on stderr once it is listening.
function readDevToolsPort(chrome) {
  return new Promise((resolve, reject) => {
    let output = "";
    chrome.stderr.on("data", (chunk) => {
      output += chunk;
      const match = /DevTools listening on ws:\/\/[^:]+:(\d+)/.exec(output);
      if (match) {
        resolve(match[1]);
      }
    });
    chrome.once("exit", () => reject(new Error("Chrome exited before it opened the DevTools port")));
  });
}

async function findPageSocketUrl(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === "page" && target.url.startsWith("file:"));
    if (page) {
      return page.webSocketDebuggerUrl;
    }
    await sleep(100);
  }
  throw new Error("Chrome did not open the export page");
}

// Waits for the promise returned by exportDiagrams instead of a fixed time,
// so the export finishes before its result is read.
function evaluateExport(socketUrl, sources) {
  const expression = `new Promise((resolve, reject) => {
    const attempt = () => window.exportDiagrams
      ? window.exportDiagrams(${JSON.stringify(sources)}).then(resolve, reject)
      : setTimeout(attempt, 50);
    attempt();
  })`;
  const socket = new WebSocket(socketUrl);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the Excalidraw export")), EXPORT_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) {
        return;
      }
      clearTimeout(timer);
      socket.close();
      if (message.error) {
        reject(new Error(`DevTools request failed: ${message.error.message}`));
        return;
      }
      const exception = message.result.exceptionDetails;
      if (exception) {
        reject(new Error(`Excalidraw export failed in Chrome:\n${exception.exception?.description ?? exception.text}`));
      } else {
        resolve(message.result.result.value);
      }
    });
    socket.addEventListener("error", () => reject(new Error("DevTools connection to Chrome failed")));
  });
}

async function exportInChrome(workDir, exporterScript, sources) {
  const pagePath = join(workDir, "export.html");
  writeFileSync(pagePath, `<!doctype html>\n<html><body>\n<script>${exporterScript}</script>\n</body></html>\n`);
  const chrome = spawn(
    resolveBrowser(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(workDir, "profile")}`,
      pathToFileURL(pagePath).href,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    const port = await readDevToolsPort(chrome);
    const socketUrl = await findPageSocketUrl(port);
    return await evaluateExport(socketUrl, sources);
  } finally {
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill();
      await once(chrome, "exit");
    }
  }
}

const sources = loadSources();
const exporterScript = await bundleExporter();
const workDir = mkdtempSync(join(tmpdir(), "dak-diagrams-"));

try {
  const svgs = await exportInChrome(workDir, exporterScript, sources);
  for (const [name, svg] of Object.entries(svgs)) {
    writeFileSync(join(OUTPUT_DIR, `${name}.svg`), `${addTitle(svg, sources[name].title)}\n`);
    console.log(`rendered ${name}.svg`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
