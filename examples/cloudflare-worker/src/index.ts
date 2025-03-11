/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import { instrument, ResolveConfigFn } from '@microlabs/otel-cf-workers';
import { tracerConfig } from '@pydantic/logfire-cf-workers';
import * as logfire from '@pydantic/logfire-api';

export interface Env {
	LOGFIRE_TOKEN: string;
	LOGFIRE_BASE_URL: string;
	OTEL_TEST: KVNamespace;
}

const handler = {
	async fetch(): Promise<Response> {
		logfire.info('info span from inside the worker body');
		return new Response('Hello World!');
	},
} satisfies ExportedHandler<Env>;

const config: ResolveConfigFn = (env: Env, _trigger) => {
	return {
		service: { name: 'cloudflare-worker', namespace: '', version: '1.0.0' },
		...tracerConfig(env),
	};
};

export default instrument(handler, config);
