import express from "express";
import { adapterEnv } from "./env";

const app = express();
app.use(express.json());

async function apiFetch(path: string, telegramUserId: string, options?: RequestInit) {
  const response = await fetch(`${adapterEnv.apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-telegram-user-id": telegramUserId,
      ...(options?.headers || {})
    }
  });
  return response.json();
}

async function sendMessage(chatId: number, text: string) {
  if (!adapterEnv.botToken) return;
  await fetch(`https://api.telegram.org/bot${adapterEnv.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function setWebhook() {
  if (!adapterEnv.botToken || !adapterEnv.publicBaseUrl) return { ok: false };
  const url = `${adapterEnv.publicBaseUrl}${adapterEnv.webhookPath}`;
  const response = await fetch(`https://api.telegram.org/bot${adapterEnv.botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });
  return response.json();
}

async function getActiveScopeId(telegramUserId: string) {
  const result = await apiFetch("/state", telegramUserId);
  return result?.activeScopeId as string | null;
}

app.post(adapterEnv.webhookPath, async (req, res) => {
  if (!adapterEnv.featureTelegram) {
    return res.json({ ok: true });
  }

  const update = req.body;
  const message = update.message;
  if (!message || !message.text || !message.from) {
    return res.json({ ok: true });
  }

  const telegramUserId = String(message.from.id);
  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text.startsWith("/start")) {
    await apiFetch("/scopes", telegramUserId);
    await sendMessage(chatId, "Project Memory Engine. Commands: /new <name>, /p, /use <name|id>, /digest, /remind <minutes> <text>");
    return res.json({ ok: true });
  }

  if (text.startsWith("/new")) {
    const name = text.replace("/new", "").trim();
    if (!name) {
      await sendMessage(chatId, "Usage: /new <name>");
      return res.json({ ok: true });
    }
    const scope = await apiFetch("/scopes", telegramUserId, {
      method: "POST",
      body: JSON.stringify({ name })
    });
    await sendMessage(chatId, `Created scope: ${scope.name} (${scope.id}) and set active.`);
    return res.json({ ok: true });
  }

  if (text.startsWith("/p")) {
    const scopes = await apiFetch("/scopes", telegramUserId);
    const activeId = await getActiveScopeId(telegramUserId);
    const lines = scopes.items.map((s: any) => `${s.id === activeId ? "*" : "-"} ${s.name} (${s.id})`);
    await sendMessage(chatId, lines.length ? lines.join("\n") : "No scopes yet.");
    return res.json({ ok: true });
  }

  if (text.startsWith("/use")) {
    const query = text.replace("/use", "").trim();
    if (!query) {
      await sendMessage(chatId, "Usage: /use <name|id>");
      return res.json({ ok: true });
    }
    const scopes = await apiFetch("/scopes", telegramUserId);
    const match = scopes.items.find((s: any) => s.id === query || s.name.toLowerCase() === query.toLowerCase());
    if (!match) {
      await sendMessage(chatId, "Scope not found.");
      return res.json({ ok: true });
    }
    await apiFetch(`/scopes/${match.id}/active`, telegramUserId, { method: "POST" });
    await sendMessage(chatId, `Active scope set: ${match.name}`);
    return res.json({ ok: true });
  }

  if (text.startsWith("/digest")) {
    const activeId = await getActiveScopeId(telegramUserId);
    if (!activeId) {
      await sendMessage(chatId, "No active scope. Use /use or /new.");
      return res.json({ ok: true });
    }
    const result = await apiFetch("/memory/digest", telegramUserId, {
      method: "POST",
      body: JSON.stringify({ scopeId: activeId })
    });
    await sendMessage(chatId, `Digest queued. Job: ${result.jobId}`);
    return res.json({ ok: true });
  }

  if (text.startsWith("/remind")) {
    const parts = text.split(" ").slice(1);
    const minutes = Number(parts.shift());
    const reminderText = parts.join(" ").trim();
    if (!Number.isFinite(minutes) || !reminderText) {
      await sendMessage(chatId, "Usage: /remind <minutes> <text>");
      return res.json({ ok: true });
    }
    const activeId = await getActiveScopeId(telegramUserId);
    const dueAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    await apiFetch("/reminders", telegramUserId, {
      method: "POST",
      body: JSON.stringify({ scopeId: activeId, dueAt, text: reminderText })
    });
    await sendMessage(chatId, `Reminder scheduled in ${minutes} minutes.`);
    return res.json({ ok: true });
  }

  const activeId = await getActiveScopeId(telegramUserId);
  if (!activeId) {
    await sendMessage(chatId, "No active scope. Use /new to create one.");
    return res.json({ ok: true });
  }

  await apiFetch("/memory/events", telegramUserId, {
    method: "POST",
    body: JSON.stringify({ scopeId: activeId, type: "stream", source: "telegram", content: text })
  });
  await sendMessage(chatId, "Logged.");
  return res.json({ ok: true });
});

app.post("/telegram/webhook/set", async (_req, res) => {
  const result = await setWebhook();
  res.json(result);
});

app.listen(adapterEnv.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Telegram adapter listening on ${adapterEnv.port}`);
});
