#!/usr/bin/env python3
"""Switchboard `tasks` connector bridge: one JSON op in on stdin, one JSON result out on stdout.

Runs under Hermes' own venv so every read/write goes through hermes_cli.kanban_db (its locking,
events, dependency and circuit-breaker rules). Never touches kanban.db with raw SQL.

Input:  {"op": "<tool suffix>", "agent": "<switchboard agent>", "args": {...}}
Output: {"ok": true, "data": {...}} | {"ok": false, "error": "..."}

Claims taken through Switchboard use the lock "switchboard/<agent>". Hermes' dead-worker sweep only
touches host-local "<host>:<pid>" locks with a worker pid, so these claims end only by complete,
release, or TTL expiry (expiry counts as a failed attempt toward Hermes' circuit breaker).
"""
import json
import os
import sys
import time

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc

OPEN_STATUSES = ("triage", "todo", "ready", "running", "review", "blocked", "scheduled")
# Agent lanes pull their own work; the dispatcher skips them by design (skipped_nonspawnable).
# Configured with SB_TASK_LANES (comma list) so deployments can name their own pull lanes.
LANES = frozenset(
    s.strip().lower() for s in os.environ.get("SB_TASK_LANES", "claude,codex,human").split(",") if s.strip()
)
# Names agents use that are not profiles. "hermes" means Hermes itself, i.e. its root profile.
ASSIGNEE_ALIASES = {"hermes": "default", "worker": "default"}
DEFAULT_TTL_MIN = 60
MAX_TTL_MIN = 480


class BridgeError(Exception):
    pass


def lock_for(agent):
    return f"switchboard/{agent}"


def ttl_seconds(args):
    try:
        minutes = int(args.get("ttl_minutes") or DEFAULT_TTL_MIN)
    except (TypeError, ValueError):
        minutes = DEFAULT_TTL_MIN
    return max(5, min(minutes, MAX_TTL_MIN)) * 60


def board_slugs():
    return [b["slug"] for b in kb.list_boards(include_archived=False) if b.get("slug")]


def check_board(slug):
    if slug not in board_slugs():
        raise BridgeError(f"unknown board '{slug}'. Call boards for the list.")
    return slug


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)) if ts else None


def task_view(t, board, *, full=False):
    v = {
        "id": t.id, "board": board, "title": t.title, "status": t.status, "assignee": t.assignee,
        "priority": t.priority, "created_by": t.created_by, "created_at": iso(t.created_at),
        "claimed_by": t.claim_lock, "claim_expires": iso(t.claim_expires),
    }
    if t.branch_name:
        v["branch"] = t.branch_name
    if full:
        v.update(body=t.body, result=t.result, started_at=iso(t.started_at), completed_at=iso(t.completed_at),
                 workspace_path=t.workspace_path, block_kind=t.block_kind)
    elif t.body:
        v["body_preview"] = t.body[:200]
    return v


def locate(args):
    """Return (board, task) for args.id, searching every board when args.board is omitted."""
    task_id = str(args.get("id") or "").strip()
    if not task_id:
        raise BridgeError("id is required")
    boards = [check_board(args["board"])] if args.get("board") else board_slugs()
    for slug in boards:
        with kbc.connect_closing(board=slug) as conn:
            t = kb.get_task(conn, task_id)
            if t:
                return slug, t
    raise BridgeError(f"no task {task_id}" + (f" on board {args['board']}" if args.get("board") else ""))


def all_tasks(statuses, boards=None, assignee=None):
    out = []
    for slug in boards or board_slugs():
        with kbc.connect_closing(board=slug) as conn:
            for st in statuses:
                for t in kb.list_tasks(conn, status=st, assignee=assignee):
                    out.append((slug, t))
    return out


def op_boards(agent, args):
    rows = []
    for b in kb.list_boards(include_archived=False):
        rows.append({k: b.get(k) for k in ("slug", "name", "description") if b.get(k) is not None})
    return {"boards": rows}


