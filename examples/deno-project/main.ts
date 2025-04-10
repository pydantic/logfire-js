Deno.serve({ port: 4242 }, (_req) => {
  return new Response("Hello, World!");
});
