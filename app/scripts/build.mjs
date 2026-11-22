// Static build (AWAI-3502): dist/ holds the whole app for the Tauri v3 shell.
// The repo's own .cljk domain is compiled with ClojureScript (as .cljc, the
// extension the compiler reads) together with src/cljs and the pinned
// kotoba.lang.text into one script, dist/domain.js. A compiler warning fails
// the build: a :clj-only form silently missing in ClojureScript must not ship.
import { mkdir, copyFile, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { spawnSync, execFileSync } from "node:child_process";
import { bundleModules } from "./guest-bundle.mjs";
import { checkNoSubmit } from "./check-no-submit.mjs";
import { fileURLToPath } from "node:url";
import { resolve, join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(root, "dist");
const meta = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const app = meta.itonami;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const pinFile of ["vendor/PINS.json", "vendor/cljs/PINS.json"]) {
  const pins = JSON.parse(await readFile(resolve(root, pinFile), "utf8"));
  for (const [name, digest] of Object.entries(pins.files)) {
    if (sha(await readFile(resolve(root, dirname(pinFile), name))) !== digest) throw new Error(`pin drift: ${pinFile} ${name}`);
  }
}

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}
const src = resolve(root, "build/cljs-src");
await rm(resolve(root, "build"), { recursive: true, force: true });
const copied = [];
for (const dir of [...app.cljsSources.map((d) => resolve(root, d)), resolve(root, "vendor/cljs"), resolve(root, "src/cljs")]) {
  for await (const f of walk(dir)) {
    if (!/\.clj[kcs]$/.test(f) || /\.clj\.cljk$/.test(f)) continue;
    const dest = join(src, relative(dir, f).replace(/\.cljk$/, ".cljc"));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(f, dest);
    copied.push(relative(src, dest));
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// cljs prints its warnings on stderr. JVM notices (sun.misc.Unsafe from the Closure jar) and the
// namespace-munging notice for a segment such as `methods` are not compiler findings about the code.
const r = spawnSync("clojure", ["-M", "-m", "cljs.main", "-co", "{:browser-repl false}", "-d", "build/cljs-out", "-o", "dist/domain.js", "-O", "advanced", "-c", "itonami.app.entry"],
  { cwd: root, encoding: "utf8" });
const log = (r.stdout ?? "") + (r.stderr ?? "");
if (r.status !== 0) throw new Error("ClojureScript build failed:\n" + log);
const findings = log.split("\n").filter((l) => /WARNING/.test(l)
  && !/sun\.misc\.Unsafe|Please consider reporting|will be removed in a future release|jarjar/.test(l)
  && !/contains a reserved JavaScript keyword, the corresponding Google Closure namespace will be munged/.test(l));
if (findings.length) throw new Error("ClojureScript warnings:\n" + findings.join("\n"));

// restricted-wasm-v1 (KOTOBA-159): dist/index.html is the trusted host (src/ui/host.html, host.js)
// with the canonical runtime; the app is one guest document (src/ui/guest.html) carrying the compiled
// domain (dist/domain.js, a classic script) and the app's modules inlined by guest-bundle.mjs, plus
// style.css inline, pinned by SHA-256 and the source commit. The page policy admits the runtime's
// guest preamble, the domain script, the app script and the style by hash. The modules are also
// written to .guest-modules/ for the tests (not shipped).
const def = (await readFile(resolve(root, "src/app-def.js"), "utf8"))
  .replace("__TITLE__", JSON.stringify(app.title)).replace("__DESCRIPTION__", JSON.stringify(app.description))
  .replace("__DID__", JSON.stringify(`did:web:${app.storageKey.split(".")[1]}.itonami.cloud`)).replace("__STORAGE_KEY__", JSON.stringify(app.storageKey));
const modules = { "app.js": await readFile(resolve(root, "src/ui/app.js"), "utf8"), "app-def.js": def };
for (const name of ["local-store.js", "guest-form.js"]) modules[name] = await readFile(resolve(root, "src", name), "utf8");
const modulesOut = resolve(root, ".guest-modules");
await rm(modulesOut, { recursive: true, force: true });
await mkdir(modulesOut, { recursive: true });
for (const [name, text] of Object.entries(modules)) await writeFile(join(modulesOut, name), text);
await copyFile(join(out, "domain.js"), join(modulesOut, "domain.js"));
const guestScript = bundleModules(modules, "app.js");
checkNoSubmit(guestScript, "the restricted guest script");
const domain = await readFile(join(out, "domain.js"), "utf8");
if (/<\/script/i.test(domain)) throw new Error("domain.js contains </script");
const guestStyle = await readFile(resolve(root, "src/ui/style.css"), "utf8");
if (/<\/style/i.test(guestStyle)) throw new Error("src/ui/style.css contains </style");
const pins = JSON.parse(await readFile(resolve(root, "vendor/PINS.json"), "utf8"));
const runtimeText = await readFile(resolve(root, "vendor/kotoba-client-runtime.js"), "utf8");
const preamble = /^const GUEST_PREAMBLE = '<script>([^'\\]*)<\/script>';$/m.exec(runtimeText)?.[1];
if (!preamble) throw new Error("the canonical runtime has no GUEST_PREAMBLE this build can hash");
const cspHash = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const CSP = `default-src 'none'; script-src 'self' ${cspHash(preamble)} ${cspHash(domain)} ${cspHash(guestScript)}; style-src 'self' ${cspHash(guestStyle)}; img-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
const confPath = resolve(root, "src-tauri/tauri.conf.json");
const conf = JSON.parse(await readFile(confPath, "utf8"));
if (conf.app.security.csp !== CSP) {
  if (!process.argv.includes("--update-csp")) throw new Error("tauri.conf.json CSP is not the one derived from the guest; run `node scripts/build.mjs --update-csp` and commit it");
  conf.app.security.csp = CSP;
  await writeFile(confPath, JSON.stringify(conf) + "\n");
}
let commit = null; let dirty = false;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "";
} catch { commit = process.env.ITONAMI_SOURCE_COMMIT ?? null; dirty = process.env.ITONAMI_SOURCE_DIRTY === "true"; }
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("restricted-wasm-v1 pins the guest to its source commit: build from a git checkout or set ITONAMI_SOURCE_COMMIT");
const template = await readFile(resolve(root, "src/ui/guest.html"), "utf8");
for (const marker of ["{{STYLE}}", "{{DOMAIN}}", "{{SCRIPT}}"]) if (template.split(marker).length !== 2) throw new Error(`guest.html must contain ${marker} once`);
const guest = template.replace("{{STYLE}}", () => guestStyle).replace("{{DOMAIN}}", () => domain).replace("{{SCRIPT}}", () => guestScript);
checkNoSubmit(guest.replace(domain, ""), "the restricted guest");
if (guest.length > 8388608) throw new Error("the guest exceeds the 8 MiB mount budget");
const guestBytes = new TextEncoder().encode(guest);
const artifact = { revision: commit, sha256: sha(guestBytes), "max-bytes": guestBytes.byteLength };

// The sandboxed guest has no storage until the runtime's host-mediated storage (KOTOBA-968).
const descriptor = {
  schema: "kotoba.app.client-runtime.v1", target: "browser", profile: "restricted-wasm-v1", entry: "index.html",
  "local-state": { adapter: "memory", schema: app.storageKey, version: 1 }, workers: [], operations: [],
};
const { clientRuntimeProblems } = await import(resolve(root, "vendor/kotoba-client-runtime.js"));
const problems = clientRuntimeProblems(descriptor, [], []);
if (problems.length) throw new Error(`invalid descriptor: ${JSON.stringify(problems)}`);
await rm(join(out, "domain.js"));
const host = await readFile(resolve(root, "src/ui/host.html"), "utf8");
if (host.split("@CSP@").length !== 2) throw new Error("host.html has no CSP build marker");
await writeFile(join(out, "index.html"), host.replace("@CSP@", () => CSP));
for (const name of ["host.js", "host.css"]) await copyFile(resolve(root, "src/ui", name), join(out, name));
for (const name of Object.keys(pins.files)) await copyFile(resolve(root, "vendor", name), join(out, name));
await writeFile(join(out, "descriptor.json"), JSON.stringify(descriptor, null, 2) + "\n");
await writeFile(join(out, "host-data.js"), `export default ${JSON.stringify({ descriptor, artifact, guest }, null, 1)};\n`);
const names = ["index.html", "host.js", "host.css", ...Object.keys(pins.files), "descriptor.json", "host-data.js"];
const files = {};
for (const name of names) files[name] = sha(await readFile(join(out, name)));
await writeFile(join(out, "release.json"), JSON.stringify({
  schema: "awai.app.artifact.v1", id: app.id, version: meta.version, tauri: "3.0.0-alpha.6", profile: descriptor.profile,
  runtimePins: pins, cljsPins: JSON.parse(await readFile(resolve(root, "vendor/cljs/PINS.json"), "utf8")),
  cljsSources: copied.sort(), guest: artifact, source_commit: commit, dirty, files,
}, null, 2) + "\n");
console.log(`${app.title} static build (${descriptor.profile}): ${names.length} pinned files, ${copied.length} ClojureScript sources, guest ${guestBytes.byteLength} bytes`);
