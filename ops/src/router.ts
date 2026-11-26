export type Handler = (request: Request) => Response | Promise<Response>;

export interface Route {
  method: string;
  path: string;
  handler: Handler;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function notFound(): Response {
  return json({ error: { code: "not_found", message: "No such route." } }, 404);
}

/** Method + exact path -> handler. Anything unmatched is a 404. */
export function createRouter(routes: Route[]): Handler {
  return (request) => {
    const { pathname } = new URL(request.url);
    const match = routes.find((r) => r.method === request.method && r.path === pathname);
    return match ? match.handler(request) : notFound();
  };
}
