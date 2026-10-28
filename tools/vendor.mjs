// Copies the pinned supabase-js browser bundle into site/vendor so the site has
// no CDN dependency. Run with: npm run vendor (after npm install).
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './localdb.mjs';

const pkg = JSON.parse(readFileSync(join(root, 'node_modules/@supabase/supabase-js/package.json'), 'utf8'));
mkdirSync(join(root, 'site/vendor'), { recursive: true });
copyFileSync(join(root, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'), join(root, 'site/vendor/supabase.js'));
console.log(`Copied supabase-js ${pkg.version} to site/vendor/supabase.js`);
