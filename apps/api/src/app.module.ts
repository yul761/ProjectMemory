import { MiddlewareConsumer, Module } from "@nestjs/common";
import { authMiddleware } from "./auth.middleware";
import { DomainService } from "./domain.service";
import { HealthController } from "./health.controller";
import { OpenApiController } from "./openapi.controller";
import { ScopesController } from "./scopes.controller";
import { MemoryController } from "./memory.controller";
import { RemindersController } from "./reminders.controller";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";
import { MemoryFactsService } from "./memory-facts.service";

@Module({
  controllers: [HealthController, OpenApiController, ScopesController, MemoryController, RemindersController, MetricsController],
  providers: [DomainService, MetricsService, MemoryFactsService]
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(authMiddleware).forRoutes("*");
  }
}
