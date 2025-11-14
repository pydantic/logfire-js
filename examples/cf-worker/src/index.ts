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
import * as logfire from 'logfire';
import { instrument } from '@pydantic/logfire-cf-workers';

const handler = {
	async fetch(): Promise<Response> {
		logfire.info('span from inside the worker body', { foo: 'bar' });
		return new Response('Hello World!');
	},
} satisfies ExportedHandler;

export default instrument(handler, {
	service: {
		name: 'cloudflare-worker',
		namespace: '',
		version: '1.0.0',
	},
	console: true,
});
