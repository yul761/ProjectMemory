import { Controller, Get, Param, Headers, UnauthorizedException } from "@nestjs/common";
import { MetricsService } from "./metrics.service";

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get("metrics/digest/:scopeId")
  async getDigestMetrics(
    @Param("scopeId") scopeId: string,
    @Headers("x-user-id") userId: string
  ) {
    if (!userId) throw new UnauthorizedException();
    return this.metrics.getDigestMetrics(scopeId);
  }
}
