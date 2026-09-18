/**
 * Vercel serverless entrypoint.
 *
 * Vercel does not run `node server.js` and there is no port to bind: it imports this
 * file and calls the exported handler once per request. server.js therefore exports its
 * handler and only calls listen() when run directly, so `npm start` and Vercel share
 * exactly one implementation.
 *
 * vercel.json rewrites every path here, so this handler sees the full URL space
 * (pages, /api/*, FHIR endpoints) just as the local server does.
 */
module.exports = require('../server.js');
