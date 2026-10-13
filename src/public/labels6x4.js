/* Join shipping-label PDFs into ONE PDF with one 6 x 4 inch page per label. Runs in the browser (needs pdf-lib.min.js first).
   Each label's first page is scaled to fit (never stretched) and centred. A landscape label gets a 6 wide x 4 tall page,
   a portrait label a 4 wide x 6 tall page, so nothing is rotated and the label fills the page. Any number of labels works. */
(function (root) {
  var PT = 72, LONG = 6 * PT, SHORT = 4 * PT;
  root.mergeLabels6x4 = async function (buffers) {
    var P = root.PDFLib, out = await P.PDFDocument.create();
    for (var i = 0; i < buffers.length; i++) {
      var src = await P.PDFDocument.load(buffers[i], { ignoreEncryption: true });
      var p = (await out.embedPdf(src, [0]))[0];
      var land = p.width >= p.height, pw = land ? LONG : SHORT, ph = land ? SHORT : LONG;
      var k = Math.min(pw / p.width, ph / p.height), w = p.width * k, h = p.height * k;
      out.addPage([pw, ph]).drawPage(p, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
    return out.save();
  };
})(typeof window !== 'undefined' ? window : globalThis);
