#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "benchmark-fixtures");
mkdirSync(outDir, { recursive: true });

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFixture(name, opts) {
  const rng = mulberry32(opts.seed);
  const events = [];

  events.push({ type: "document", key: "doc:goal", content: opts.goal });
  events.push({ type: "document", key: "doc:constraints", content: opts.constraints.join("\n") });

  for (let i = 0; i < opts.total; i += 1) {
    const roll = rng();
    if (roll < opts.decisionRate) {
      events.push({ type: "stream", content: `We decide to prioritize ${opts.topic} batch ${i}` });
    } else if (roll < opts.decisionRate + opts.todoRate) {
      events.push({ type: "stream", content: `TODO: validate ${opts.topic} metric ${i}` });
    } else if (roll < opts.decisionRate + opts.todoRate + opts.blockerRate) {
      events.push({ type: "stream", content: `Blocked by ${opts.blocker} ${i}` });
    } else if (roll < opts.decisionRate + opts.todoRate + opts.blockerRate + opts.statusRate) {
      events.push({ type: "stream", content: `Status update: processed ${opts.topic} item ${i}` });
    } else {
      events.push({ type: "stream", content: `noise ping ${Math.floor(rng() * 1000)}` });
    }
  }

  const retrieveCases = [
    { query: "What did we decide?", expected: "decide", aliases: ["decision", "agreed", "we decide", "we will"] },
    { query: "What constraints exist?", expected: "constraint", aliases: ["limitation", "must", "cannot", "blocked"] },
    { query: "Any blockers?", expected: "blocked", aliases: ["blocker", "constraint", "risk"] },
    { query: "What todos are pending?", expected: "todo", aliases: ["next step", "action item", "pending", "follow up"] }
  ];

  const payload = { events, retrieveCases };
  const outPath = path.join(outDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath}`);
}

makeFixture("decision-heavy", {
  seed: 11,
  total: 80,
  decisionRate: 0.35,
  todoRate: 0.15,
  blockerRate: 0.1,
  statusRate: 0.2,
  topic: "consistency",
  blocker: "queue latency",
  goal: "goal: maximize digest consistency under noisy streams",
  constraints: ["constraint: avoid hosted dependencies", "constraint: keep api stable"]
});

makeFixture("noise-heavy", {
  seed: 21,
  total: 120,
  decisionRate: 0.08,
  todoRate: 0.1,
  blockerRate: 0.05,
  statusRate: 0.12,
  topic: "retrieval",
  blocker: "index drift",
  goal: "goal: evaluate retrieval robustness under noise",
  constraints: ["constraint: no vector index", "constraint: deterministic scoring"]
});