def op_active(agent, args):
    """Everything someone is working on right now, plus review/blocked, across all boards."""
    running = [task_view(t, b) for b, t in all_tasks(("running",))]
    waiting_rows = all_tasks(("review", "blocked"))
    by_board = {}
    for b, t in waiting_rows:
        key = f"{b}/{t.status}"
        by_board[key] = by_board.get(key, 0) + 1
    waiting_rows.sort(key=lambda r: -(r[1].created_at or 0))
    waiting = {"total": len(waiting_rows), "by_board": by_board,
               "newest": [task_view(t, b) for b, t in waiting_rows[:15]]}
    return {"working_now": running, "waiting": waiting,
            "hint": "Before starting work, check working_now and find so you don't duplicate someone."}


def op_list(agent, args):
    status = args.get("status")
    if status and status not in OPEN_STATUSES + ("done", "archived"):
        raise BridgeError(f"bad status '{status}'")
    assignee = agent if args.get("mine") else args.get("assignee")
    boards = [check_board(args["board"])] if args.get("board") else None
    limit = max(1, min(int(args.get("limit") or 50), 200))
    rows = all_tasks((status,) if status else OPEN_STATUSES, boards, assignee)
    rows.sort(key=lambda r: (-(r[1].priority or 0), r[1].created_at))
    return {"tasks": [task_view(t, b) for b, t in rows[:limit]], "total": len(rows)}


