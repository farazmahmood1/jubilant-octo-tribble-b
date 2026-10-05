// Vercel's entry point: the same Express app src/index.ts serves with listen(), exported as a handler.
// Migrations are not run here (cold starts would race); apply them with `npm run migrate`.
import { createApp } from '../dist/app.js';

export default createApp();
