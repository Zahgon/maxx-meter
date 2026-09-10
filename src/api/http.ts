import type { AddressInfo } from "node:net";
import express from "express";
import type { Express } from "express";
import inject from "light-my-request";
import type { InjectOptions, Response as LightResponse } from "light-my-request";

/**
 * The in-process test/introspection helpers the codebase and the test suite rely on.
 * `inject` is backed by light-my-request — the same engine Fastify's own `inject` uses
 * — so response objects expose `statusCode`, `json()`, `body`, and `headers` exactly as
 * before. `listen`/`close` wrap Express's HTTP server with promise-based control.
 *
 * The `listen` helper is named distinctly from Express's own overloaded `listen` to
 * avoid a declaration clash; callers only ever use this object shape.
 */
export interface HttpAppHelpers {
  ready(): Promise<HttpApp>;
  inject(opts: InjectOptions | string): Promise<LightResponse>;
  close(): Promise<void>;
  listen(opts: { port: number; host?: string }): Promise<AddressInfo | string | null>;
}

/**
 * An Express application augmented with the helpers above. `listen` is replaced with the
 * promise-returning variant (Express's native `listen` is still used internally).
 */
export type HttpApp = Omit<Express, "listen"> & HttpAppHelpers;

/**
 * Create an Express app pre-wired with JSON body parsing and the `inject`/`ready`/
 * `close`/`listen` helpers. Callers register routes/middleware on the returned value
 * just like a plain Express app.
 */
export function createApp(): HttpApp {
  const base = express();
  base.use(express.json());

  // Object.assign below overwrites `base.listen` with the helper; capture the
  // native one first or the helper recurses into itself instead of serving.
  const nativeListen = base.listen.bind(base);

  let server: ReturnType<Express["listen"]> | undefined;

  const helpers: HttpAppHelpers = {
    ready: async () => app,
    inject: (opts) => inject(base, opts),
    listen: ({ port, host }) =>
      new Promise((resolve, reject) => {
        const created = nativeListen(port, host ?? "0.0.0.0", () => {
          resolve(created.address());
        });
        server = created;
        created.on("error", reject);
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };

  const app = Object.assign(base, helpers) as unknown as HttpApp;
  return app;
}
