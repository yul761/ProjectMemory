import { runAllScenarios } from "./runner";
import { scenarios } from "./scenarios";

async function main() {
  const results = await runAllScenarios(scenarios);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
