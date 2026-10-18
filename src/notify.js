/**
 * Pluggable operator notifications (OAuth sign-in approval, etc.).
 * @module
 */
import { appendFileSync } from "node:fs";

/**
 * Send a Telegram message with a single URL button.
 * @param {string} botToken
 * @param {string} chatId
 * @returns {(text: string, url: string) => Promise<void>}
 */
export function telegramNotifier(botToken, chatId) {
  return async (text, url) => {
    if (!botToken || !chatId) throw new Error("Telegram not configured");
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "Review sign-in", url }]] } }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram ${r.status}: ${j.description || "send failed"}`);
  };
}

/**
 * POST JSON `{ text, url }` to a Slack/Discord-compatible incoming webhook.
 * @param {string} webhookUrl
 * @returns {(text: string, url: string) => Promise<void>}
 */
function webhookNotifier(webhookUrl) {
  return async (text, url) => {
    const combined = `${text}\n${url}`;
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, url, content: combined }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`webhook ${r.status}`);
  };
}

/**
 * POST plain text to ntfy; `Click` header opens the approval URL.
 * @param {string} ntfyUrl
 * @returns {(text: string, url: string) => Promise<void>}
 */
function ntfyNotifier(ntfyUrl) {
  return async (text, url) => {
    const r = await fetch(ntfyUrl, {
      method: "POST",
      headers: { Click: url, Title: "Switchboard", "Content-Type": "text/plain" },
      body: text,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`ntfy ${r.status}`);
  };
}

/**
 * Write notifications to stdout / events log (operator uses `sb oauth pending`).
 * Does not log the one-time approval token URL.
 * @param {(kind: string, rec: object) => void} [log]
 * @returns {(text: string, url: string) => Promise<void>}
 */
function logNotifier(log) {
  return async (text) => {
    const rec = { ts: new Date().toISOString(), event: "operator_notify", text };
    const line = JSON.stringify(rec) + "\n";
    process.stdout.write(line);
    if (log) log("events", rec);
  };
}

/**
 * Choose a notifier from environment / registry vars.
 * @param {Record<string, string>} vars - resolved env (connections env_files + process env)
 * @param {{ log?: (kind: string, rec: object) => void }} [opts]
 * @returns {(text: string, url: string) => Promise<void>}
 */
export function makeNotifier(vars, opts = {}) {
  if (process.env.SB_OAUTH_NOTIFY_FILE) {
    const file = process.env.SB_OAUTH_NOTIFY_FILE;
    return async (text, url) => {
      appendFileSync(file, JSON.stringify({ text, url }) + "\n");
    };
  }
  const mode = (process.env.SB_NOTIFY || vars.SB_NOTIFY || "log").toLowerCase();
  if (mode === "telegram") {
    const token = vars.SB_TELEGRAM_BOT_TOKEN;
    const chat = vars.SB_TELEGRAM_CHAT_ID;
    return telegramNotifier(token, chat);
  }
  if (mode === "webhook") {
    const url = process.env.SB_NOTIFY_WEBHOOK_URL || vars.SB_NOTIFY_WEBHOOK_URL;
    return webhookNotifier(url);
  }
  if (mode === "ntfy") {
    const url = process.env.SB_NTFY_URL || vars.SB_NTFY_URL;
    return ntfyNotifier(url);
  }
  return logNotifier(opts.log);
}
