import { MiddlewareConsumer, Module } from "@nestjs/common";
import { authMiddleware } from "./auth.middleware";
import { DomainService } from "./domain.service";
import { HealthController } from "./health.controller";
import { ScopesController } from "./scopes.controller";
import { MemoryController } from "./memory.controller";
import { RemindersController } from "./reminders.controller";

@Module({
  controllers: [HealthController, ScopesController, MemoryController, RemindersController],
  providers: [DomainService]
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(authMiddleware).forRoutes("*");
  }
}
