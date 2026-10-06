// Vercel's entry point: the same Express app src/index.ts serves with listen(), exported as a handler.
// Migrations are not run here (cold starts would race); apply them with `npm run migrate`.
//
// TEMPORARY diagnostics: if the app fails to load (bad env, missing module), answer with the reason
// instead of an opaque FUNCTION_INVOCATION_FAILED. Remove once the deploy is healthy.
let app;
let loadError;
try {
  const { createApp } = await import('../dist/app.js');
  app = createApp();
} catch (error) {
  loadError = error;
  console.error('Failed to load app', error);
}

export default (req, res) => {
  if (app) return app(req, res);
  res.statusCode = 500;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: 'app_failed_to_load', name: loadError?.name, message: String(loadError?.message ?? loadError) }));
};
