import start from './tracer';
import express from 'express';
import axios from 'axios';
import opentelemetry from "@opentelemetry/api";
import Redis from "ioredis";
import { api } from '@opentelemetry/sdk-node';
import { SpanStatusCode } from '@opentelemetry/api'; // Import for SpanStatusCode

const app = express();
const redis = new Redis({ host: 'redis' });

// ✅ Initialize OpenTelemetry
const { meter, trackHttpRequest, trackRedisCall, trackError } = start('todo-service');

// ✅ Track HTTP Requests
app.use((req, res, next) => {
    const startTime = Date.now();
    res.on('finish', () => {
        trackHttpRequest(Date.now() - startTime, req.route?.path, res.statusCode, req.method);
    });
    next();
});

// ✅ Track Errors
app.use((err: any, req: any, res: any, next: any) => {
    if (err) {
        trackError(req.method, req.route?.path);
        next(err);
    }
});

// ✅ Simulate Delay
const sleep = (time: number) => new Promise(resolve => setTimeout(resolve, time));

// ✅ Helper function to track internal API calls
async function trackInternalApiCall(url: string, method: string, baggage: any) {
    const tracer = opentelemetry.trace.getTracer('internal-api-calls');
    const span = tracer.startSpan(`Internal API Call: ${url}`);

    try {
        // Inject trace context (traceparent, baggage) into headers
        const headers = {};
        opentelemetry.propagation.inject(opentelemetry.context.active(), headers);

        // Make the internal API request
        const response = await axios({
            method,
            url,
            headers,
        });

        // Record status and attributes for the span
        span.setAttribute('http.status_code', response.status);
        span.setAttribute('http.method', method);
        span.setAttribute('http.url', url);
        return response;
    } catch (error: unknown) {
        // Capture error details in the span
        if (error instanceof Error) {
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        }
        throw error;
    } finally {
        span.end();
    }
}

// ✅ Main GET handler for /todos route
app.get('/todos', async (req, res) => {
    // ✅ Add OpenTelemetry Baggage
    const baggage = opentelemetry.propagation.createBaggage({
        "user.plan": { value: "enterprise" }
    });
    const contextWithBaggage = opentelemetry.propagation.setBaggage(opentelemetry.context.active(), baggage);

    opentelemetry.context.with(contextWithBaggage, async () => {
        try {
            // ✅ Track internal API call to 'auth' service
            const userResponse = await trackInternalApiCall('http://auth:8080/auth', 'GET', baggage);

            // Track Redis calls (as before)
            const startRedisTime = Date.now(); // Define this variable here
            const todoKeys = await redis.keys('todo:*');
            trackRedisCall(Date.now() - startRedisTime, 'keys');

            const todos: any[] = [];
            for (let key of todoKeys) {
                const startItemTime = Date.now();
                const todoItem = await redis.get(key);
                trackRedisCall(Date.now() - startItemTime, 'get');
                if (todoItem) todos.push(JSON.parse(todoItem));
            }

            // Simulate slow response if `slow` query parameter is passed
            if (req.query['slow']) await sleep(5000);

            // Handle failure simulation if `fail` query parameter is passed
            if (req.query['fail']) {
                try {
                    throw new Error('Really bad error!');
                } catch (e: unknown) {
                    if (e instanceof Error) {
                        const activeSpan = api.trace.getSpan(api.context.active());
                        activeSpan?.recordException(e);
                        console.error('Error occurred:', { spanId: activeSpan?.spanContext().spanId });
                        res.sendStatus(500);
                        return;
                    }
                }
            }

            // Return the list of todos and user data
            res.json({ todos, user: userResponse.data });
        } catch (error) {
            // Handle errors from internal API calls
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });
});

// Start the Express server
app.listen(8080, () => {
    console.log('Service is up and running!');
});

// ✅ Initialize Redis Data
async function init() {
    const tracer = opentelemetry.trace.getTracer('init');
    tracer.startActiveSpan('Set default items', async (span) => {
        await Promise.all([
            redis.set('todo:1', JSON.stringify({ name: 'Install OpenTelemetry SDK' })),
            redis.set('todo:2', JSON.stringify({ name: 'Deploy OpenTelemetry Collector' })),
            redis.set('todo:3', JSON.stringify({ name: 'Configure sampling rule' })),
            redis.set('todo:4', JSON.stringify({ name: 'OpenTelemetry master!' }))
        ]);
        span.end();
    });
}
init();
