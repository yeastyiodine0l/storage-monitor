import { join, win32, posix } from "node:path";

export function runnerAsset(lock, platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const asset = lock.platforms?.[key];
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256))
    throw Error(`Unsupported or unpinned runner platform: ${key}`);
  return asset;
}
/** Copy only host prerequisites. Never inherit outer Actions/OIDC/runtime credentials. */
export function runnerEnvironment(source, root, platform = process.platform) {
  const env = {},
    paths = platform === "win32" ? win32 : posix;
  const allowed = new Set([
    "path",
    "systemroot",
    "windir",
    "comspec",
    "pathext",
    "programfiles",
    "programfiles(x86)",
    "programw6432",
    "programdata",
    "java_home",
    "android_home",
    "android_sdk_root",
  ]);
  for (const [key, value] of Object.entries(source))
    if (allowed.has(key.toLowerCase()) && value !== undefined) env[key] = value;
  Object.assign(env, {
    HOME: root,
    TMPDIR: paths.join(root, "tmp"),
    TEMP: paths.join(root, "tmp"),
    TMP: paths.join(root, "tmp"),
    XDG_CACHE_HOME: paths.join(root, "cache"),
    XDG_CONFIG_HOME: paths.join(root, "config"),
    XDG_DATA_HOME: paths.join(root, "data"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: paths.join(root, "config", "gitconfig"),
    USER: source.USER ?? source.USERNAME ?? "runner",
    LANG: "en_US.UTF-8",
    RUNNER_ALLOW_RUNASROOT: "1",
  });
  if (platform === "win32")
    Object.assign(env, {
      USERPROFILE: root,
      TEMP: paths.join(root, "tmp"),
      TMP: paths.join(root, "tmp"),
      APPDATA: paths.join(root, "AppData", "Roaming"),
      LOCALAPPDATA: paths.join(root, "AppData", "Local"),
    });
  for (const key of Object.keys(env).filter((k) => k.toLowerCase() === "path")) {
    const inheritedRoots = [
      source.GITHUB_WORKSPACE,
      source.RUNNER_WORKSPACE,
      source.RUNNER_TEMP,
    ]
      .filter(Boolean)
      .map((p) => paths.resolve(p).toLowerCase());
    env[key] = String(env[key])
      .split(paths.delimiter)
      .filter(
        (p) =>
          p &&
          !inheritedRoots.some((root) => {
            const value = paths.resolve(p).toLowerCase();
            return value === root || value.startsWith(root + paths.sep);
          }),
      )
      .join(paths.delimiter);
  }
  return env;
}
export function listenerCommand(runner, platform = process.platform) {
  return platform === "win32"
    ? join(runner, "bin", "Runner.Listener.exe")
    : join(runner, "run.sh");
}
export function listenerArgs(config, platform = process.platform) {
  return [...(platform === "win32" ? ["run"] : []), "--jitconfig", config];
}

/** JIT settings are read directly by Runner.Listener; command flags do not override them. */
export function controlledJitConfig(encoded) {
  const config = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (typeof config[".runner"] !== "string") throw Error("Runner settings missing");
  const settings = JSON.parse(
    Buffer.from(config[".runner"], "base64").toString("utf8"),
  );
  settings.disableUpdate = true;
  settings.ephemeral = true;
  config[".runner"] = Buffer.from(JSON.stringify(settings)).toString("base64");
  return Buffer.from(JSON.stringify(config)).toString("base64");
}
