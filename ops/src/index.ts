import { createRouter, json } from "./router";

const router = createRouter([
  {
    method: "GET",
    path: "/health",
    handler: () => json({ ok: true, service: "storeops-ops" }),
  },
]);

export default {
  fetch(request: Request): Response | Promise<Response> {
    return router(request);
  },
};
