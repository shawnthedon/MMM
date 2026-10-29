/* Demo agent tests — run with: node greet.test.mjs (inside the agent's candidate workspace).
 * Exits non-zero when the implementation does not match, so a failing run is visible to the sandbox
 * and cannot be mistaken for a pass.
 */
import { greet, farewell } from './greet.mjs';

let failures = 0;
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`PASS ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

check('greets by name', greet('Ada'), 'Hello, Ada');
check('greets the world by default', greet(), 'Hello, world');
check('says goodbye', farewell('Ada'), 'Goodbye, Ada');

console.log(failures ? `${failures} failing` : 'all passing');
process.exit(failures ? 1 : 0);