def op_find(agent, args):
    q = str(args.get("query") or "").strip().lower()
    if len(q) < 3:
        raise BridgeError("query must be at least 3 characters")
    words = [w for w in q.split() if len(w) > 2]
    statuses = OPEN_STATUSES + (("done",) if args.get("include_done") else ())
    hits = []
    for b, t in all_tasks(statuses):
        hay = f"{t.title}\n{t.body or ''}\n{t.result or ''}".lower()
        score = sum(1 for w in words if w in hay)
        if q in hay or (words and score >= max(1, (len(words) + 1) // 2)):
            hits.append((score + (5 if q in hay else 0), b, t))
    hits.sort(key=lambda h: -h[0])
    return {"matches": [task_view(t, b) for _, b, t in hits[:25]]}


def op_show(agent, args):
    board, t = locate(args)
    with kbc.connect_closing(board=board) as conn:
        comments = [{"author": c.author, "body": c.body, "at": iso(c.created_at)} for c in kb.list_comments(conn, t.id)]
        events = []
        for e in kb.list_events(conn, t.id):
            # `agent` and `fields` are what tools/lane_runner.py needs to spot untrusted
            # title/body edits; Hermes event rows expose them only sometimes, so be defensive.
            ev = {"kind": e.kind, "at": iso(e.created_at)}
            actor = getattr(e, "agent", None) or getattr(e, "actor", None)
            if actor:
                ev["agent"] = actor
            payload = getattr(e, "payload", None)
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except (TypeError, ValueError):
                    payload = None
            if isinstance(payload, dict) and payload.get("fields"):
                ev["fields"] = payload["fields"]
            events.append(ev)
    return {"task": task_view(t, board, full=True), "comments": comments[-30:], "recent_events": events[-15:]}


def _create(agent, args, assignee, *, triage=False):
    board = check_board(args.get("board") or "")
    title = str(args.get("title") or "").strip()
    if not title:
        raise BridgeError("title is required")
    parents = args.get("parents") or ()
    with kbc.connect_closing(board=board) as conn:
        task_id = kb.create_task(
            conn, title=title[:300], body=args.get("body"), assignee=assignee, created_by=agent,
            priority=int(args.get("priority") or 0), parents=tuple(parents), board=board,
            idempotency_key=args.get("idempotency_key"), branch_name=args.get("branch"), triage=triage,
        )
        return board, kb.get_task(conn, task_id)


def resolve_assignee(raw):
    """Validate a create-time assignee: a Hermes profile, an agent lane, or an alias.
    Returns None when empty (the card then goes to triage for the orchestrator to route)."""
    name = str(raw or "").strip().lower()
    if not name:
        return None
    name = ASSIGNEE_ALIASES.get(name, name)
    if name in LANES:
        return name
    from hermes_cli.profiles import list_profile_names
    profiles = list_profile_names()
    if name in profiles:
        return name
    raise BridgeError(
        f"unknown assignee '{raw}'. Use a Hermes profile ({', '.join(sorted(profiles))}), "
        f"an agent lane ({', '.join(sorted(LANES))}), or leave it empty to let Hermes route it.")


def op_create(agent, args):
    """Create a card. No assignee = triage, so Hermes' auto-decomposer picks the profile(s)."""
    assignee = resolve_assignee(args.get("assignee"))
    board, t = _create(agent, args, assignee, triage=assignee is None)
    return {"task": task_view(t, board, full=True)}


def _claim(agent, board, t, args):
    lock = lock_for(agent)
    if t.status == "running" and t.claim_lock == lock:
        return t  # already ours: idempotent
    with kbc.connect_closing(board=board) as conn:
        claimed = kb.claim_task(conn, t.id, ttl_seconds=ttl_seconds(args), claimer=lock)
        if claimed is None:
            cur = kb.get_task(conn, t.id)
            raise BridgeError(
                f"cannot claim {t.id}: status={cur.status}, claimed_by={cur.claim_lock or 'nobody'}"
                + (f" until {iso(cur.claim_expires)}" if cur.claim_expires else "")
                + (". It must be 'ready' (todo tasks still have open parents)." if cur.status != "running" else "")
            )
        return claimed


def op_claim(agent, args):
    board, t = locate(args)
    t = _claim(agent, board, t, args)
    return {"task": task_view(t, board, full=True),
            "note": "Claimed. Call heartbeat to extend, complete when done, release if you stop."}


def op_start(agent, args):
    """Declare ad-hoc work: create a task assigned to yourself and claim it in one step."""
    board, t = _create(agent, args, agent)
    t = _claim(agent, board, t, args)
    return {"task": task_view(t, board, full=True)}


def _require_owner(agent, t, verb):
    if t.status != "running" or t.claim_lock != lock_for(agent):
        raise BridgeError(f"cannot {verb} {t.id}: you don't hold its claim (status={t.status}, "
                          f"claimed_by={t.claim_lock or 'nobody'})")


def op_heartbeat(agent, args):
    board, t = locate(args)
    _require_owner(agent, t, "heartbeat")
    with kbc.connect_closing(board=board) as conn:
        if not kb.heartbeat_claim(conn, t.id, ttl_seconds=ttl_seconds(args), claimer=lock_for(agent)):
            raise BridgeError(f"heartbeat failed for {t.id} (claim lost?)")
        if args.get("note"):
            kb.add_comment(conn, t.id, agent, f"[progress] {str(args['note'])[:2000]}")
        t = kb.get_task(conn, t.id)
    return {"task": task_view(t, board)}


def op_comment(agent, args):
    board, t = locate(args)
    body = str(args.get("body") or "").strip()
    if not body:
        raise BridgeError("body is required")
    with kbc.connect_closing(board=board) as conn:
        kb.add_comment(conn, t.id, agent, body[:8000])
    return {"ok": True, "id": t.id}


def op_complete(agent, args):
    board, t = locate(args)
    result = str(args.get("result") or "").strip()
    if not result:
        raise BridgeError("result is required: say what you did and where (branch, files, links)")
    if t.status == "running":
        _require_owner(agent, t, "complete")
    metadata = args.get("metadata") if isinstance(args.get("metadata"), dict) else None
    with kbc.connect_closing(board=board) as conn:
        done = kb.complete_task(conn, t.id, result=result[:8000], summary=args.get("summary"),
                                metadata=metadata, expected_run_id=t.current_run_id if t.status == "running" else None)
        if not done:
            cur = kb.get_task(conn, t.id)
            raise BridgeError(f"could not complete {t.id} (status={cur.status})")
        t = kb.get_task(conn, t.id)
    return {"task": task_view(t, board)}


def op_release(agent, args):
    board, t = locate(args)
    _require_owner(agent, t, "release")
    reason = str(args.get("reason") or "released via switchboard")[:500]
    with kbc.connect_closing(board=board) as conn:
        if not kb.reclaim_task(conn, t.id, reason=f"{agent}: {reason}"):
            raise BridgeError(f"release failed for {t.id}")
        kb.add_comment(conn, t.id, agent, f"[released] {reason}")
        t = kb.get_task(conn, t.id)
    return {"task": task_view(t, board)}


def op_block(agent, args):
    """Park a claimed card for a human: running -> blocked with a reason (used by the lane runner)."""
    board, t = locate(args)
    _require_owner(agent, t, "block")
    reason = str(args.get("reason") or "").strip()
    if not reason:
        raise BridgeError("reason is required: say what is needed to unblock it")
    kind = args.get("kind") or "needs_input"
    if kind not in kb.VALID_BLOCK_KINDS:
        raise BridgeError(f"kind must be one of {sorted(kb.VALID_BLOCK_KINDS)}")
    with kbc.connect_closing(board=board) as conn:
        if not kb.block_task(conn, t.id, reason=reason[:4000], kind=kind, expected_run_id=t.current_run_id):
            raise BridgeError(f"block failed for {t.id}")
        kb.add_comment(conn, t.id, agent, f"[blocked] {reason[:4000]}")
        t = kb.get_task(conn, t.id)
    return {"task": task_view(t, board)}


def op_edit(agent, args):
    """Edit an open card's title/body/priority (append_body adds a paragraph instead of replacing)."""
    board, t = locate(args)
    if t.status in ("done", "archived"):
        raise BridgeError(f"{t.id} is {t.status}; only open cards can be edited")
    title = args.get("title")
    body = args.get("body")
    if args.get("append_body"):
        body = ((body if body is not None else t.body) or "").rstrip() + "\n\n" + str(args["append_body"]).strip()
    priority = args.get("priority")
    if title is None and body is None and priority is None:
        raise BridgeError("nothing to change: pass title, body, append_body or priority")
    with kbc.connect_closing(board=board) as conn:
        ok = kb.edit_task(conn, t.id, title=str(title)[:300] if title is not None else None,
                          body=str(body)[:20000] if body is not None else None,
                          priority=int(priority) if priority is not None else None)
        if not ok:
            raise BridgeError(f"edit failed for {t.id}")
        kb.add_comment(conn, t.id, agent, "[edited] " + ", ".join(k for k in ("title", "body", "priority")
                       if (args.get(k) is not None or (k == "body" and args.get("append_body")))))
        t = kb.get_task(conn, t.id)
    return {"task": task_view(t, board)}


def op_park(agent, args):
    """Icebox a card: status scheduled (no agent or dispatcher will pick it up) until unpark."""
    board, t = locate(args)
    if t.status in ("done", "archived", "running"):
        raise BridgeError(f"{t.id} is {t.status}; release or finish it before parking")
    reason = str(args.get("reason") or "").strip()
    if not reason:
        raise BridgeError("reason is required: say why it is parked")
    until = str(args.get("until") or "").strip()
    text = f"until {until}: {reason}" if until else reason
    with kbc.connect_closing(board=board) as conn:
        if t.status == "blocked":
            kb.unblock_task(conn, t.id)
        if not kb.schedule_task(conn, t.id, reason=text[:1000]):
            raise BridgeError(f"park failed for {t.id}")
        kb.add_comment(conn, t.id, agent, f"[parked] {text[:1000]}")
        t = kb.get_task(conn, t.id)
    return {"task": task_view(t, board)}


def op_unpark(agent, args):
    """Bring a parked (scheduled) or blocked card back into play."""
    board, t = locate(args)
    if t.status not in ("scheduled", "blocked"):
        raise BridgeError(f"{t.id} is {t.status}; only parked or blocked cards can be brought back")
    with kbc.connect_closing(board=board) as conn:
        if not kb.unblock_task(conn, t.id):
            raise BridgeError(f"unpark failed for {t.id}")
        kb.add_comment(conn, t.id, agent, f"[unparked] {str(args.get('reason') or 'back in play')[:500]}")
        t = kb.get_task(conn, t.id)
    return {"task": task_view(t, board)}


OPS = {
    "boards": op_boards, "active": op_active, "list": op_list, "find": op_find, "show": op_show,
    "create": op_create, "start": op_start, "claim": op_claim, "heartbeat": op_heartbeat,
    "comment": op_comment, "complete": op_complete, "release": op_release, "block": op_block,
    "edit": op_edit, "park": op_park, "unpark": op_unpark,
}


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
        agent = str(req.get("agent") or "").strip()
        if not agent:
            raise BridgeError("no caller identity")
        fn = OPS.get(req.get("op"))
        if not fn:
            raise BridgeError(f"unknown op {req.get('op')}")
        out = {"ok": True, "data": fn(agent, req.get("args") or {})}
    except BridgeError as e:
        out = {"ok": False, "error": str(e)}
    except Exception as e:  # surface Hermes-side errors (ValueError on bad parents etc.) as tool errors
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(out, default=str))


if __name__ == "__main__":
    main()
