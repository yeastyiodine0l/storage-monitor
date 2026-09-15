import {
  controlledJitConfig,
  runnerEnvironment,
  listenerCommand,
  listenerArgs,
} from "./platform.mjs";
import { awaitRunnerExit, reportCompletion } from "./lifecycle.mjs";
/** Runs only on an ephemeral provider VM. Never print its configuration or consumer logs. */
import {
  generateKeyPairSync,
  privateDecrypt,
  createDecipheriv,
  createHash,
  constants,
} from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  createWriteStream,
  existsSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
let cleanupRoot;
async function main() {
  const origin = process.env.FABRIC_ORIGIN,
    lease = process.env.FABRIC_LEASE_ID;
  if (!origin?.startsWith("https://") || !lease)
    throw Error("Missing Fabric bootstrap configuration");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fabric-"))),
    runner = join(root, "runner");
  cleanupRoot = root;
  mkdirSync(runner, { mode: 0o700 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function request(path, body, token) {
    const r = await fetch(origin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw Error("Fabric request status " + r.status);
    return r.json();
  }
  const oidcURL = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  oidcURL.searchParams.set("audience", origin);
  const or = await fetch(oidcURL, {
    headers: {
      Authorization: "Bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!or.ok) throw Error("OIDC request failed");
  const { value: oidc } = await or.json();
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  let sealed;
  for (let n = 0; n < 30; n++) {
    try {
      sealed = await request(`/api/agent/${lease}/claim`, { oidc, publicKey });
      break;
    } catch (e) {
      if (n === 29) throw e;
      await sleep(2000);
    }
  }
  const key = privateDecrypt(
    {
      key: keys.privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(sealed.key, "base64"),
  );
  const [v, iv, tag, data] = sealed.payload.split(".");
  if (v !== "v1") throw Error("Envelope version mismatch");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAAD(Buffer.from("runner-envelope"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  const conf = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(data, "hex")),
      decipher.final(),
    ]).toString(),
  );
  // Release metadata comes from the authenticated control plane, never workflow inputs.
  const lock = conf.runnerAsset;
  if (
    !lock ||
    !/^[a-f0-9]{64}$/.test(lock.sha256) ||
    !/^https:\/\/github\.com\/actions\/runner\/releases\/download\/v\d+\.\d+\.\d+\/actions-runner-[a-z0-9.-]+$/.test(
      lock.url,
    )
  )
    throw Error("Verified current runner release unavailable");
  const tar = join(root, "runner." + lock.archive);
  const download = await fetch(lock.url, {
    signal: AbortSignal.timeout(120000),
  });
  if (!download.ok) throw Error("Runner download failed");
  await pipeline(Readable.fromWeb(download.body), createWriteStream(tar));
  if (createHash("sha256").update(readFileSync(tar)).digest("hex") !== lock.sha256)
    throw Error("Runner checksum mismatch");
  async function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: "ignore", ...opts });
      p.on("error", reject);
      p.on("exit", (code) =>
        code === 0 ? resolve() : reject(Error("Bootstrap command failed: " + cmd)),
      );
    });
  }
  if (lock.archive === "zip") {
    await run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:FABRIC_ARCHIVE -DestinationPath $env:FABRIC_EXTRACT",
      ],
      { env: { ...process.env, FABRIC_ARCHIVE: tar, FABRIC_EXTRACT: runner } },
    );
  } else await run("tar", ["xzf", tar, "-C", runner]);
  const env = runnerEnvironment(process.env, root);
  for (const key of [
    "TMPDIR",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ])
    if (env[key]) mkdirSync(env[key], { recursive: true, mode: 0o700 });
  const streams = new Map(),
    pending = [];
  let gaps = 0,
    bytes = 0;
  const pages = join(runner, "_diag", "pages");
  // Keep descriptors open after GitHub removes uploaded pages. Completed API logs reconcile any creation race.
  function scan() {
    if (!existsSync(pages)) return;
    for (const name of readdirSync(pages)) {
      if (streams.has(name)) continue;
      try {
        streams.set(name, {
          fd: openSync(join(pages, name), "r"),
          position: 0,
          seq: 0,
          rest: "",
        });
      } catch {
        gaps++;
      }
    }
    for (const [name, s] of streams) {
      for (let i = 0; i < 32; i++) {
        const b = Buffer.alloc(65536);
        let n;
        try {
          n = readSync(s.fd, b, 0, b.length, s.position);
        } catch {
          break;
        }
        if (!n) break;
        s.position += n;
        const text = s.rest + b.subarray(0, n).toString("utf8");
        const cut = text.lastIndexOf("\n");
        if (cut < 0) {
          s.rest = text;
          continue;
        }
        s.rest = text.slice(cut + 1);
        const body = text.slice(0, cut + 1);
        pending.push({ stream: name, sequence: s.seq++, body });
        bytes += Buffer.byteLength(body);
        if (bytes > 16 * 1024 * 1024)
          throw Error("Log relay backpressure limit reached");
      }
    }
  }
  let busy = false;
  async function flush() {
    if (busy) return;
    busy = true;
    try {
      scan();
      while (pending.length) {
        const batch = pending.slice(0, 4);
        await request(
          `/api/agent/${lease}/logs`,
          { chunks: batch },
          conf.callbackToken,
        );
        for (const c of batch) bytes -= Buffer.byteLength(c.body);
        pending.splice(0, batch.length);
      }
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => flush().catch(() => {}), 250);
  const heartbeat = setInterval(
    () =>
      request(`/api/agent/${lease}/heartbeat`, {}, conf.callbackToken).catch(() => {}),
    15000,
  );
  const stdout = openSync(join(root, "listener.log"), "w", 0o600);
  const child = spawn(
    listenerCommand(runner),
    listenerArgs(controlledJitConfig(conf.encodedJitConfig)),
    { cwd: runner, env, stdio: ["ignore", stdout, stdout], detached: true },
  );
  function stopRunner() {
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("error", () => child.kill());
    } else process.kill(-child.pid, "SIGTERM");
  }
  // GitHub's ephemeral listener finishes after its one assigned job, including post steps.
  // Consumer cancellation/timeouts remain native; Fabric never interrupts active work by age.
  const result = await awaitRunnerExit(child, { stop: stopRunner });
  clearInterval(timer);
  clearInterval(heartbeat);
  while (busy) await sleep(100);
  for (let n = 0; n < 10; n++) {
    try {
      await flush();
      if (!pending.length) break;
    } catch {}
    await sleep(1000);
  }
  for (const s of streams.values()) closeSync(s.fd);
  closeSync(stdout);
  if (pending.length) gaps += pending.length;
  const reported = await reportCompletion(
    (body) => request(`/api/agent/${lease}/finished`, body, conf.callbackToken),
    { ...result, logGaps: gaps },
  );
  if (!reported)
    console.warn(
      "Completion reporting deferred. The control plane will reconcile status.",
    );
  // Diagnostic content intentionally stays on this disposable VM; never upload it to the public provider repo.
  console.log("Fabric runner finished. Consumer logs are available in Actions Fabric.");
  process.exitCode = result.exitCode;
}
try {
  await main();
} catch {
  // Never serialize fetch errors, environment values, JIT credentials or listener diagnostics.
  console.error("Provider execution failed. Check the control plane for status.");
  process.exitCode = 1;
} finally {
  if (cleanupRoot) {
    try {
      rmSync(cleanupRoot, { recursive: true, force: true });
    } catch {}
  }
}
