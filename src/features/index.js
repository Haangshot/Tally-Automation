/**
 * Feature modules added on top of the original brief.
 *
 * Each module owns its own files and contributes two things:
 *
 *   tools           — entries in the same shape as TOOLS in agent/tools.js.
 *                     They join the model's allowlist and are held to exactly
 *                     the same rules (no write-shaped names, strict schemas,
 *                     Zod re-validation). Anything that changes Tally must go
 *                     through ActionService.stage* and wait for a human.
 *   registerRoutes  — HTTP endpoints, mounted before the 404 handler.
 *
 * None of them builds Tally Import XML. That stays in src/tally/writes.js.
 */
import * as gst from './gst/index.js';
import * as print from './print/index.js';
import * as payroll from './payroll/index.js';
import * as controls from './controls/index.js';
import * as operations from './operations/index.js';

export const FEATURE_MODULES = Object.freeze({ gst, print, payroll, controls, operations });

export const FEATURE_TOOLS = Object.freeze(
  Object.values(FEATURE_MODULES).flatMap((m) => m.tools ?? []),
);

/**
 * Mount every module's routes.
 *
 * `ctx` carries what a route needs and nothing it should build for itself:
 *   reader, actions (ActionService), wrap(handler), callerOf(req),
 *   requireRole(req, res, role) -> boolean, statementUpload / upload (multer).
 */
export function registerFeatureRoutes(app, ctx) {
  for (const m of Object.values(FEATURE_MODULES)) m.registerRoutes?.(app, ctx);
}
