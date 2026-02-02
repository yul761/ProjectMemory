import { Command } from "commander";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { cliEnv } from "./env";

const configDir = path.join(os.homedir(), ".projectmemory");
const configFile = path.join(configDir, "config.json");

function getOrCreateUserId() {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  if (!fs.existsSync(configFile)) {
    const userId = randomUUID();
    fs.writeFileSync(configFile, JSON.stringify({ userId }, null, 2));
    return userId;
  }
  const content = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (!content.userId) {
    content.userId = randomUUID();
    fs.writeFileSync(configFile, JSON.stringify(content, null, 2));
  }
  return content.userId as string;
}

async function apiFetch(pathname: string, options?: RequestInit) {
  const userId = getOrCreateUserId();
  const response = await fetch(`${cliEnv.apiBaseUrl}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-user-id": userId,
      ...(options?.headers || {})
    }
  });
  return response.json();
}

const program = new Command();
program.name("pm").description("Project Memory CLI");

program
  .command("scopes")
  .description("List scopes")
  .action(async () => {
    const result = await apiFetch("/scopes");
    result.items.forEach((s: any) => {
      // eslint-disable-next-line no-console
      console.log(`${s.name} (${s.id})`);
    });
  });

program
  .command("new")
  .argument("<name>")
  .description("Create a scope")
  .action(async (name: string) => {
    const scope = await apiFetch("/scopes", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    // eslint-disable-next-line no-console
    console.log(`Created scope ${scope.name} (${scope.id})`);
  });

program
  .command("use")
  .argument("<nameOrId>")
  .description("Set active scope")
  .action(async (nameOrId: string) => {
    const scopes = await apiFetch("/scopes");
    const match = scopes.items.find((s: any) => s.id === nameOrId || s.name.toLowerCase() === nameOrId.toLowerCase());
    if (!match) {
      // eslint-disable-next-line no-console
      console.log("Scope not found.");
      return;
    }
    await apiFetch(`/scopes/${match.id}/active`, { method: "POST" });
    // eslint-disable-next-line no-console
    console.log(`Active scope set: ${match.name}`);
  });

program
  .command("log")
  .argument("<text>")
  .description("Ingest stream event to active scope")
  .action(async (text: string) => {
    const state = await apiFetch("/state");
    if (!state.activeScopeId) {
      // eslint-disable-next-line no-console
      console.log("No active scope.");
      return;
    }
    await apiFetch("/memory/events", {
      method: "POST",
      body: JSON.stringify({ scopeId: state.activeScopeId, type: "stream", source: "cli", content: text })
    });
    // eslint-disable-next-line no-console
    console.log("Logged.");
  });

program
  .command("upsert-note")
  .argument("<key>")
  .argument("<text>")
  .description("Upsert document memory by key")
  .action(async (key: string, text: string) => {
    const state = await apiFetch("/state");
    if (!state.activeScopeId) {
      // eslint-disable-next-line no-console
      console.log("No active scope.");
      return;
    }
    await apiFetch("/memory/events", {
      method: "POST",
      body: JSON.stringify({ scopeId: state.activeScopeId, type: "document", source: "cli", key, content: text })
    });
    // eslint-disable-next-line no-console
    console.log("Document upserted.");
  });

program
  .command("digest")
  .description("Enqueue digest for active scope")
  .action(async () => {
    const state = await apiFetch("/state");
    if (!state.activeScopeId) {
      // eslint-disable-next-line no-console
      console.log("No active scope.");
      return;
    }
    const result = await apiFetch("/memory/digest", {
      method: "POST",
      body: JSON.stringify({ scopeId: state.activeScopeId })
    });
    // eslint-disable-next-line no-console
    console.log(`Digest queued. Job: ${result.jobId}`);
  });

program
  .command("ask")
  .argument("<question>")
  .description("Ask a question using memory")
  .action(async (question: string) => {
    const state = await apiFetch("/state");
    if (!state.activeScopeId) {
      // eslint-disable-next-line no-console
      console.log("No active scope.");
      return;
    }
    const result = await apiFetch("/memory/answer", {
      method: "POST",
      body: JSON.stringify({ scopeId: state.activeScopeId, question })
    });
    if (result.error) {
      // eslint-disable-next-line no-console
      console.log(result.error);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(result.answer);
  });

program
  .command("remind")
  .argument("<minutes>")
  .argument("<text>")
  .description("Schedule a reminder in N minutes")
  .action(async (minutes: string, text: string) => {
    const state = await apiFetch("/state");
    const value = Number(minutes);
    if (!Number.isFinite(value)) {
      // eslint-disable-next-line no-console
      console.log("Minutes must be a number.");
      return;
    }
    const dueAt = new Date(Date.now() + value * 60 * 1000).toISOString();
    await apiFetch("/reminders", {
      method: "POST",
      body: JSON.stringify({ scopeId: state.activeScopeId ?? null, dueAt, text })
    });
    // eslint-disable-next-line no-console
    console.log(`Reminder scheduled in ${value} minutes.`);
  });

program.parseAsync();
