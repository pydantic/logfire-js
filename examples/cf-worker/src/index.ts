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
import { DurableObject } from 'cloudflare:workers';
import * as logfire from 'logfire';
import { instrument, instrumentDO } from '@pydantic/logfire-cf-workers';

interface Env {
	COUNTER: DurableObjectNamespace<CounterDurableObject>;
}

const config = {
	service: {
		name: 'cloudflare-worker',
		namespace: '',
		version: '1.0.0',
	},
	console: true,
};

class CounterDurableObject extends DurableObject<Env> {
	async increment(): Promise<number> {
		const value = ((await this.ctx.storage.get<number>('value')) ?? 0) + 1;
		await this.ctx.storage.put('value', value);
		logfire.info('counter incremented to {value}', { value });
		return value;
	}
}

export const Counter = instrumentDO(CounterDurableObject, config);

const handler = {
	async fetch(_request, env): Promise<Response> {
		logfire.info('span from inside the worker body', { foo: 'bar' });
		const value = await env.COUNTER.getByName('global').increment();
		return new Response(`Hello World! Counter: ${value}`);
	},
} satisfies ExportedHandler<Env>;

export default instrument(handler, config);
