#!/usr/bin/env node
/** Generate a server auth token. Printed once; put it in .env yourself. */
import { generateToken, MIN_TOKEN_LENGTH } from '../src/ops/auth.js';

const token = generateToken();
console.log(`
Add this to .env:

  APP_AUTH_TOKEN=${token}

With a token set, the server may bind to a network address, and every request
must send:

  Authorization: Bearer ${token}

Keep it secret: it authorises posting entries to your books. Anything shorter
than ${MIN_TOKEN_LENGTH} characters is refused.
`);
