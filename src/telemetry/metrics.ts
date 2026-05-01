import { collectDefaultMetrics, Registry } from "prom-client";

export const metricsRegister = new Registry();
collectDefaultMetrics({ register: metricsRegister });
