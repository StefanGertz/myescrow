import "dotenv/config";

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(projectRoot, "docker-compose.test.yml");
const composeProject = `myescrow-api-test-${process.pid}`;
const forwardedArgs = process.argv.slice(2);

let composeStarted = false;
let composeEnvironment = process.env;
let activeChild = null;
let receivedSignal = null;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    receivedSignal = signal;
    activeChild?.kill(signal);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    activeChild = child;

    let stdout = "";
    let stderr = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    if (options.input && child.stdin) {
      child.stdin.end(options.input);
    }

    child.on("error", (error) => {
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (activeChild === child) activeChild = null;
      resolve({
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function databaseIsReachable(databaseUrl) {
  const result = await run(
    "npx",
    ["prisma", "db", "execute", "--url", databaseUrl, "--stdin"],
    {
      input: "SELECT 1;",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return result.code === 0;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a local port for the test database."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startDisposableDatabase() {
  const port = await reservePort();
  composeEnvironment = {
    ...process.env,
    TEST_POSTGRES_PORT: String(port),
  };

  console.log(`Starting disposable PostgreSQL on 127.0.0.1:${port}...`);
  // Mark the Compose project for cleanup before startup in case health checks
  // fail after the container has already been created.
  composeStarted = true;
  const result = await run(
    "docker",
    [
      "compose",
      "--file",
      composeFile,
      "--project-name",
      composeProject,
      "up",
      "--detach",
      "--wait",
    ],
    { env: composeEnvironment },
  );
  if (result.code !== 0) {
    throw new Error(
      "Could not start the disposable test database. Start Docker, or set TEST_DATABASE_URL to a reachable PostgreSQL database.",
    );
  }

  return `postgresql://myescrow_test:myescrow_test@127.0.0.1:${port}/myescrow_test`;
}

async function stopDisposableDatabase() {
  if (!composeStarted) return;

  console.log("Stopping disposable PostgreSQL...");
  const result = await run(
    "docker",
    [
      "compose",
      "--file",
      composeFile,
      "--project-name",
      composeProject,
      "down",
      "--volumes",
      "--remove-orphans",
    ],
    { env: composeEnvironment },
  );
  if (result.code !== 0) {
    console.warn(`Test database cleanup exited with status ${result.code}.`);
  }
}

async function resolveDatabaseUrl() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
  if (testDatabaseUrl) {
    if (!(await databaseIsReachable(testDatabaseUrl))) {
      throw new Error("TEST_DATABASE_URL is set, but PostgreSQL is not reachable.");
    }
    console.log("Using PostgreSQL from TEST_DATABASE_URL.");
    return testDatabaseUrl;
  }

  const configuredDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (configuredDatabaseUrl && (await databaseIsReachable(configuredDatabaseUrl))) {
    console.log("Using PostgreSQL from DATABASE_URL.");
    return configuredDatabaseUrl;
  }

  if (process.env.CI === "true" && configuredDatabaseUrl) {
    throw new Error("DATABASE_URL is set in CI, but PostgreSQL is not reachable.");
  }

  if (configuredDatabaseUrl) {
    console.warn("DATABASE_URL is not reachable; using a disposable test database instead.");
  }
  return startDisposableDatabase();
}

let exitCode = 1;
try {
  const databaseUrl = await resolveDatabaseUrl();
  const result = await run(
    "npx",
    ["vitest", "run", ...forwardedArgs],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    },
  );
  exitCode = result.code;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  await stopDisposableDatabase();
}

process.exitCode = receivedSignal === "SIGINT"
  ? 130
  : receivedSignal === "SIGTERM"
    ? 143
    : exitCode;
