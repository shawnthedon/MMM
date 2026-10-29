/* Demo agent — a tiny implementation with a real, reproducible defect.
 *
 * The shipped behaviour is `hi Ada`; the module's own test expects `Hello, Ada`. That mismatch is
 * deliberate: it is the defect the Agent Self-Improvement tests (npm run test:evolution) reproduce,
 * diagnose, fix in an isolated candidate, test, review, compare and deploy.
 *
 * Nothing else in MMM imports this file — it exists so the improvement cycle has something honest to
 * work on, and so the UI has a real agent implementation to show.
 */
export function greet(name = 'world') {
  return `hi ${name}`;
}

export function farewell(name = 'world') {
  return `bye ${name}`;
}
