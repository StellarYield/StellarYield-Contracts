import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { SimpleSpanProcessor, NoopSpanProcessor } from "@opentelemetry/sdk-trace-node";

const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];

const spanProcessor = endpoint
  ? new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))
  : new NoopSpanProcessor();

const sdk = new NodeSDK({
  serviceName: "stellaryield-backend",
  spanProcessors: [spanProcessor],
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

process.on("SIGTERM", () => {
  void sdk.shutdown();
});
