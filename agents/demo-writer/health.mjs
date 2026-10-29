/* Demo agent health check — the command the platform runs after a deployment (and before one).
 * Exits 0 only when the implementation still behaves as the fixed version should.
 */
import { greet, farewell } from './greet.mjs';

const problems = [];
if (greet('Ada') !== 'Hello, Ada') problems.push(`greet('Ada') returned ${JSON.stringify(greet('Ada'))}`);
if (farewell('Ada') !== 'Goodbye, Ada') problems.push(`farewell('Ada') returned ${JSON.stringify(farewell('Ada'))}`);

if (problems.length) {
  console.log(`UNHEALTHY\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('HEALTHY');
