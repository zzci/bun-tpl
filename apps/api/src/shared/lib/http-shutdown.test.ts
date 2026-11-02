import { expect, test } from "bun:test";
import { drainHttpServer } from "./http-shutdown";

test("allows an in-flight response to complete during shutdown", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      started.resolve();
      await response.promise;
      return new Response("completed");
    },
  });
  try {
    const request = fetch(server.url).then(r => r.text()).catch(() => "disconnected");
    await started.promise;
    const draining = drainHttpServer(server, 1000);
    await Bun.sleep(10);
    response.resolve();
    expect(await request).toBe("completed");
    await draining;
  }
  finally {
    response.resolve();
    await server.stop(true);
  }
});

test("forces a streaming connection closed once the drain deadline expires", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
    })),
  });
  try {
    const response = await fetch(server.url);
    const reading = response.text().then(() => "completed", () => "disconnected");
    await drainHttpServer(server, 20);
    expect(await reading).toBe("disconnected");
  }
  finally {
    await server.stop(true);
  }
});
