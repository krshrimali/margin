// An isolated production server for browser and HTTP checks.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";

export async function startServer(env = {}) {
  const socket = http.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const dir = await mkdtemp(path.join(tmpdir(), "margin-test-"));
  const child = spawn(process.execPath, ["server/index.js"], {
    env: { ...process.env, WHITEBOARD_DATA: dir, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Server exited during startup"); })]);
  return {
    url: "http://127.0.0.1:" + port,
    async close() {
      const closed = once(child, "exit");
      child.kill();
      await closed;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
