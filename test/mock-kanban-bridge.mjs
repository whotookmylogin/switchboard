// Stand-in for tools/kanban_bridge.py in tests: echoes the op, caller and args it received.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  if (req.op === "claim" && req.args.id === "t_taken") {
    process.stdout.write(JSON.stringify({ ok: false, error: "cannot claim t_taken: status=running, claimed_by=switchboard/codex" }));
    return;
  }
  process.stdout.write(JSON.stringify({ ok: true, data: { op: req.op, agent: req.agent, args: req.args } }));
});
