const { spawn } = require("node:child_process");
const { watch } = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");

let serverProcess = null;
let serverExitPromise = null;
let restartTimer = null;
let isRestarting = false;
let pendingRestart = false;
let isShuttingDown = false;
let isCompilerReady = false;
let distWatcher = null;
let ignoreDistChangesUntil = 0;

function runCommand(command, args, options = {}) {
  return spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopServer() {
  if (!serverProcess) return;

  const currentServer = serverProcess;
  const currentExitPromise = serverExitPromise;
  currentServer.kill("SIGTERM");

  const exitResult = await Promise.race([
    currentExitPromise,
    delay(500).then(() => "timeout"),
  ]);

  if (exitResult === "timeout" && serverProcess === currentServer) {
    currentServer.kill("SIGKILL");
    if (currentExitPromise) {
      await currentExitPromise;
    }
  }

  await delay(100);
}

function startServer() {
  serverProcess = runCommand("node", ["dist/index.js"]);
  serverExitPromise = waitForExit(serverProcess);
  serverProcess.once("exit", (code, signal) => {
    serverProcess = null;
    serverExitPromise = null;
    if (!isRestarting && !isShuttingDown && code !== 0) {
      console.error(`[dev] server exited with code ${code}${signal ? ` signal ${signal}` : ""}`);
    }
  });
}

async function restartServer() {
  if (isShuttingDown) return;
  if (isRestarting) {
    pendingRestart = true;
    return;
  }

  isRestarting = true;
  try {
    await stopServer();

    if (!isShuttingDown) {
      startServer();
    }
  } finally {
    isRestarting = false;
    if (pendingRestart && !isShuttingDown) {
      pendingRestart = false;
      void restartServer();
    }
  }
}

function scheduleRestart() {
  if (isShuttingDown) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    void restartServer();
  }, 250);
}

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearTimeout(restartTimer);

  if (distWatcher) {
    distWatcher.close();
  }
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
  }
  if (compilerProcess) {
    compilerProcess.kill("SIGTERM");
  }

  setTimeout(() => {
    process.exit(signal === "SIGINT" ? 130 : 0);
  }, 50);
}

function startWatchingDist() {
  if (distWatcher) return;

  ignoreDistChangesUntil = Date.now() + 1000;

  distWatcher = watch(distDir, { recursive: true }, (_eventType, filename) => {
    if (!filename || !String(filename).endsWith(".js")) {
      return;
    }
    if (Date.now() < ignoreDistChangesUntil) {
      return;
    }

    scheduleRestart();
  });

  distWatcher.on("error", (error) => {
    console.error("[dev] dist watcher failed:", error);
    shutdown("SIGTERM");
  });
}

// Resolve TypeScript to its JS entrypoint and run it with the current node binary.
// On Windows the .bin/tsc shim is a .cmd file, which spawn() cannot exec without a shell.
const tscEntry = require.resolve("typescript/lib/tsc.js");

const compilerProcess = spawn(process.execPath, [tscEntry, "-w", "-p", "tsconfig.json", "--preserveWatchOutput"], {
  cwd: projectRoot,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

compilerProcess.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (!isCompilerReady && text.includes("Watching for file changes.")) {
    isCompilerReady = true;
    startWatchingDist();
    startServer();
  }
});

compilerProcess.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

compilerProcess.once("exit", (code, signal) => {
  if (!isShuttingDown) {
    console.error(`[dev] TypeScript watcher exited with code ${code}${signal ? ` signal ${signal}` : ""}`);
    shutdown("SIGTERM");
  }
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
