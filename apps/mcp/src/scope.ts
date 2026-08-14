import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** scope 名 = 归一化项目根路径。STATECORE_SCOPE 覆盖；git 根优先，取不到用 cwd。 */
export function resolveScopeName(cwd: string, env: NodeJS.ProcessEnv): string {
  if (env.STATECORE_SCOPE?.trim()) return env.STATECORE_SCOPE.trim();
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    if (root) return resolve(root);
  } catch { /* 非 git 目录：git 不存在或 rev-parse 失败都落到 cwd,行为一致 */ }
  return resolve(cwd);
}
