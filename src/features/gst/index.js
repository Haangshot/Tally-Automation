/**
 * Feature module: gst.
 *
 * GST return preparation (GSTR-1, GSTR-3B), GSTR-2B reconciliation, and
 * e-invoice / e-way bill JSON, all computed from the books because TallyPrime
 * does not expose its GSTR reports over XML. Every output is a draft: nothing
 * here files or submits anything to the GST portal, the IRP or the e-way bill
 * system.
 */
export { tools } from './tools.js';
export { registerRoutes } from './routes.js';
