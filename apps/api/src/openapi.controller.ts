import { Controller, Get } from "@nestjs/common";
import { buildOpenApiDocument } from "./openapi";

@Controller()
export class OpenApiController {
  @Get("/openapi.json")
  getOpenApi() {
    return buildOpenApiDocument();
  }
}
