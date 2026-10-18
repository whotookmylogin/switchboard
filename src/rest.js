/**
 * Plain REST facade over the same connectors, for agents without an MCP client.
 *
 *   GET  /api/tools                          tools this key may use (connector, name, description, input_schema)
 *   POST /api/call/<connector>/<tool>        body = tool arguments (JSON object); returns the tool result
 *   GET  /api/openapi.json                   OpenAPI 3.1 spec of the caller's granted tools
 *
 * Auth, grants, audit and result trimming are identical to the MCP endpoint.
 */

/**
 * @typedef {object} RestContext
 * @property {Map<string, import("./backend.js").Backend>} backends
 * @property {import("./registry.js").Registry} registry
 * @property {(agent: string, backend: object, tool: string, args: object, signal: AbortSignal, extra?: object) => Promise<object>} callTool
 * @property {(req: import("node:http").IncomingMessage) => Promise<any>} readJson
 * @property {(kind: string, rec: object) => void} log
 * @property {(res: import("node:http").ServerResponse, status: number, obj: object) => void} sendJson
 */

/**
 * List the granted tools on every connector the agent can reach.
 * @param {RestContext} ctx
 * @param {string} agent
 */
export async function grantedTools(ctx, agent) {
  const out = [];
  const names = [...ctx.backends.keys()].filter((n) => ctx.registry.toolGrants(agent, n));
  const lists = await Promise.allSettled(names.map((n) => ctx.backends.get(n).request({ method: "tools/list" })));
  lists.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    for (const t of r.value.tools || []) {
      if (!ctx.registry.canCallTool(agent, names[i], t.name)) continue;
      out.push({ connector: names[i], name: t.name, description: t.description || "", input_schema: t.inputSchema || { type: "object" } });
    }
  });
  return out;
}

/** Collapse an MCP tool result into a REST-friendly shape. */
function restResult(result) {
  const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return {
    ok: !result.isError,
    text,
    content: result.content || [],
    ...(result.structuredContent ? { structured: result.structuredContent } : {}),
  };
}

/** Build an OpenAPI 3.1 document describing one POST path per granted tool. */
function openapi(tools, baseUrl) {
  const paths = {};
  for (const t of tools) {
    paths[`/api/call/${t.connector}/${t.name}`] = {
      post: {
        operationId: `${t.connector}__${t.name}`.replace(/[^A-Za-z0-9_]/g, "_"),
        summary: `${t.connector}: ${t.name}`,
        description: t.description.slice(0, 1000),
        requestBody: { required: true, content: { "application/json": { schema: t.input_schema } } },
        responses: { 200: { description: "Tool result", content: { "application/json": { schema: { $ref: "#/components/schemas/ToolResult" } } } } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Switchboard", version: "1", description: "Tools this API key is granted. Send the tool arguments as the JSON body." },
    servers: [{ url: baseUrl }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        ToolResult: {
          type: "object",
          properties: { ok: { type: "boolean" }, text: { type: "string", description: "All text content joined" }, content: { type: "array", items: { type: "object" } }, structured: { type: "object" } },
        },
      },
    },
  };
}

/**
 * Handle a /api/* request for an already-authenticated agent.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url
 * @param {string} agent
 * @param {RestContext} ctx
 */
export async function handleRest(req, res, url, agent, ctx) {
  if (req.method === "GET" && (url.pathname === "/api/tools" || url.pathname === "/api/openapi.json")) {
    ctx.log("audit", { agent, server: "-", method: `GET ${url.pathname}`, ok: true, via: "rest", ip: req.headers["cf-connecting-ip"] });
  }
  if (req.method === "GET" && url.pathname === "/api/tools") {
    return ctx.sendJson(res, 200, { agent, tools: await grantedTools(ctx, agent) });
  }
  if (req.method === "GET" && url.pathname === "/api/openapi.json") {
    const proto = req.headers["x-forwarded-proto"] || (req.headers["cf-connecting-ip"] ? "https" : "http");
    return ctx.sendJson(res, 200, openapi(await grantedTools(ctx, agent), `${proto}://${req.headers.host}`));
  }
  const m = url.pathname.match(/^\/api\/call\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.:-]+)\/?$/);
  if (!m) return ctx.sendJson(res, 404, { error: "not found" });
  if (req.method !== "POST") return ctx.sendJson(res, 405, { error: "use POST" });
  const [, connector, tool] = m;
  const backend = ctx.backends.get(connector);
  if (!backend) return ctx.sendJson(res, 404, { error: `unknown connector ${connector}` });
  if (!ctx.registry.canCallTool(agent, connector, tool)) {
    ctx.callTool(agent, backend, tool, null, null, { ip: req.headers["cf-connecting-ip"] }).catch(() => {}); // records the denial in the audit log
    return ctx.sendJson(res, 403, { error: `this key is not granted ${connector}/${tool}` });
  }
  let args;
  try {
    args = (await ctx.readJson(req)) ?? {};
  } catch {
    return ctx.sendJson(res, 400, { error: "body must be a JSON object of tool arguments" });
  }
  if (typeof args !== "object" || Array.isArray(args)) return ctx.sendJson(res, 400, { error: "body must be a JSON object of tool arguments" });
  const ac = new AbortController();
  res.on("close", () => !res.writableFinished && ac.abort());
  try {
    const result = await ctx.callTool(agent, backend, tool, args, ac.signal, { ip: req.headers["cf-connecting-ip"] });
    return ctx.sendJson(res, 200, restResult(result));
  } catch (e) {
    return ctx.sendJson(res, 502, { ok: false, error: String(e?.message || e).slice(0, 500) });
  }
}
