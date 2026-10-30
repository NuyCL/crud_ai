// Loads a page from http://localhost:PAGE_PORT in Chromium and uses the SDK bundle (sdk-js/dist/index.umd.js) to call
// a running service, so the browser itself enforces CORS (BR-56). Node cannot test this: it has no CORS.
//
//   EXPECT=allowed  the service was started with CORS_ORIGINS=http://localhost:9001 -> calls succeed
//   EXPECT=blocked  the service was started without CORS_ORIGINS                     -> calls are blocked
//
// Env: SVC_URL (default http://localhost:8080), PAGE_PORT (9001), ADMIN_KEY, CLIENT_KEY (test keys).
import { readFileSync } from "node:fs";
import http from "node:http";
import { chromium } from "playwright";

const SVC = (process.env.SVC_URL ?? "http://localhost:8080").replace(/\/$/, "");
const PAGE_PORT = Number(process.env.PAGE_PORT ?? 9001);
const ADMIN_KEY = process.env.ADMIN_KEY ?? "test-admin-key";
const CLIENT_KEY = process.env.CLIENT_KEY ?? "test-client-key";
const EXPECT = process.env.EXPECT ?? "allowed";
if (!["allowed", "blocked"].includes(EXPECT)) throw new Error("EXPECT must be allowed or blocked");

const bundle = readFileSync(new URL("../../sdk-js/dist/index.umd.js", import.meta.url));
const server = http
  .createServer((req, res) => {
    if (req.url === "/sdk.js") res.writeHead(200, { "content-type": "text/javascript" }).end(bundle);
    else res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><script src="/sdk.js"></script>');
  })
  .listen(PAGE_PORT);

const key = `cors-demo-${Date.now()}`;
const created = await fetch(`${SVC}/v1/flags`, {
  method: "POST",
  headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" },
  body: JSON.stringify({ key, enabled: true }),
});
if (created.status !== 201) throw new Error(`could not create the flag: ${created.status}`);

const browser = await chromium.launch();
let failures = 0;
try {
  const page = await browser.newPage();
  const failed = [];
  const statuses = [];
  page.on("requestfailed", (r) => failed.push(`${r.method()} ${r.url().replace(SVC, "")}`));
  page.on("response", (r) => {
    if (r.url().startsWith(SVC)) statuses.push(`${r.status()} ${r.request().method()} ${r.url().replace(SVC, "")}`);
  });
  await page.goto(`http://localhost:${PAGE_PORT}/`);
  const enabled = await page.evaluate(
    async ({ svc, clientKey, flag }) => {
      const ff = new globalThis.FeatureFlags.FlagClient({ baseUrl: svc, clientKey, user: { id: "u1" }, pollIntervalMs: 0 });
      await ff.ready();
      const on = ff.isEnabled(flag, false);
      ff.track("purchase");
      await ff.flush();
      ff.close();
      return on;
    },
    { svc: SVC, clientKey: CLIENT_KEY, flag: key },
  );

  const ok =
    EXPECT === "allowed"
      ? enabled === true && failed.length === 0 && statuses.includes("200 POST /v1/evaluate") && statuses.includes("202 POST /v1/events")
      : enabled === false && failed.length === 2;
  console.log(`${ok ? "ok" : "FAIL"}: EXPECT=${EXPECT} isEnabled=${enabled} responses=[${statuses.join(", ")}] blocked=[${failed.join(", ")}]`);
  if (!ok) failures++;
} finally {
  await browser.close();
  await fetch(`${SVC}/v1/flags/${key}`, { method: "DELETE", headers: { "x-admin-key": ADMIN_KEY } }).catch(() => undefined);
  server.close();
}
process.exit(failures === 0 ? 0 : 1);
