import { registerOTel, OTLPHttpJsonTraceExporter } from '@vercel/otel';
import { LogfireVercelAISpanProcessor } from '@pydantic/logfire-vercel-ai-span-processor';

export function register() {   
    registerOTel({
      serviceName: 'logfire-vercel-ai-app',
      autoDetectResources: true,
      spanProcessors: [new LogfireVercelAISpanProcessor()],
    });
}  
