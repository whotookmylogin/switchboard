// Fake stdio MCP connector for Switchboard tests: echo, slow (with progress), fail, crash, env, pid.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const s = new Server({ name: "mock", version: "9.9.9" }, { capabilities: { tools: {} }, instructions: "mock instructions" });
const tools = ["echo", "slow", "fail", "crash", "env", "pid", "big"].map((name) => ({ name, description: `mock ${name}`, inputSchema: { type: "object", properties: { text: { type: "string" }, ms: { type: "number" } } } }));
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
s.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const a = req.params.arguments || {};
  const t = (text) => ({ content: [{ type: "text", text: String(text) }] });
  switch (req.params.name) {
    case "echo": return t(a.text);
    case "slow": {
      const steps = 5;
      for (let i = 1; i <= steps; i++) {
        await new Promise((r, j) => { const h = setTimeout(r, (a.ms || 500) / steps); extra.signal.addEventListener("abort", () => { clearTimeout(h); j(new Error("aborted")); }); });
        const tok = req.params._meta?.progressToken;
        if (tok !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: tok, progress: i, total: steps } });
      }
      return t(`slow done ${a.text ?? ""}`);
    }
    case "fail": return { content: [{ type: "text", text: "boom" }], isError: true };
    case "crash": process.stderr.write("crashing on purpose\n"); setTimeout(() => process.exit(3), 10); return t("bye");
    case "env": return t(JSON.stringify({ cwd: process.cwd(), keys: Object.keys(process.env).sort(), MOCK_SECRET: process.env.MOCK_SECRET }));
    case "pid": return t(process.pid);
    case "big": return t("x".repeat((a.ms || 12) * 1024 * 1024));
  }
  throw new Error("unknown tool");
});
process.stderr.write("mock started\n");
await s.connect(new StdioServerTransport());
