// `noop doctor` beyond dependencies: can this machine reach the Worker, is the daemon installed and alive, is the primary
// there, is the knowledge base usable. And `noop primary`, for when the primary is gone: nothing takes over on its own.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { type Cfg, P, _commitPush, _pull, hostName, journal, list, loadConfig, locked, onlineHosts, readDoc } from "./core";
import { SERVICE, startupFile } from "./setup";
import { kbConfig, kbStatus } from "./kb";
import { readHubToml } from "./sync";

const say = (ok: boolean | "warn", label: string, detail = "") => console.log(`${ok === "warn" ? "!" : ok ? "✔" : "✘"} ${label.padEnd(18)} ${detail}`);

/** Whether something will start the daemon at logon. Only Windows has more than one way, or a way to quietly lack one. */
export function serviceInstalled(): boolean {
  if (process.platform !== "win32") return true;
  if (Bun.spawnSync(["schtasks", "/Query", "/TN", SERVICE], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) return true;
  const file = startupFile();
  return !!file && existsSync(file);
}

const reachable = (url: string) => fetch(url, { signal: AbortSignal.timeout(8000) }).then(() => true, () => false);
/** The same request with every proxy setting ignored, which is what an app without proxy support does. */
function reachableDirect(url: string): boolean | null {
  if (!Bun.which("curl")) return null;
  const r = Bun.spawnSync(["curl", "--noproxy", "*", "-m", "6", "-s", "-o", process.platform === "win32" ? "NUL" : "/dev/null", url], { stdout: "ignore", stderr: "ignore" });
  return r.exitCode === 0;
}

export async function diagnose(cfg: Cfg) {
  console.log("");
  const url = String(readHubToml().cloud?.url ?? "").replace(/\/$/, "");
  const joined = !!url && !!readHubToml().server?.token;
  say(joined, "joined", joined ? url : "not joined: noop init <your-noop-url>");
  if (url) {
    const viaEnv = await reachable(url), direct = reachableDirect(url);
    say(viaEnv, "worker", viaEnv ? "reachable" : "unreachable from this machine; check the network or proxy");
    if (viaEnv && direct === false) {
      const addr = await lookup(new URL(url).hostname).then((a) => a.address, () => "no answer");
      say("warn", "direct connection", `blocked (DNS says ${addr}). The daemon uses HTTP_PROXY, but the desktop app's live connection does not: it will show "reconnecting". Turn on your proxy's TUN mode.`);
    }
  }
  const me = hostName(cfg), installed = serviceInstalled(), online = onlineHosts(cfg), here = online.some((h) => h.host === me);
  say(installed, "service", installed ? "installed" : "not installed: noop install");
  say(here, "this machine", here ? "sending heartbeats" : "no recent heartbeat: the daemon is not running, or has not synced yet");
  const primary = cfg.fleet?.primary;
  if (primary) {
    const up = online.some((h) => h.host === primary);
    say(up ? true : "warn", "primary", up ? String(primary) : `${primary} is offline, and the app's machine list and chat stay frozen until it returns. To replace it: noop primary ${me}`);
  }
  const kb = kbConfig(cfg);
  if (cfg.kb?.siyuan_dir && !kb) say(false, "knowledge base", `folder not found: ${cfg.kb.siyuan_dir}`);
  if (kb) { const s = kbStatus(); say(s.docs > 0 ? true : "warn", "knowledge base", s.docs ? `${s.docs} notes, indexed ${s.indexedAt}` : "empty: noop kb index"); }
}

/** The shared config with `next` as primary; comments and everything else stay as they are. Null when it names none. */
export function withPrimary(toml: string, next: string): string | null {
  const m = /^(\s*primary\s*=\s*)"([^"]*)"/m.exec(toml);
  if (!m) return null;
  const old = m[2];
  return toml.replace(m[0], `${m[1]}"${next}"`).split(`"http://${old}:`).join(`"http://${next}:`);
}

export async function switchPrimary(cfg: Cfg, target: string, force = false) {
  if (!force && !onlineHosts(cfg).some((h) => h.host === target)) {
    console.error(`${target} is not online. Online: ${onlineHosts(cfg).map((h) => h.host).join(", ") || "none"}. To name it anyway: noop primary ${target} --force`);
    process.exitCode = 1;
    return;
  }
  const done = await locked(async () => {
    await _pull();
    const file = P("config.toml"), current = loadConfig().fleet?.primary;
    if (current === target) { console.log(`${target} is already the primary`); return true; }
    const next = withPrimary(readFileSync(file, "utf8"), target);
    if (!next) { console.error("config.toml has no [fleet] primary"); return false; }
    writeFileSync(file, next);
    journal(hostName(cfg), `👑 primary changed: ${current} → ${target}`);
    const active = list(P("tasks", "active"), /^T-.*\.md$/).map((p) => readDoc(p).meta).filter((m) => m.claimed_by === current);
    if (active.length) console.log(`${active.length} task(s) still marked as running on ${current} will be requeued after it has been offline for a while`);
    return _commitPush(`[${hostName(cfg)}] primary: ${target}`, { force: true });
  });
  if (!done) { process.exitCode = 1; return; }
  console.log(`✔ primary is now ${target}. Each running daemon switches roles within a minute of syncing, including ${cfg.fleet?.primary} if it comes back.`);
}
