import { registerOTel } from "@vercel/otel";

export function register() {
  registerOTel({ serviceName: "sample-project" });
}
// NOTE: You can replace `your-project-name` with the actual name of your project
