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
import * as logfire from '@pydantic/logfire-api';
import { instrumentTail } from '@pydantic/logfire-cf-workers';

const handler = {
	async fetch(): Promise<Response> {
		logfire.info('span1');
		await fetch('https://example.com/1');
		logfire.info('span2');
		await fetch('https://example.com/2');
		// await new Promise((resolve) => setTimeout(resolve, 100));
		return new Response('Hello World!');
	},
} satisfies ExportedHandler;

export default instrumentTail(handler, {
	service: {
		name: 'cloudflare-worker',
		namespace: '',
		version: '1.0.0',
	},
});
