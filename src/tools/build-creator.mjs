/* public/creator.html = tools/creator.tpl.html with the Ink Kulture wordmark inlined. Run: node tools/build-creator.mjs */
import fs from 'node:fs';
import { logoSvg } from '../lib/brand-logo.js';
const here = new URL('.', import.meta.url);
const t = fs.readFileSync(new URL('creator.tpl.html', here), 'utf8');
fs.writeFileSync(new URL('../public/creator.html', here), t.replace('__LOGO__', logoSvg('#0a0a0c', 20)));

const r = fs.readFileSync(new URL('refer.tpl.html', here), 'utf8');
fs.writeFileSync(new URL('../public/refer.html', here), r.replace('__LOGO__', logoSvg('#0a0a0c', 20)));
