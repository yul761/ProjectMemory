import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { logger } from "@statecore/core";

@Catch()
export class GlobalErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    if (exception instanceof ZodError) {
      res.status(400).json({ error: "Validation failed", details: exception.issues });
      return;
    }
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json({ error: exception.message });
      return;
    }
    logger.error({ err: exception }, "Unhandled exception");
    res.status(500).json({ error: "Internal server error" });
  }
}
