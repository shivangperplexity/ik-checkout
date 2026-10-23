/**
 * Review HTTP endpoints (lib/reviews.js has the logic):
 *   GET  /review/<token>       -> /api/review/page?t=   the review page the WhatsApp button opens (mobile first)
 *   POST /api/review/open      { t }                    page really opened in a browser (link previews don't count)
 *   POST /api/review/submit    { t, rating, tags, text, name, consent, keep, photos[{full, thumb, w, h}] }
 *   GET  /api/review/photo?id=&s=t|f[&k=]               JPEG; published reviews' photos are public, others need k
 *   GET  /api/review/list?limit=&offset=&photos=1       published reviews + overall rating (website, CORS *)
 */
import { createHmac } from 'node:crypto';
import { askByToken, submitReview, reviewForToken, publicList, displayName, TAGS_GOOD, TAGS_BAD, reviewCfg } from './reviews.js';
import { logoSvg } from './brand-logo.js';

const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const secret = (env) => String(env.WA_LINK_SECRET || env.ADMIN_TOKEN || env.CRON_SECRET || 'ik-reviews');
/** Signature that lets the dashboard / the reviewer see photos of reviews not on the website. */
export const photoSig = (env, id) => createHmac('sha256', secret(env)).update('rp:' + id).digest('hex').slice(0, 16);

