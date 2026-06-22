#!/usr/bin/env node
// StateCore「遗忘边界」诊断探针
// 用法: node scripts/diagnostics/forgetting-probe.mjs
// 前置: 全栈在 localhost:3002 运行 (docker compose -f docker-compose.local.yml up -d)

const BASE = process.env.BASE_URL || "http://localhost:3002";
const USER = process.env.USER_ID || "local-dev-user";
const H = { "content-type": "application/json", "x-user-id": USER };

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ingest = (scopeId, type, content, key) =>
  api("POST", "/memory/events", { scopeId, type, source: "api", content, ...(key ? { key } : {}) });

const retrieve = (scopeId, query, limit) =>
  api("POST", "/memory/retrieve", { scopeId, query, limit });

const events = (r) => (r && Array.isArray(r.events) ? r.events : []);
const hit = (evs, needle) => evs.some((e) => (e.content || "").includes(needle));
const rankOf = (evs, needle) => {
  const i = evs.findIndex((e) => (e.content || "").includes(needle));
  return i < 0 ? "-" : String(i + 1);
};

function line() { console.log("─".repeat(78)); }
function head(t) { line(); console.log(t); line(); }

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scope = await api("POST", "/scopes", { name: `forgetting-probe ${stamp}`, template: "personal" });
  const scopeId = scope.id;
  console.log(`scope: ${scopeId}  (template=personal)\nmodel/path: runtime budget = retrieve limit≈4, 2 snippets shown\n`);

  // ===== 探针 A: 中文分词根因 =====
  // 早期灌两条事实
  await ingest(scopeId, "stream", "I am allergic to peanuts");
  await ingest(scopeId, "stream", "我对花生过敏");
  // 之后灌 6 条无关中文，把事实挤出 recency 窗口
  for (const c of ["今天去爬山了", "昨天看了一部电影", "周末和朋友吃了火锅", "买了一双新跑鞋", "最近在学吉他", "下周要出差去上海"]) {
    await ingest(scopeId, "stream", c);
  }

  head("探针 A — 隔离「中文分词」根因  (白盒 /memory/retrieve, 无 LLM)");
  console.log("PASS 这里 = 病按预期复现 (中文捞不回 / 换说法捞不回)\n");
  const probes = [
    { tag: "A1 EN 共享词", q: "which foods am I allergic to", needle: "peanut", expectHit: true,  note: "基线：英文有共享词应命中" },
    { tag: "A1 ZH 共享词", q: "我对什么过敏",                  needle: "花生",   expectHit: false, note: "★分词病：中文同样共享词却丢" },
    { tag: "A2 EN 换说法", q: "is there anything I should not eat", needle: "peanut", expectHit: false, note: "语义病：无共享词英文也丢" },
    { tag: "A2 ZH 换说法", q: "我有什么忌口",                  needle: "花生",   expectHit: false, note: "语义病：中文换说法丢" }
  ];
  console.log("probe            | top3 命中 | rank@3 | rank@20 | 预期 | 裁决");
  for (const p of probes) {
    const r3 = await retrieve(scopeId, p.q, 3);
    const r20 = await retrieve(scopeId, p.q, 20);
    const h3 = hit(events(r3), p.needle);
    const verdict = h3 === p.expectHit ? "✓ 符合预期" : "✗ 不符预期";
    console.log(
      `${p.tag.padEnd(14)} | ${(h3 ? "是" : "否").padEnd(7)} | ${rankOf(events(r3), p.needle).padEnd(6)} | ${rankOf(events(r20), p.needle).padEnd(7)} | ${(p.expectHit ? "命中" : "丢失").padEnd(4)} | ${verdict}`
    );
  }
  console.log("\n注: rank@20 列若有数字而 rank@3 为「-」→ 事实「存住了但被 runtime 小预算挤出」(非删除)。");

  // ===== 探针 B: 本体论压缩根因 =====
  head("探针 B — 隔离「本体论压缩」根因  (document → digest → 白盒上下文)");
  const resume = [
    "张明 — 个人简历",
    "教育: 清华大学 计算机科学 本科 (2015-2019)",
    "工作经历:",
    "  - 字节跳动  后端工程师  2019年7月 至 2022年3月  (负责推荐系统)",
    "  - 小红书    资深工程师  2022年4月 至今          (负责搜索基础设施)",
    "技能: Rust, Go, 分布式系统, PostgreSQL",
    "联系方式: zhangming@example.com"
  ].join("\n");
  await ingest(scopeId, "document", resume, "resume-zhangming");

  await api("POST", "/memory/digest", { scopeId });
  process.stdout.write("等待 worker 完成 digest");
  let stable = "";
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    process.stdout.write(".");
    try {
      const ss = await api("GET", `/memory/stable-state?scopeId=${scopeId}`);
      stable = JSON.stringify(ss);
      const fv0 = await api("GET", `/memory/fast-view?scopeId=${scopeId}&message=${encodeURIComponent("当前状态")}`);
      const block = fv0?.fastLayerContext?.stableStateBlock || "";
      if (block && block !== "(none)") break;
    } catch {}
  }
  console.log("");

  const fv = await api("GET", `/memory/fast-view?scopeId=${scopeId}&message=${encodeURIComponent("我在哪家公司工作过")}`);
  const stableBlock = fv?.fastLayerContext?.stableStateBlock || "(none)";
  const retrievalBlock = fv?.fastLayerContext?.retrievalBlock || "(none)";
  const COMPANY = "字节跳动";
  const inStable = stableBlock.includes(COMPANY);
  const inRetrieval = retrievalBlock.includes(COMPANY);

  console.log(`\n[编译上下文 · State 块]\n${stableBlock}\n`);
  console.log(`[编译上下文 · Retrieval 块]\n${retrievalBlock}\n`);
  console.log(`简历具体公司名「${COMPANY}」是否在 State 块: ${inStable ? "是" : "否 ★本体论压缩丢失"}`);
  console.log(`是否在 Retrieval 块(2×180): ${inRetrieval ? "是" : "否"}`);

  try {
    const ans = await api("POST", "/memory/answer", { scopeId, question: "我在哪家公司工作过？请说出具体公司名。" });
    console.log(`\n[LLM 旁证 · /memory/answer]\n问: 我在哪家公司工作过？\n答: ${ans.answer}`);
    console.log(`答复含「${COMPANY}」: ${(ans.answer || "").includes(COMPANY) ? "是" : "否"}`);
  } catch (e) {
    console.log(`\n[/memory/answer 失败] ${e.message}`);
  }

  // ===== 探针 B2: 把简历挤出 recency 窗口后，本体论压缩的真后果 =====
  head("探针 B2 — 简历不再是最新事件后  (加干扰事件 → 排除 §12.6 recency 混淆)");
  console.log("目的: B1 里简历是最新事件、进了 retrieval 块、LLM 答对 = recency 混淆。");
  console.log("加干扰事件把简历挤出 recency 窗，再看运行时上下文(State+2×180)还能否带出公司名。\n");
  const distractors = [
    "明天要去超市买菜", "周三晚上和老王打羽毛球", "最近在追一部新剧",
    "昨天下午开了个长会", "想报名一个摄影课", "周末打算去爬香山",
    "家里的空调需要清洗了", "下个月要交房租", "今天午饭吃了牛肉面",
    "在看一本关于历史的书", "想换一台新手机", "周五要去看牙医"
  ];
  for (const c of distractors) await ingest(scopeId, "stream", c);
  await sleep(2000); // 让事件落库 (分类是异步的，retrieve 不依赖它)

  const fv2 = await api("GET", `/memory/fast-view?scopeId=${scopeId}&message=${encodeURIComponent("我在哪家公司工作过")}`);
  const stableBlock2 = fv2?.fastLayerContext?.stableStateBlock || "(none)";
  const retrievalBlock2 = fv2?.fastLayerContext?.retrievalBlock || "(none)";
  const inStable2 = stableBlock2.includes(COMPANY);
  const inRetrieval2 = retrievalBlock2.includes(COMPANY);
  console.log(`\n[编译上下文 · State 块]\n${stableBlock2}\n`);
  console.log(`[编译上下文 · Retrieval 块]\n${retrievalBlock2}\n`);
  console.log(`公司名「${COMPANY}」在 State 块: ${inStable2 ? "是" : "否 ★本体论压缩(同 B1)"}`);
  console.log(`在运行时 Retrieval 块(2×180): ${inRetrieval2 ? "是 ←bigram/embedding 召回了" : "否 ←被挤出窗口=运行时长期遗忘坐实"}`);

  try {
    const ans2 = await api("POST", "/memory/answer", { scopeId, question: "我在哪家公司工作过？请说出具体公司名。" });
    console.log(`\n[LLM 旁证 · /memory/answer (大召回 limit≈25)]\n答: ${ans2.answer}`);
    const named2 = (ans2.answer || "").includes(COMPANY);
    console.log(`答复含「${COMPANY}」: ${named2 ? "是 ←/answer 大召回兜住(非运行时路径)" : "否 ★连大召回都丢"}`);
  } catch (e) {
    console.log(`\n[/memory/answer 失败] ${e.message}`);
  }

  head("裁决");
  console.log(`scope: ${scopeId}`);
  console.log("探针 A: 看 A1 ZH 是否「丢失」而 A1 EN「命中」→ 中文分词病");
  console.log("探针 B: 看公司名是否「不在 State 块」→ 本体论压缩病");
  console.log("探针 B2: 简历挤出 recency 后，看运行时 Retrieval 块还有没有公司名 → 本体论压缩的真后果(排除 recency 混淆)");
}

main().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
