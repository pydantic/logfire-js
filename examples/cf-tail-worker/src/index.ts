import { exportTailEventsToLogfire } from '@pydantic/logfire-cf-workers';

export interface Env {
	[key: string]: string;
}

export default {
	async tail(events, env) {
		await exportTailEventsToLogfire(events, env);
	},
} satisfies ExportedHandler<Env>;
