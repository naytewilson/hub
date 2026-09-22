import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const POSTGRES_USER = "postgres";
const POSTGRES_PASSWORD = "postgres";
const POSTGRES_DATABASE = "postgres";
const POSTGRES_PORT = 5432;
const START_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const TEST_LABEL = "io.paseo.hub.test-postgres=true";

interface CommandResult {
  stdout: string;
  stderr: string;
}

async function runPodman(args: string[], allowFailure = false): Promise<CommandResult> {
  try {
    const result = await execFileAsync("podman", args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (allowFailure) return { stdout: "", stderr: "" };
    throw error;
  }
}

function parseMappedPort(output: string): number {
  const line = output
    .trim()
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);

  if (!line) throw new Error("Podman did not report the PostgreSQL mapped port.");

  const match = line.match(/:(\d+)$/);
  if (!match?.[1]) throw new Error(`Unexpected Podman port mapping: ${line}`);

  const port = Number.parseInt(match[1], 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid Podman PostgreSQL port: ${match[1]}`);
  }
  return port;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PostgreSqlContainer {
  constructor(private readonly image: string) {}

  async start(): Promise<StartedPostgreSqlContainer> {
    const name = `paseo-hub-postgres-${process.pid}-${randomUUID().slice(0, 12)}`;

    await runPodman([
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--label",
      TEST_LABEL,
      "--env",
      `POSTGRES_USER=${POSTGRES_USER}`,
      "--env",
      `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
      "--env",
      `POSTGRES_DB=${POSTGRES_DATABASE}`,
      "--publish",
      `127.0.0.1::${POSTGRES_PORT}`,
      this.image.includes("/") ? this.image : `docker.io/library/${this.image}`,
    ]);

    try {
      const mapping = await runPodman(["port", name, `${POSTGRES_PORT}/tcp`]);
      const started = new StartedPostgreSqlContainer(name, parseMappedPort(mapping.stdout));
      await started.waitUntilReady();
      return started;
    } catch (error) {
      await runPodman(["stop", "--time", "1", name], true);
      throw error;
    }
  }
}

export class StartedPostgreSqlContainer {
  private stopped = false;

  constructor(
    private readonly name: string,
    private readonly port: number,
  ) {}

  getConnectionUri(): string {
    const url = new URL("postgres://");
    url.hostname = "127.0.0.1";
    url.port = String(this.port);
    url.pathname = POSTGRES_DATABASE;
    url.username = POSTGRES_USER;
    url.password = POSTGRES_PASSWORD;
    return url.toString();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await runPodman(["stop", "--time", "5", this.name], true);
  }

  async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastError = "";

    while (Date.now() < deadline) {
      try {
        await runPodman([
          "exec",
          this.name,
          "psql",
          "--no-psqlrc",
          "--username",
          POSTGRES_USER,
          "--dbname",
          POSTGRES_DATABASE,
          "--command",
          "SELECT 1;",
        ]);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await sleep(POLL_INTERVAL_MS);
      }
    }

    const logs = await runPodman(["logs", this.name], true);
    throw new Error(
      `PostgreSQL did not become ready in Podman within ${START_TIMEOUT_MS}ms. ` +
        `Last probe: ${lastError}\n${logs.stdout}\n${logs.stderr}`,
    );
  }
}
