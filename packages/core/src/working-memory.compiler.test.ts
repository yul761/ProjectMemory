import { describe, expect, it } from "vitest";
import { compileStateLayerView, formatStateLayerView } from "./working-memory.compiler";

describe("formatStateLayerView — profile sections", () => {
  it("renders identity facts under '你是谁/档案:'", () => {
    const view = compileStateLayerView({
      profile: {
        identity: ["工作经历: 字节跳动 后端工程师 2019-2022", "教育: 北京大学 计算机科学 2015-2019"]
      }
    });
    const text = formatStateLayerView(view);
    expect(text).toContain("你是谁/档案:");
    expect(text).toContain("- 工作经历: 字节跳动 后端工程师 2019-2022");
    expect(text).toContain("- 教育: 北京大学 计算机科学 2015-2019");
  });

  it("project-template non-regression: 6 PM slots present, no profile sections", () => {
    const view = compileStateLayerView({
      stableFacts: {
        goal: "ship API",
        constraints: ["keep stable"],
        decisions: ["use postgres"]
      },
      todos: ["write docs"],
      workingNotes: {
        openQuestions: ["timeline?"],
        risks: ["vendor lock"]
      }
    });
    const text = formatStateLayerView(view);
    expect(text).toContain("Stable goal: ship API");
    expect(text).toContain("Stable constraints:");
    expect(text).toContain("Stable decisions:");
    expect(text).toContain("Durable todos:");
    expect(text).toContain("Open questions:");
    expect(text).toContain("Risks:");
    expect(text).not.toContain("你是谁");
    expect(text).not.toContain("人际");
    expect(text).not.toContain("正在经历");
    expect(text).not.toContain("目标");
    expect(text).not.toContain("待跟进");
  });

  it("empty identity array produces no section (pushSection guard)", () => {
    const view = compileStateLayerView({
      profile: { identity: [] }
    });
    const text = formatStateLayerView(view);
    expect(text).not.toContain("你是谁");
  });
});
