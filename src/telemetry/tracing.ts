import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { CoordinatorConfig } from "../config/env.js";

export function startTracingIfConfigured(config: CoordinatorConfig): NodeSDK | undefined {
  if (!config.otelExporterOtlpEndpoint) return undefined;
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: `${config.otelExporterOtlpEndpoint.replace(/\/$/, "")}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  sdk.start();
  return sdk;
}
