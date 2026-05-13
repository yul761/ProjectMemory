import { prisma } from "@statecore/db";

export async function clearDatabase() {
  await prisma.reminder.deleteMany();
  await prisma.workingMemorySnapshot.deleteMany();
  await prisma.digestStateSnapshot.deleteMany();
  await prisma.digest.deleteMany();
  await prisma.memoryEvent.deleteMany();
  await prisma.userState.deleteMany();
  await prisma.projectScope.deleteMany();
  await prisma.user.deleteMany();
}
