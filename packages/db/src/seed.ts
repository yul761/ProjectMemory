import { prisma } from "./index";

async function main() {
  const user = await prisma.user.upsert({
    where: { identity: "seed:local" },
    update: {},
    create: { identity: "seed:local" }
  });

  const scope = await prisma.projectScope.create({
    data: {
      userId: user.id,
      name: "Demo Scope",
      goal: "Ship the long-term memory engine",
      stage: "build"
    }
  });

  await prisma.userState.upsert({
    where: { userId: user.id },
    update: { activeProjectId: scope.id },
    create: { userId: user.id, activeProjectId: scope.id }
  });

  await prisma.memoryEvent.create({
    data: {
      userId: user.id,
      scopeId: scope.id,
      type: "stream",
      source: "api",
      content: "Seeded demo scope and initial memory event."
    }
  });

  // eslint-disable-next-line no-console
  console.log("Seeded user:", user.id, "scope:", scope.id);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
