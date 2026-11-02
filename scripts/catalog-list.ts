/** Print the loaded catalog: toolkit, source, auth schemes, tool count. `npm run catalog:list [-- --tools]` */
import { Registry } from '../src/catalog/registry.js';

const showTools = process.argv.includes('--tools');
const registry = Registry.default();
let total = 0;
for (const tk of registry.listToolkits()) {
  total += tk.tools.length;
  const schemes = tk.authSchemes.map((s) => (s.oauth2 ? `OAUTH2(${s.oauth2.provider})` : s.type)).join(', ');
  console.log(
    `${tk.slug.padEnd(24)} ${tk.source.padEnd(12)} ${String(tk.tools.length).padStart(4)} tools  ${schemes}`,
  );
  if (showTools) for (const t of tk.tools) console.log(`    ${t.slug}  —  ${t.displayName}`);
}
console.log(`\n${registry.listToolkits().length} toolkits, ${total} tools`);
