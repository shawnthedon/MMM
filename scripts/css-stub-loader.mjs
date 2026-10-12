/* ESM loader hook: stub CSS imports so app modules load under Node (tests). */
export async function load(url, context, next) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  return next(url, context);
}
