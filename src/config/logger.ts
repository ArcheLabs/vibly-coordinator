import pino from "pino";
import type { CoordinatorConfig } from "./env.js";

export function createLogger(config: CoordinatorConfig) {
  return pino({
    level: config.logLevel,
    transport:
      config.nodeEnv !== "production"
        ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
        : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
