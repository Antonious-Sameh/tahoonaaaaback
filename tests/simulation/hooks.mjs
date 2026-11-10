/* eslint-disable */
const here = new URL('.', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === 'mongoose') return { url: here + 'shim-mongoose.js', shortCircuit: true };
  if (/\/config\/(logger|env)\.js$/.test(specifier)) return { url: here + 'stub-config.js', shortCircuit: true };
  const m = specifier.match(/\/models\/([A-Za-z]+)\.js$/);
  if (m && !['constants', 'index'].includes(m[1])) return { url: `${here}fake-model-entry.js?m=${m[1]}`, shortCircuit: true };
  return next(specifier, context);
}
