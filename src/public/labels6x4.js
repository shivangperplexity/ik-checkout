/* Join shipping-label PDFs into ONE PDF with one 6 x 4 inch page per label. Runs in the browser (needs pdf-lib.min.js first).
   Each label's first page is scaled to fit (never stretched) and centred. A landscape label gets a 6 wide x 4 tall page,
   a portrait label a 4 wide x 6 tall page, so nothing is rotated and the label fills the page. Any number of labels works.

   Brand logo: Shiprocket prints the account logo as a small photo stretched into a wide box (top right, next to "Ship To"),
   which looks blurry and squashed. Each label is scanned for that picture (a colour/grey image drawn in the top-right area;
   barcodes are 1-bit images and are never touched), the box is painted white and the Ink Kulture store logo is drawn there
   as sharp vector art at its true proportions. If no such picture is found the label is left exactly as Shiprocket made it. */
(function (root) {
  var PT = 72, LONG = 6 * PT, SHORT = 4 * PT;

  /* Ink Kulture logo, from the store theme (assets/ikl-logo-black.svg). Artwork bounds inside its 4096 x 971 canvas: */
  var LOGO_BOX = { x: 56, y: 56, w: 3983, h: 858 };
  var LOGO = 'M 4039 154 L 3772 153 L 3666 375 L 3546 609 L 3546 617 L 3834 615 L 3881 522 L 3725 522 L 3723 518 L 3762 441 L 3881 441 L 3926 360 L 3930 346 L 3813 344 L 3861 251 L 3991 251 Z M 3688 177 L 3674 162 L 3646 153 L 3403 153 L 3162 616 L 3291 617 L 3383 446 L 3379 617 L 3505 617 L 3505 442 L 3554 434 L 3589 413 L 3604 395 L 3693 224 L 3698 203 Z M 3544 255 L 3544 259 L 3541 261 L 3539 269 L 3536 271 L 3532 283 L 3529 285 L 3529 288 L 3522 297 L 3522 300 L 3520 301 L 3520 304 L 3515 311 L 3515 314 L 3513 315 L 3513 318 L 3510 321 L 3511 322 L 3508 325 L 3506 332 L 3501 337 L 3501 340 L 3498 343 L 3490 343 L 3487 346 L 3436 346 L 3434 344 L 3434 342 L 3437 339 L 3437 336 L 3439 335 L 3441 327 L 3444 325 L 3444 322 L 3448 319 L 3448 316 L 3451 313 L 3451 310 L 3453 309 L 3453 306 L 3455 305 L 3455 302 L 3458 299 L 3458 296 L 3460 295 L 3460 292 L 3463 289 L 3462 288 L 3465 285 L 3467 278 L 3472 274 L 3474 266 L 3477 264 L 3477 261 L 3479 260 L 3482 251 L 3486 251 L 3487 253 L 3509 253 L 3511 251 L 3540 251 Z M 3350 154 L 3222 153 L 3038 504 L 3010 520 L 2959 520 L 2955 515 L 3143 161 L 3143 153 L 3012 153 L 2807 549 L 2805 577 L 2817 603 L 2853 620 L 3070 617 L 3114 594 L 3138 568 Z M 2969 153 L 2659 154 L 2612 240 L 2610 250 L 2703 251 L 2704 255 L 2525 595 L 2518 617 L 2649 615 L 2838 251 L 2921 251 L 2969 163 Z M 2562 153 L 2429 153 L 2424 158 L 2415 182 L 2335 336 L 2335 342 L 2196 609 L 2196 617 L 2468 615 L 2515 528 L 2515 522 L 2378 522 L 2376 518 L 2562 161 Z M 2376 153 L 2246 153 L 2064 507 L 2044 520 L 1985 520 L 1983 511 L 2167 161 L 2167 153 L 2036 153 L 1841 536 L 1834 579 L 1843 600 L 1884 620 L 2096 617 L 2146 591 L 2167 565 Z M 988 153 L 771 617 L 907 617 L 992 439 L 1025 617 L 1233 617 L 1233 611 L 1170 558 L 1135 379 L 1371 171 L 1384 153 L 1228 153 L 1048 324 L 1045 320 L 1123 163 L 1123 153 Z M 933 154 L 800 153 L 699 367 L 674 158 L 669 153 L 534 153 L 324 598 L 320 617 L 453 617 L 555 401 L 588 617 L 711 617 Z M 1541 56 L 1575 116 L 1326 617 L 1480 617 L 1584 415 L 1613 593 L 2051 914 L 1767 539 L 1729 380 L 2092 57 L 1913 56 L 1643 296 L 1756 58 Z M 522 56 L 270 57 L 270 62 L 313 113 L 303 145 L 122 554 L 100 578 L 56 612 L 57 617 L 295 617 L 295 611 L 269 577 L 269 553 L 432 196 L 462 118 L 523 62 Z';

  function mul(m, n) { // m then n (PDF order: point * m * n)
    return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  }
  function unitBox(m) {
    var xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]], ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
    var x = Math.min.apply(null, xs), y = Math.min.apply(null, ys);
    return { x: x, y: y, w: Math.max.apply(null, xs) - x, h: Math.max.apply(null, ys) - y };
  }
  function streamText(P, s) {
    try {
      var bytes = s instanceof P.PDFRawStream ? P.decodePDFRawStream(s).decode() : (s.getContents ? s.getContents() : null);
      if (!bytes) return '';
      var out = ''; for (var i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      return out;
    } catch (e) { return ''; }
  }
  function num(P, ctx, v) { v = ctx.lookup(v); return v instanceof P.PDFNumber ? v.asNumber() : null; }

  /* Every image the page draws, with its box in page coordinates (follows nested forms, q/Q and cm). */
  function drawnImages(P, ctx, content, resources, ctm, depth, out) {
    var xo = resources && resources.lookupMaybe(P.PDFName.of('XObject'), P.PDFDict);
    var stack = [], ops = [], t = content.replace(/\((?:\\.|[^\\)])*\)/g, ' ').split(/[\s\[\]<>]+/), inImg = false;
    for (var i = 0; i < t.length; i++) {
      var w = t[i]; if (!w) continue;
      if (inImg) { if (w === 'EI') inImg = false; continue; }
      if (w === 'BI') { inImg = true; ops = []; continue; }
      if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(w)) { ops.push(+w); continue; }
      if (w.charAt(0) === '/') { ops.push(w); continue; }
      if (w === 'q') stack.push(ctm);
      else if (w === 'Q') ctm = stack.length ? stack.pop() : ctm;
      else if (w === 'cm' && ops.length >= 6 && ops.slice(-6).every(function (x) { return typeof x === 'number'; })) ctm = mul(ops.slice(-6), ctm);
      else if (w === 'Do' && xo && typeof ops[ops.length - 1] === 'string') {
        var ref = xo.get(P.PDFName.of(ops[ops.length - 1].slice(1))), obj = ctx.lookup(ref);
        if (obj && obj.dict) {
          var d = obj.dict, sub = d.get(P.PDFName.of('Subtype'));
          if (sub && sub.toString() === '/Image') {
            var mask = d.get(P.PDFName.of('ImageMask')), bpc = num(P, ctx, d.get(P.PDFName.of('BitsPerComponent')));
            out.push({ box: unitBox(ctm), bpc: bpc, mask: !!(mask && mask.toString() === 'true') });
          } else if (sub && sub.toString() === '/Form' && depth < 4) {
            var fm = d.lookupMaybe(P.PDFName.of('Matrix'), P.PDFArray), m = [1, 0, 0, 1, 0, 0];
            if (fm && fm.size() === 6) m = fm.asArray().map(function (v) { return num(P, ctx, v) || 0; });
            drawnImages(P, ctx, streamText(P, obj), d.lookupMaybe(P.PDFName.of('Resources'), P.PDFDict) || resources, mul(m, ctm), depth + 1, out);
          }
        }
      }
      ops = [];
    }
    return out;
  }

  /* The Shiprocket brand-logo box on this label page, or null. */
  function logoBox(P, page) {
    try {
      var ctx = page.doc.context, c = page.node.Contents(), parts = [];
      if (!c) return null;
      if (c instanceof P.PDFArray) c.asArray().forEach(function (r) { parts.push(streamText(P, ctx.lookup(r))); });
      else parts.push(streamText(P, c));
      var sz = page.getSize(), W = sz.width, H = sz.height, best = null;
      drawnImages(P, ctx, parts.join('\n'), page.node.Resources(), [1, 0, 0, 1, 0, 0], 0, []).forEach(function (im) {
        var b = im.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        var photo = !im.mask && (im.bpc == null || im.bpc > 1);              // barcodes are 1-bit: never these
        var spot = cx > W * 0.5 && cy > H * 0.6;                             // top-right, beside "Ship To"
        var size = b.w * b.h > W * H * 0.015 && b.w < W * 0.7 && b.h < H * 0.4;
        if (photo && spot && size && (!best || b.w * b.h > best.w * best.h)) best = b;
      });
      return best;
    } catch (e) { return null; }
  }

  function drawLogo(P, page, box) {
    page.drawRectangle({ x: box.x - 0.5, y: box.y - 0.5, width: box.w + 1, height: box.h + 1, color: P.rgb(1, 1, 1) });
    var s = Math.min(box.w * 0.94 / LOGO_BOX.w, box.h * 0.9 / LOGO_BOX.h);
    var lw = LOGO_BOX.w * s, lh = LOGO_BOX.h * s;
    page.drawSvgPath(LOGO, { x: box.x + (box.w - lw) / 2 - LOGO_BOX.x * s, y: box.y + (box.h + lh) / 2 + LOGO_BOX.y * s, scale: s, color: P.rgb(0, 0, 0), borderWidth: 0 });
  }

  root.mergeLabels6x4 = async function (buffers, opts) {
    var P = root.PDFLib, out = await P.PDFDocument.create(), swap = !(opts && opts.keepLogo);
    for (var i = 0; i < buffers.length; i++) {
      var src = await P.PDFDocument.load(buffers[i], { ignoreEncryption: true });
      var sp = src.getPage(0), box = swap ? logoBox(P, sp) : null;
      var p = (await out.embedPdf(src, [0]))[0];
      var land = p.width >= p.height, pw = land ? LONG : SHORT, ph = land ? SHORT : LONG;
      var k = Math.min(pw / p.width, ph / p.height), w = p.width * k, h = p.height * k, ox = (pw - w) / 2, oy = (ph - h) / 2;
      var page = out.addPage([pw, ph]);
      page.drawPage(p, { x: ox, y: oy, width: w, height: h });
      if (box) {
        var mb = sp.getMediaBox();   // label coordinates -> this page
        drawLogo(P, page, { x: ox + (box.x - mb.x) * k, y: oy + (box.y - mb.y) * k, w: box.w * k, h: box.h * k });
      }
    }
    return out.save();
  };
})(typeof window !== 'undefined' ? window : globalThis);
