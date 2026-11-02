import type { Server } from "bun";

/** Stop accepting requests, drain active connections, then enforce the deadline. */
export async function drainHttpServer(server: Pick<Server<unknown>, "stop">, timeoutMs = 25_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      server.stop(false),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  }
  finally {
    clearTimeout(timer);
  }
  await server.stop(true);
}