export async function handleReview(req, env) {
  const url = new URL(req.url);
  const op = url.pathname.split('/').pop();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' } });

  if (op === 'list') {
    const r = await publicList(env, { limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset'), photos: url.searchParams.get('photos') === '1' });
    const base = String(env.WORKER_URL || url.origin).replace(/\/$/, '');
    for (const rv of r.reviews) rv.photos = rv.photos.map((p) => ({ ...p, thumb: `${base}/api/review/photo?id=${p.id}&s=t`, full: `${base}/api/review/photo?id=${p.id}&s=f` }));
    return json(r, 200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600' });
  }

  if (op === 'photo') {
    const id = Number(url.searchParams.get('id'));
    if (!id) return new Response('not found', { status: 404 });
    const p = await env.DB.prepare(`SELECT p.full_b64, p.thumb_b64, r.status, r.consent, r.test FROM review_photos p JOIN reviews r ON r.id=p.review_id WHERE p.id=?`).bind(id).first();
    if (!p) return new Response('not found', { status: 404 });
    const open = p.status === 'published' && p.consent && !p.test;
    if (!open && url.searchParams.get('k') !== photoSig(env, id)) return new Response('not found', { status: 404 });
    const body = Buffer.from(url.searchParams.get('s') === 'f' ? p.full_b64 : p.thumb_b64, 'base64');
    return new Response(body, { headers: { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': open ? 'public, max-age=31536000, immutable' : 'private, max-age=3600' } });
  }

  if (op === 'open' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const ask = await askByToken(env, b.t);
    if (ask && !ask.opened_at) await env.DB.prepare('UPDATE review_asks SET opened_at=? WHERE token=?').bind(now(), ask.token).run();
    return json({ ok: true });
  }

  if (op === 'submit' && req.method === 'POST') {
    let b;
    try { b = await req.json(); } catch { return json({ ok: false, error: 'Could not read the review. Please try again.' }, 400); }
    const r = await submitReview(env, String(b.t || ''), b, await reviewCfg(env));
    if (r.ok) console.log('review', r.id, 'stars', r.rating);
    return json(r, r.ok ? 200 : 400);
  }

  if (op === 'page') {
    const token = String(url.searchParams.get('t') || '');
    const ask = await askByToken(env, token);
    const store = String(env.STORE_URL || 'https://www.inkkulture.in').replace(/\/$/, '');
    if (!ask) return page(gonePage(store), 404);
    const prev = await reviewForToken(env, token);
    if (prev) prev.photos = prev.photos.map((id) => ({ id, src: `/api/review/photo?id=${id}&s=t&k=${photoSig(env, id)}` }));
    const data = {
      t: token, first: displayName(ask.first_name).split(' ')[0] === 'Ink' ? '' : displayName(ask.first_name).split(' ')[0],
      order: ask.order_name, items: ask.items || '', name: displayName(ask.first_name, ask.last_name), store,
      good: TAGS_GOOD, bad: TAGS_BAD, prev,
    };
    return page(reviewPage(data));
  }
  return json({ error: 'not found' }, 404);
}

const page = (html, status = 200) => new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } });

const STYLE = `
:root{--ink:#0a0a0c;--ivory:#ede7dc;--paper:#f7f4ee;--line:#e4ded2;--mut:#6b6670;--star:#f5a623;--red:#b3261e;--ok:#1f7a4d}
*{box-sizing:border-box}html,body{margin:0}body{font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--paper);color:var(--ink);-webkit-font-smoothing:antialiased}
header{background:var(--ink);padding:16px 18px;display:flex;justify-content:center}
main{max-width:520px;margin:0 auto;padding:22px 16px 40px}
h1{font-size:25px;line-height:1.2;margin:4px 0 6px;letter-spacing:-.01em}
.mut{color:var(--mut)}.small{font-size:13.5px}
.order{font-size:13.5px;color:var(--mut);margin:0 0 18px}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px;margin:0 0 14px}
.q{font-weight:650;font-size:15.5px;margin:0 0 10px}
.stars{display:flex;gap:6px;justify-content:space-between;max-width:330px}
.stars button{flex:1;border:0;background:none;padding:2px;cursor:pointer;-webkit-tap-highlight-color:transparent}
.stars svg{width:100%;max-width:52px;height:auto;display:block;margin:0 auto;transition:transform .12s}
.stars button:active svg{transform:scale(.9)}
.stars path{fill:#e3ded3;transition:fill .12s}.stars .on path{fill:var(--star)}
.slabel{margin-top:8px;font-weight:600;min-height:22px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{border:1.5px solid var(--line);background:#fff;border-radius:999px;padding:8px 13px;font:inherit;font-size:14px;cursor:pointer;color:var(--ink)}
.chip.on{background:var(--ink);border-color:var(--ink);color:#fff}
textarea,input[type=text]{width:100%;font:inherit;border:1.5px solid var(--line);border-radius:12px;padding:12px 13px;background:#fff;color:var(--ink);outline:none}
textarea{min-height:110px;resize:vertical}textarea:focus,input[type=text]:focus{border-color:var(--ink)}
.photos{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.ph{position:relative;aspect-ratio:1;border-radius:12px;overflow:hidden;background:var(--ivory)}
.ph img{width:100%;height:100%;object-fit:cover;display:block}
.ph .x{position:absolute;top:4px;right:4px;width:26px;height:26px;border-radius:50%;border:0;background:rgba(10,10,12,.72);color:#fff;font-size:16px;line-height:26px;cursor:pointer;padding:0}
.add{aspect-ratio:1;border:1.5px dashed #c9c2b4;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-size:12.5px;color:var(--mut);cursor:pointer;background:#fff;text-align:center;padding:4px}
.add b{font-size:24px;line-height:1;color:var(--ink);font-weight:400}
.check{display:flex;gap:10px;align-items:flex-start;font-size:14.5px;margin-top:12px;cursor:pointer}
.check input{width:20px;height:20px;margin:1px 0 0;accent-color:var(--ink);flex:none}
.btn{display:block;width:100%;border:0;border-radius:14px;background:var(--ink);color:#fff;font:inherit;font-weight:650;font-size:16.5px;padding:16px;cursor:pointer;text-align:center;text-decoration:none}
.btn[disabled]{opacity:.35;cursor:default}.btn.ghost{background:#fff;color:var(--ink);border:1.5px solid var(--ink)}
.err{color:var(--red);font-size:14px;margin:10px 0 0;min-height:1em}
.hide{display:none!important}
.done{text-align:center;padding:26px 6px}
.done .big{width:64px;height:64px;border-radius:50%;background:var(--ink);color:#fff;font-size:32px;line-height:64px;margin:0 auto 14px}
.done h1{font-size:23px}.done p{margin:6px 0 18px}
.foot{text-align:center;font-size:12.5px;color:var(--mut);margin-top:16px}
`;

const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6L2.5 9.5l6.6-.8z"/></svg>';

function reviewPage(d) {
  const prev = d.prev;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Review your Ink Kulture order</title><meta name="robots" content="noindex"><meta name="theme-color" content="#0a0a0c"><style>${STYLE}</style></head><body>
<header>${logoSvg('#ffffff', 24)}</header>
<main>
<div id="form">
  <p class="mut small" style="margin:0">${d.first ? 'Hi ' + esc(d.first) + ',' : 'Hi,'}</p>
  <h1>How are your Ink Kulture tattoos?</h1>
  <p class="order">${esc(d.order)}${d.items ? ' · ' + esc(d.items) : ''}</p>
  ${prev ? '<p class="small" style="background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:0 0 14px">You already reviewed this order. Change anything below and submit again to update it.</p>' : ''}
  <div class="card">
    <p class="q">Your overall rating</p>
    <div class="stars" id="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">${STAR}</button>`).join('')}</div>
    <div class="slabel" id="slabel"><span class="mut">Tap a star</span></div>
  </div>
  <div class="card hide" id="more">
    <p class="q" id="tq">What stood out?</p>
    <div class="chips" id="chips"></div>
    <p class="q" style="margin-top:18px" id="txq">Tell us more <span class="mut small">(optional)</span></p>
    <textarea id="txt" maxlength="1500" placeholder="How did it look? Where did you wear it? How long did it last?"></textarea>
  </div>
  <div class="card hide" id="pcard">
    <p class="q">Add photos of your tattoo <span class="mut small">(optional, up to 4)</span></p>
    <div class="photos" id="photos"></div>
    <input type="file" id="file" accept="image/*" multiple class="hide">
    <p class="mut small" style="margin:10px 0 0">Photos of the tattoo on your skin may be featured on our website.</p>
  </div>
  <div class="card hide" id="ncard">
    <p class="q">Name shown with your review</p>
    <input type="text" id="name" maxlength="40" value="${esc(prev ? prev.name : d.name)}">
    <label class="check"><input type="checkbox" id="consent" ${prev && !prev.consent ? '' : 'checked'}> <span>Show my review and photos on inkkulture.in</span></label>
  </div>
  <button class="btn" id="go" type="button" disabled>Submit review</button>
  <p class="err" id="err"></p>
  <p class="foot">Only Ink Kulture customers get this link. Your phone number is never shown.</p>
</div>
<div id="thanks" class="done hide">
  <div class="big">&#10003;</div>
  <h1 id="th1">Thank you!</h1>
  <p id="tp" class="mut"></p>
  <a class="btn" id="shop" href="${esc(d.store)}/collections/all-tattoos?utm_source=whatsapp&utm_medium=review&utm_campaign=thanks">Shop new designs</a>
  <p style="margin-top:12px"><a class="btn ghost" href="https://www.instagram.com/inkkulture.in/" rel="noopener">Tag us on Instagram @inkkulture.in</a></p>
</div>
</main>
<script>
(function(){
  var D=${JSON.stringify({ t: d.t, good: d.good, bad: d.bad, prev: d.prev }).replace(/</g, '\\u003c')};
  var $=function(id){return document.getElementById(id)};
  var S={rating:0,tags:{},photos:[],keep:(D.prev&&D.prev.photos||[]).slice(),busy:false};
  var WORDS=['','Not good','Could be better','It was okay','Loved it','Absolutely loved it!'];
  try{fetch('/api/review/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:D.t})})}catch(e){}
  function stars(){[].forEach.call($('stars').children,function(b){b.classList.toggle('on',+b.dataset.n<=S.rating)});
    $('slabel').innerHTML=S.rating?'<b>'+WORDS[S.rating]+'</b>':'<span class="mut">Tap a star</span>'}
  function chips(){var list=S.rating>=4?D.good:S.rating===3?D.good.slice(0,3).concat(D.bad.slice(0,3)):D.bad;
    for(var k in S.tags)if(list.indexOf(k)<0)delete S.tags[k];
    $('tq').textContent=S.rating>=4?'What did you love?':'What went wrong?';
    $('txt').placeholder=S.rating>=4?'How did it look? Where did you wear it? How long did it last?':'Tell us what happened. We read every message and will make it right.';
    $('chips').innerHTML=list.map(function(t){return '<button type="button" class="chip'+(S.tags[t]?' on':'')+'" data-t="'+t.replace(/"/g,'&quot;')+'">'+t+'</button>'}).join('')}
  function photos(){var h='';S.keep.forEach(function(p,i){h+='<div class="ph"><img src="'+p.src+'" alt=""><button class="x" type="button" data-k="'+i+'" aria-label="Remove">&times;</button></div>'});
    S.photos.forEach(function(p,i){h+='<div class="ph"><img src="'+p.thumb+'" alt=""><button class="x" type="button" data-i="'+i+'" aria-label="Remove">&times;</button></div>'});
    if(S.keep.length+S.photos.length<4)h+='<label class="add" for="file"><b>+</b>Add photo</label>';
    $('photos').innerHTML=h}
  function show(){var on=S.rating>0;['more','pcard','ncard'].forEach(function(id){$(id).classList.toggle('hide',!on)});$('go').disabled=!on||S.busy}
  $('stars').onclick=function(e){var b=e.target.closest('button');if(!b)return;S.rating=+b.dataset.n;stars();chips();show()};
  $('chips').onclick=function(e){var b=e.target.closest('.chip');if(!b)return;var t=b.dataset.t;if(S.tags[t])delete S.tags[t];else S.tags[t]=1;b.classList.toggle('on',!!S.tags[t])};
  $('photos').onclick=function(e){var x=e.target.closest('.x');if(!x)return;if(x.dataset.k!==undefined)S.keep.splice(+x.dataset.k,1);else S.photos.splice(+x.dataset.i,1);photos()};
  function load(f){return new Promise(function(ok,no){var u=URL.createObjectURL(f),im=new Image();im.onload=function(){ok(im)};im.onerror=function(){no(new Error('This photo type could not be opened. Please pick a JPG or PNG photo.'))};im.src=u})}
  function shrink(im,max,q){var w=im.naturalWidth,h=im.naturalHeight,k=Math.min(1,max/Math.max(w,h)),c=document.createElement('canvas');c.width=Math.round(w*k);c.height=Math.round(h*k);
    var g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.drawImage(im,0,0,c.width,c.height);return {url:c.toDataURL('image/jpeg',q),w:c.width,h:c.height}}
  $('file').onchange=function(){var files=[].slice.call(this.files||[]);this.value='';$('err').textContent='';
    var room=4-S.keep.length-S.photos.length;files.slice(0,room).reduce(function(p,f){return p.then(function(){return load(f).then(function(im){
      var full=shrink(im,1280,.82),th=shrink(im,480,.78);S.photos.push({full:full.url,thumb:th.url,w:full.w,h:full.h});photos()})})},Promise.resolve())
      .catch(function(e){$('err').textContent=e.message})};
  $('go').onclick=function(){if(!S.rating||S.busy)return;S.busy=true;show();$('go').textContent=S.photos.length?'Uploading photos…':'Sending…';$('err').textContent='';
    fetch('/api/review/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:D.t,rating:S.rating,tags:Object.keys(S.tags),text:$('txt').value,name:$('name').value,consent:$('consent').checked,
      keep:S.keep.map(function(p){return p.id}),photos:S.photos.map(function(p){return {full:p.full,thumb:p.thumb,w:p.w,h:p.h}})})})
    .then(function(r){return r.json()}).then(function(j){if(!j.ok)throw new Error(j.error||'Could not send. Please try again.');
      $('form').classList.add('hide');$('thanks').classList.remove('hide');window.scrollTo(0,0);
      if(S.rating>=4){$('th1').textContent='Thank you! \\u{1F5A4}';$('tp').textContent='Your review helps other people find Ink Kulture. It means a lot to a small brand like ours.'}
      else{$('th1').textContent='Thank you for telling us';$('tp').textContent='We are sorry it was not great. Our team will message you on WhatsApp to make it right.'}})
    .catch(function(e){$('err').textContent=e.message||'Could not send. Please check your internet and try again.'})
    .then(function(){S.busy=false;$('go').textContent='Submit review';show()})};
  if(D.prev){S.rating=D.prev.rating;(D.prev.tags||[]).forEach(function(t){S.tags[t]=1});$('txt').value=D.prev.text||'';stars();chips();show()}
  photos();
})();
</script></body></html>`;
}

function gonePage(store) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ink Kulture</title><meta name="robots" content="noindex"><style>${STYLE}</style></head><body>
<header>${logoSvg('#ffffff', 24)}</header><main><div class="done"><h1>This review link is not valid</h1><p class="mut">It may have been typed wrongly. Open the link from our WhatsApp message again, or message us on WhatsApp.</p>
<a class="btn" href="${esc(store)}">Go to inkkulture.in</a></div></main></body></html>`;
}
