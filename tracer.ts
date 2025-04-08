import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { ParentBasedSampler } from '@opentelemetry/sdk-trace-base';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OurSampler } from './ourSampler';
import { W3CBaggagePropagator, W3CTraceContextPropagator, CompositePropagator } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { metrics } from '@opentelemetry/api';
import pyroscope from "@pyroscope/nodejs";

function start(serviceName: string) {
    const resource = new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        'team.owner': 'Ashish',
        'deployment': '4',
    });

    // ✅ Initialize Pyroscope
    pyroscope.init({
        appName: "todo-app",
        serverAddress: "http://pyroscope:4040",
    });

    // ✅ Start Pyroscope Globally
    pyroscope.start();

    // ✅ Prometheus Exporter
    const prometheusExporter = new PrometheusExporter(
        { port: 9494 },
        () => console.log(`Prometheus scrape endpoint: http://localhost:9494/metrics`)
    );

    // ✅ OTLP Metrics Exporter
    const metricExporter = new OTLPMetricExporter({
        url: 'http://collector:4318/v1/metrics',
    });

    // ✅ Metric Reader Setup
    const metricReader = new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60000,
        exportTimeoutMillis: 30000,
    });

    const meterProvider = new MeterProvider({ resource });
    meterProvider.addMetricReader(metricReader);
    meterProvider.addMetricReader(prometheusExporter);
    metrics.setGlobalMeterProvider(meterProvider);
    const meter = meterProvider.getMeter(serviceName);

    const httpCalls = meter.createHistogram('http_calls', { description: 'Tracks HTTP request duration' });
    const redisCalls = meter.createHistogram('redis_calls', { description: 'Tracks Redis call duration' });
    const errorCount = meter.createCounter('error_count', { description: 'Counts application errors' });
    const spanDuration = meter.createHistogram('span_duration_seconds', { description: 'Tracks span duration in seconds' });
    const spanErrorCount = meter.createCounter('span_error_count', { description: 'Counts the number of errors in spans' });

    function trackHttpRequest(duration: number, route?: string, status?: number, method?: string) {
        httpCalls.record(duration, { route, status, method });
    }

    function trackRedisCall(duration: number, operation: string) {
        redisCalls.record(duration, { operation });
    }

    function trackError(method?: string, route?: string) {
        errorCount.add(1, { method, route });
    }

    function trackSpanDuration(spanName: string, duration: number) {
        spanDuration.record(duration, { span_name: spanName });
    }

    function trackSpanError(spanName: string, error: Error) {
        spanErrorCount.add(1, { span_name: spanName, error_message: error.message });
    }

    const traceExporter = new OTLPTraceExporter({ url: 'http://collector:4318/v1/traces' });
    const spanProcessor = new BatchSpanProcessor(traceExporter);

    const sdk = new NodeSDK({
        resource,
        instrumentations: [
            getNodeAutoInstrumentations({
                "@opentelemetry/instrumentation-fs": { enabled: true },
                "@opentelemetry/instrumentation-http": {
                    headersToSpanAttributes: {
                        client: { requestHeaders: ['tracestate', 'traceparent', 'baggage'] },
                        server: { requestHeaders: ['tracestate', 'traceparent', 'baggage'] },
                    },
                },
                "@opentelemetry/instrumentation-express": { enabled: true },
            }),
        ],
        traceExporter,
        spanProcessors: [spanProcessor],
        autoDetectResources: true,
        sampler: new ParentBasedSampler({ root: new OurSampler() }),
        textMapPropagator: new CompositePropagator({
            propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
        }),
    });

    try {
        sdk.start();
        console.log('OpenTelemetry SDK started successfully');
    } catch (error) {
        console.error('Error starting OpenTelemetry SDK:', error);
    }

    // ✅ Stop Pyroscope on App Shutdown
    process.on('SIGINT', () => {
        console.log('Shutting down Pyroscope...');
        pyroscope.stop();
        process.exit(0);
    });

    return { meter, trackHttpRequest, trackRedisCall, trackError, trackSpanDuration, trackSpanError };
}

export default start;
