#!/usr/bin/env python3
"""Lane runner: claims ready Switchboard tasks for agent lanes and runs a local command on each.

Talks only to the Switchboard REST API, so it works with either tasks backend:
    POST $SWITCHBOARD_URL/api/call/tasks/<tool>    Authorization: Bearer $SWITCHBOARD_TOKEN
The response JSON is {"ok": bool, "text": str, "structured": {...}} — see src/rest.js.

Each invocation is one tick (run it from cron or a timer, e.g. every 2 min). A non-blocking
flock on <state_dir>/lane_runner.lock makes overlapping ticks exit quietly.

1. Reconcile: for every task this runner holds, heartbeat its claim while the worker subprocess
   is alive; kill it past max_runtime_minutes. When the worker exits, record the outcome on the
   task: exit code 0 -> complete with the last 3000 chars of its output as the result; non-zero
   or timeout -> block with the reason, so it lands in the waiting pile instead of being retried
   in a loop. A transport failure (Switchboard unreachable, HTTP 5xx, timeout) never counts as
   "claim lost" or a lost result: the state entry is kept and delivery retried next tick. Only
   an explicit refusal (ok:false, HTTP 403) drops the entry.
2. Launch: per enabled lane, if under its concurrency and daily caps, take the highest-priority
   ready task assigned to that lane, claim it, and start the lane's command as a detached
   subprocess. The task text goes into a prompt file which is fed to the command's stdin;
   {prompt_file} and {task_id} placeholders in the command's args are also substituted.
   Example commands: ["claude", "-p", "--permission-mode", "acceptEdits", "--output-format", "json"]
   and ["codex", "exec", "-"] (both read the prompt on stdin).

Tasks are skipped (with one comment) when their board is in skip_boards, their id is in
skip_cards, their created_by is not in trusted_creators, an event shows an agent outside
trusted_creators edited the title or body, or title/body contains a manual_markers string.
The worker runs the task text with the operator's privileges, so trusted_creators gates who
may inject work. created_by is set server-side from the caller's token, task edits are
recorded in the task's event history (returned by `show`), and only comments authored by
trusted agents are fed into the prompt.

Config: JSON file via --config, deep-merged over DEFAULTS (see examples/lane_runner.example.json).
        "switchboard_url" and "token" fall back to $SWITCHBOARD_URL / $SWITCHBOARD_TOKEN.
State:  ~/.local/state/switchboard/lane_runner_state.json ("state_path" to change)
Runs:   ~/.local/state/switchboard/lane-runs/<task_id>.{prompt.txt,log,exit}
Log:    ~/.local/state/switchboard/lane-runner.log ("log_path")

Usage: lane_runner.py [--config cfg.json] [--dry-run]   (dry run: report only, change nothing)

Stdlib only; Python 3.10+.
"""
import copy
import datetime as dt
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "switchboard"
DRY_RUN = "--dry-run" in sys.argv
HISTORY_LIMIT = 200

DEFAULTS = {
    "enabled": True,
    "switchboard_url": "",  # falls back to $SWITCHBOARD_URL
    "token": "",  # falls back to $SWITCHBOARD_TOKEN
    "lanes": {
        "claude": {
            "enabled": True,
            "command": ["claude", "-p", "--permission-mode", "acceptEdits", "--output-format", "json"],
            "daily_cap": 8,
            "concurrency": 1,
        },
        "codex": {"enabled": True, "command": ["codex", "exec", "-"], "daily_cap": 8, "concurrency": 1},
    },
    "skip_boards": [],
    "skip_cards": [],  # task ids to leave for interactive sessions
    # Only run tasks created by these agents (created_by is the caller's token identity, set
    # server-side, so it cannot be forged in the task). Tasks whose title or body an untrusted
    # agent edited are skipped too, and only comments by trusted authors reach the prompt.
    # Anyone else's tasks are skipped with one comment. null disables the whole trust gate.
    "trusted_creators": ["human", "claude", "codex"],
    "manual_markers": ["[manual]", "no-auto", "[interactive]"],
    "max_runtime_minutes": 120,
    "claim_ttl_minutes": 30,
    "state_path": str(STATE_DIR / "lane_runner_state.json"),
    "log_path": str(STATE_DIR / "lane-runner.log"),
    "runs_dir": str(STATE_DIR / "lane-runs"),
}

