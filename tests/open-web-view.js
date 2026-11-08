const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
  if (typeof process.loadEnvFile !== "function") {
    throw new Error("Loading .env requires Node.js 20.12 or newer. Upgrade Node or set VEGA_BROWSER_PATH in your shell.");
  }
  // Node preserves variables already set in the shell.
  process.loadEnvFile(envFile);
}

// CLI equivalent of the app's interactive openWebView dialog.
async function openWebView(url, options = {}) {
  const { chromium } = require("playwright-core");
  const launchOptions = { headless: false };
  const executablePath = process.env.VEGA_BROWSER_PATH?.trim();
  if (executablePath && (!path.isAbsolute(executablePath) || !fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile())) {
    throw new Error("VEGA_BROWSER_PATH must be an absolute path to an existing Chromium browser executable.");
  }
  const browser = await (executablePath
    ? chromium.launch({ ...launchOptions, executablePath })
    : chromium.launch({ ...launchOptions, channel: "msedge" })
    .catch(() => chromium.launch({ ...launchOptions, channel: "chrome" }))
  )
    .catch((error) => {
      throw new Error(`WAF browser could not start. Check VEGA_BROWSER_PATH or install Microsoft Edge or Google Chrome. ${error.message}`);
    });
  let input;
  let timer;
  let closed = false;
  let done = false;
  let bridgeData;
  try {
    const userAgent = options.headers?.["User-Agent"] || options.headers?.["user-agent"];
    const context = await browser.newContext({
      viewport: null,
      ...(userAgent ? { userAgent } : {}),
      ...(options.headers ? { extraHTTPHeaders: options.headers } : {}),
    });
    await context.exposeBinding("__vegaTestMessage", (_source, message) => {
      let payload = message;
      if (typeof message === "string") {
        try { payload = JSON.parse(message); } catch {}
      }
      const data = payload?.data ?? payload?.token ?? payload;
      bridgeData = typeof data === "string" ? data : JSON.stringify(data);
      done = true;
    });
    await context.addInitScript(() => {
      window.ReactNativeWebView = {
        postMessage: (message) => window.__vegaTestMessage(message),
      };
    });
    if (options.injectedJavaScript) {
      // Run on every navigation, including redirects after verification.
      await context.addInitScript((script) => {
        window.addEventListener("DOMContentLoaded", () => {
          try { (0, eval)(script); } catch (error) { console.warn(error); }
        }, { once: true });
      }, options.injectedJavaScript);
    }
    const page = await context.newPage();
    page.on("close", () => { closed = true; });
    browser.on("disconnected", () => { closed = true; });
    console.log(`[WAF] ${options.title || "Complete verification"}: ${url}`);
    if (options.description) console.log(options.description);
    console.log("Complete the challenge in the browser. Press Enter here when finished.");
    if (process.stdin.isTTY) {
      input = readline.createInterface({ input: process.stdin, output: process.stdout });
      input.on("line", () => { done = true; });
      input.on("SIGINT", () => { closed = true; });
    }
    const timeoutMs = options.timeoutMs ?? 120000;
    const deadline = Date.now() + timeoutMs;
    // Close the page on timeout to interrupt an in-progress navigation as well.
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      browser.close().catch(() => {});
    }, timeoutMs);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 35000) });
    } catch (error) {
      if (!closed && !timedOut) console.warn(`[WAF] Navigation: ${error.message}`);
    }
    while (Date.now() < deadline && !timedOut) {
      if (closed) throw new Error("WAF_DIALOG_CANCELLED: Browser window was closed");
      const cookies = await context.cookies(page.url());
      const cookieReady = options.waitForCookie && cookies.some(
        (cookie) => cookie.name === options.waitForCookie && cookie.value,
      );
      if (done || cookieReady) {
        const cookieMap = Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value]));
        const cookieString = Object.entries(cookieMap).map(([key, value]) => `${key}=${value}`).join("; ");
        return {
          data: bridgeData ?? await page.content(),
          cookies: cookieString,
          cookie: cookieString,
          cookieMap,
          url: page.url(),
          userAgent: await page.evaluate(() => navigator.userAgent),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`WAF_TIMEOUT: Solver timed out after ${timeoutMs}ms`);
  } finally {
    clearTimeout(timer);
    input?.close();
    await browser.close().catch(() => {});
  }
}

module.exports = { openWebView };