# Detached child supervisor: feeds the prompt file to the command's stdin, captures combined
# output to the log file, and records the exit code in the exit file so the next tick (a
# different process) can see how the run ended.
_CHILD = """\
import os, subprocess, sys
prompt_file, log_file, exit_file = sys.argv[1:4]
cmd = sys.argv[4:]
with open(prompt_file, "rb") as pin, open(log_file, "wb") as log:
    rc = subprocess.call(cmd, stdin=pin, stdout=log, stderr=subprocess.STDOUT)
with open(exit_file + ".tmp", "w") as f:
    f.write(str(rc))
os.replace(exit_file + ".tmp", exit_file)
"""


class RunnerError(Exception):
    """An explicit refusal from Switchboard (ok:false, HTTP 403): the claim is gone, stop the work."""


class TransportError(RunnerError):
    """Switchboard could not be reached (URLError, timeout, HTTP 5xx, unreadable reply): retry next tick."""


def log(cfg, msg):
    """Append one timestamped line to the runner log (stdout on dry runs)."""
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    if DRY_RUN:
        print(line)
        return
    path = Path(cfg["log_path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(line + "\n")


def load_config():
    """DEFAULTS deep-merged with the JSON config file from --config (if given and present)."""
    cfg = copy.deepcopy(DEFAULTS)
    path = None
    if "--config" in sys.argv:
        i = sys.argv.index("--config")
        path = Path(sys.argv[i + 1]) if i + 1 < len(sys.argv) else None
        if path is None or not path.exists():
            raise RunnerError(f"config file not found: {path}")
    if path:
        override = json.loads(path.read_text())
        for key, value in override.items():
            if key == "lanes" and isinstance(value, dict):
                for lane, lane_cfg in value.items():
                    cfg["lanes"].setdefault(lane, {}).update(lane_cfg or {})
            else:
                cfg[key] = value
    cfg["switchboard_url"] = (cfg.get("switchboard_url") or os.environ.get("SWITCHBOARD_URL") or "http://127.0.0.1:3930").rstrip("/")
    cfg["token"] = cfg.get("token") or os.environ.get("SWITCHBOARD_TOKEN") or ""
    for key in ("state_path", "log_path", "runs_dir"):
        cfg[key] = os.path.expanduser(cfg[key])
    if not cfg["token"]:
        raise RunnerError("no Switchboard token: set SWITCHBOARD_TOKEN or \"token\" in the config")
    return cfg


def call(cfg, tool, **args):
    """Call one tasks tool over the REST API; returns the structured data.

    RunnerError  — the call was made and explicitly refused (ok:false, HTTP 403).
    TransportError — no reliable answer arrived (URLError, timeout, HTTP 5xx, bad reply);
                     callers keep their state entry and retry next tick.
    """
    req = urllib.request.Request(
        f"{cfg['switchboard_url']}/api/call/tasks/{tool}",
        data=json.dumps(args).encode(),
        headers={"authorization": f"Bearer {cfg['token']}", "content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read() or b"{}"
    except urllib.error.HTTPError as e:
        detail = e.read()[:300]
        if e.code == 403:
            raise RunnerError(f"{tool}: HTTP 403 {detail!r}")
        raise TransportError(f"{tool}: HTTP {e.code} {detail!r}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise TransportError(f"{tool}: {getattr(e, 'reason', e)}")
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        raise TransportError(f"{tool}: non-JSON response {raw[:200]!r}")
    if not body.get("ok"):
        text = (body.get("text") or body.get("error") or "call failed").strip()
        raise RunnerError(text[:500])
    if body.get("structured") is not None:
        return body["structured"]
    try:
        return json.loads(body.get("text") or "{}")
    except json.JSONDecodeError:
        return {"text": body.get("text")}


def load_state(cfg):
    """Runner state: tasks it holds, tasks it decided to skip, per-day launch counts, history."""
    try:
        state = json.loads(Path(cfg["state_path"]).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        state = {}
    for key in ("cards", "skipped", "runs"):
        state.setdefault(key, {})
    state.setdefault("history", [])
    return state


def save_state(cfg, state):
    """Atomically write state; keep only the last 14 days of counts and HISTORY_LIMIT history rows."""
    if DRY_RUN:
        return
    cutoff = (dt.date.today() - dt.timedelta(days=14)).isoformat()
    state["runs"] = {d: v for d, v in state["runs"].items() if d >= cutoff}
    state["history"] = state["history"][-HISTORY_LIMIT:]
    path = Path(cfg["state_path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(path)


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def proc_start(pid):
    """A start-time token for pid, so a recycled pid after a reboot isn't mistaken for our worker.

    Linux: field 22 of /proc/<pid>/stat (jiffies since boot; comm may contain spaces/parens, so
    split after the last ')'). Elsewhere: `ps -o lstart=` output. None if it can't be read.
    """
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat.rpartition(")")[2].split()[19]
    except (OSError, IndexError):
        pass
    try:
        out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def worker_alive(entry):
    """True when entry's pid runs AND is the process this runner launched (same start token)."""
    if not pid_alive(entry["pid"]):
        return False
    started = entry.get("pid_start")
    if started is None:
        return True  # state entries from before pid_start was recorded: bare-pid check only
    # Only an exact token match counts as our worker: a mismatch (or an unreadable token while
    # the pid exists) means the pid was recycled, so we must neither heartbeat nor kill it.
    return proc_start(entry["pid"]) == started


def kill_tree(pid):
    """Kill the detached worker and its process group (it was started as a session leader)."""
    for fn in (lambda: os.killpg(pid, signal.SIGKILL), lambda: os.kill(pid, signal.SIGKILL)):
        try:
            fn()
            return
        except (ProcessLookupError, PermissionError):
            continue


def exit_code(entry):
    """The worker's exit code from its .exit file, or None if it hasn't finished writing."""
    try:
        return int(Path(entry["exit_file"]).read_text().strip())
    except (FileNotFoundError, ValueError):
        return None


def log_tail(entry, chars=3000):
    """Last `chars` characters of the worker log, reading at most the final 12 KB."""
    try:
        with open(entry["log_file"], "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 12 * 1024))
            return f.read().decode("utf-8", errors="replace").strip()[-chars:]
    except OSError:
        return ""


def finish_card(cfg, entry, code, reason_override=None):
    """Write a finished (or killed) worker's outcome onto its task. Returns the outcome label."""
    card, board = entry["card"], entry["board"]
    tail = log_tail(entry)
    footer = f"\n\nHeadless {entry['lane']} run (pid {entry['pid']}, exit {code}). Log: {entry['log_file']}"
    if reason_override is None and code == 0:
        call(cfg, "complete", id=card, board=board, result=(tail + footer)[:8000],
             summary=f"{entry['lane']} lane runner: finished")
        return "completed"
    why = reason_override or {
        None: "Worker died without recording an exit code (host restart?).",
    }.get(code, f"Worker exited with code {code}.")
    call(cfg, "block", id=card, board=board, kind="needs_input",
         reason=f"{why} Review, then move the task back to ready (it will rerun) or finish it by hand.\n\n"
                f"{tail}{footer}"[:4000])
    return f"blocked (exit {code})"


def reconcile(cfg, state):
    """Heartbeat running workers; close out finished or timed-out ones."""
    max_runtime = cfg["max_runtime_minutes"] * 60
    for card, entry in list(state["cards"].items()):
        code = exit_code(entry)
        age = time.time() - entry["started"]
        try:
            if code is None and worker_alive(entry):
                if age > max_runtime:
                    if not DRY_RUN:
                        entry["pending_reason"] = f"Timed out after {cfg['max_runtime_minutes']} min."
                        kill_tree(entry["pid"])
                        outcome = finish_card(cfg, entry, exit_code(entry), reason_override=entry["pending_reason"])
                    else:
                        outcome = "would time out"
                else:
                    if not DRY_RUN:
                        call(cfg, "heartbeat", id=card, board=entry["board"], ttl_minutes=cfg["claim_ttl_minutes"])
                    continue
            else:
                outcome = finish_card(cfg, entry, code, reason_override=entry.get("pending_reason")) if not DRY_RUN else f"would close (exit {code})"
        except TransportError as exc:
            # Switchboard unreachable: keep the entry (and a finished run's undelivered result)
            # so the next tick retries the heartbeat/delivery instead of dropping the work.
            log(cfg, f"{entry['lane']} {card} [{entry['board']}] pid {entry['pid']}: "
                     f"switchboard unreachable ({exc}); keeping state, will retry")
            continue
        except RunnerError as exc:
            # Claim lost (someone released/reassigned the task): stop the work so it isn't done twice.
            if code is None and worker_alive(entry) and not DRY_RUN:
                kill_tree(entry["pid"])
            outcome = f"dropped: {exc}"
        log(cfg, f"{entry['lane']} {card} [{entry['board']}] pid {entry['pid']}: {outcome}")
        if not DRY_RUN:
            state["history"].append({**entry, "outcome": outcome, "ended": int(time.time())})
            del state["cards"][card]


def skip_reason(cfg, board, task, events=()):
    """Why this task must not run unattended, or None."""
    if board in cfg["skip_boards"]:
        return f"board {board} is excluded from unattended runs"
    if task.get("id") in cfg["skip_cards"]:
        return "task is on the lane runner's skip list"
    trusted = cfg.get("trusted_creators")
    if trusted is not None:
        if task.get("created_by") not in trusted:
            return f"created_by={task.get('created_by') or 'unknown'} is not in trusted_creators"
        # A trusted creator's task can still carry untrusted text: any agent able to call `edit`
        # could have rewritten its title or body after creation. The task's event history (from
        # `show`) is the record; when an edit's fields aren't recorded, assume the worst.
        for e in events or []:
            if e.get("kind") != "edited" or e.get("agent") in trusted:
                continue
            fields = e.get("fields")
            if fields is None or {"title", "body"} & set(fields):
                return f"title/body was edited by {e.get('agent') or 'an agent'} outside trusted_creators"
    text = f"{task.get('title', '')}\n{task.get('body') or ''}".lower()
    for marker in cfg["manual_markers"]:
        if marker.lower() in text:
            return f"marked {marker}"
    return None


def build_prompt(lane, board, detail, trusted_creators=None):
    """The unattended worker's task: card content plus operating rules and the receipt contract."""
    t = detail["task"]
    # Only comments authored by trusted agents go into the prompt: to the worker, a comment is
    # indistinguishable from instructions. trusted_creators=None means the gate is off entirely.
    kept = [c for c in detail.get("comments", []) if trusted_creators is None or c.get("author") in trusted_creators]
    comments = "\n".join(f"- {c.get('author')}: {str(c.get('body'))[:600]}" for c in kept[-8:])
    return f"""You are the "{lane}" lane, running UNATTENDED (headless, nobody watching) for task {t['id']}
on board "{board}". The operator reviews your receipt on the task afterwards.

Rules for unattended runs:
- PREPARE-ONLY. Do not send messages, post or publish anything, spend money, deploy to production,
  change account/credential settings, or delete data. Draft and stage instead, and list what needs
  a human's yes under NEXT.
- If the task needs something you cannot reach or a decision only a person can make, stop early and
  report RECEIPT: BLOCKED with exactly what is needed.
- Never edit code or config in place where it is live (run by cron, systemd, docker or a web
  server). Work on a copy or a git branch named after the task id ({t['id']}) and leave the deploy
  step under NEXT.
- Do not touch the task itself (no claim/complete/release/block); the runner records your receipt.
- Put durable work in files. List absolute paths under ARTIFACTS.

TASK
Title: {t['title']}
Priority: {t.get('priority')}   Created by: {t.get('created_by')}   Created: {t.get('created_at')}
Body:
{t.get('body') or '(no body)'}

Recent comments:
{comments or '(none)'}

Finish with this receipt block, each label on its own line:
RECEIPT: PASS | BLOCKED | FAIL - one-line summary
ARTIFACTS: plain absolute paths (no markdown links) or URLs of what you produced, or none
VERIFIED: how you checked the result
NEXT: what the operator or the next agent should do
SIDE_EFFECTS: none, or anything changed outside your files
"""


def launch(cfg, state):
    """Start at most one new worker per lane per tick, within concurrency and daily caps."""
    today = dt.date.today().isoformat()
    counts = state["runs"].setdefault(today, {})
    runs_dir = Path(cfg["runs_dir"])
    for lane, lane_cfg in cfg["lanes"].items():
        if not lane_cfg.get("enabled") or not lane_cfg.get("command"):
            continue
        running = sum(1 for e in state["cards"].values() if e["lane"] == lane)
        if running >= lane_cfg.get("concurrency", 1) or counts.get(lane, 0) >= lane_cfg.get("daily_cap", 8):
            continue
        ready = call(cfg, "list", assignee=lane, status="ready", limit=50).get("tasks", [])
        ready.sort(key=lambda t: (-(t.get("priority") or 0), t.get("created_at") or ""))
        for t in ready:
            card, board = t["id"], t["board"]
            if card in state["cards"]:
                continue
            if card in state["skipped"]:
                continue
            detail = call(cfg, "show", id=card, board=board)
            reason = skip_reason(cfg, board, detail["task"], detail.get("recent_events"))
            if reason:
                log(cfg, f"{lane} {card} [{board}]: skip, {reason}")
                if not DRY_RUN:
                    call(cfg, "comment", id=card, board=board,
                         body=f"[lane-runner] Left for an interactive {lane} session: {reason}.")
                    state["skipped"][card] = {"reason": reason, "at": int(time.time())}
                continue
            if DRY_RUN:
                log(cfg, f"{lane} {card} [{board}]: would launch '{t['title'][:60]}'")
                break
            if launch_one(cfg, state, lane, lane_cfg, board, detail, runs_dir):
                counts[lane] = counts.get(lane, 0) + 1
            break


def launch_one(cfg, state, lane, lane_cfg, board, detail, runs_dir):
    """Claim one task and start its worker subprocess. Returns True on a successful launch."""
    t = detail["task"]
    card = t["id"]
    call(cfg, "claim", id=card, board=board, ttl_minutes=cfg["claim_ttl_minutes"])
    runs_dir.mkdir(parents=True, exist_ok=True)
    prompt_file = runs_dir / f"{card}.prompt.txt"
    log_file = runs_dir / f"{card}.log"
    exit_file = runs_dir / f"{card}.exit"
    exit_file.unlink(missing_ok=True)  # a rerun must not read a stale exit code
    prompt_file.write_text(build_prompt(lane, board, detail, cfg.get("trusted_creators")))
    cmd = [a.replace("{prompt_file}", str(prompt_file)).replace("{task_id}", card) for a in lane_cfg["command"]]
    try:
        proc = subprocess.Popen(
            [sys.executable, "-c", _CHILD, str(prompt_file), str(log_file), str(exit_file), *cmd],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as exc:
        call(cfg, "release", id=card, board=board, reason=f"lane runner could not start a worker: {exc}")
        state["skipped"][card] = {"reason": f"launch failed: {exc}", "at": int(time.time())}
        log(cfg, f"{lane} {card} [{board}]: launch FAILED: {exc}")
        return False
    state["cards"][card] = {"lane": lane, "card": card, "board": board, "pid": proc.pid,
                            "pid_start": proc_start(proc.pid),
                            "log_file": str(log_file), "exit_file": str(exit_file),
                            "started": int(time.time()), "title": t["title"][:120]}
    call(cfg, "comment", id=card, board=board,
         body=f"[lane-runner] Started headless {lane} worker (pid {proc.pid}). "
              f"Log: {log_file}. Output lands here when it finishes.")
    log(cfg, f"{lane} {card} [{board}]: launched pid {proc.pid} '{t['title'][:60]}'")
    return True


def acquire_lock(cfg):
    """Take an exclusive non-blocking flock on <state_dir>/lane_runner.lock.

    Returns the open fd (the lock is held until this process exits) or None when another
    runner tick already holds it.
    """
    lock_path = Path(cfg["state_path"]).parent / "lane_runner.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def main():
    cfg = load_config()
    if not cfg.get("enabled"):
        return
    lock_fd = acquire_lock(cfg)
    if lock_fd is None:
        return  # another tick is still running; exit quietly
    state = load_state(cfg)
    try:
        reconcile(cfg, state)
        launch(cfg, state)
    except Exception as exc:  # log and keep state; the next tick retries
        log(cfg, f"ERROR: {type(exc).__name__}: {exc}")
    finally:
        save_state(cfg, state)


if __name__ == "__main__":
    main()
