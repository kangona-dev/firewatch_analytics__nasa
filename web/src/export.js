// Export on-screen SVG charts as a PNG, with a title, subtitle and data credit baked in.

const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'opacity',
  'font-size', 'font-family', 'font-weight', 'font-style'];

function inlineSvg(svg) {
  const clone = svg.cloneNode(true);
  const src = [svg, ...svg.querySelectorAll('*')];
  const dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const style = STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';');
    dst[i].setAttribute('style', style);
  });
  const r = svg.getBoundingClientRect();
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', r.width);
  clone.setAttribute('height', r.height);
  return { markup: new XMLSerializer().serializeToString(clone), w: r.width, h: r.height };
}

function loadImage(markup) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });
}

export async function downloadPNG(svgs, { title, subtitle, filename }) {
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const parts = svgs.filter(Boolean).map(inlineSvg);
  const pad = 24, headH = 58, footH = 30, gap = 8, scale = 2;
  const W = Math.max(520, ...parts.map((p) => p.w)) + pad * 2;
  const H = headH + parts.reduce((a, p) => a + p.h + gap, 0) + footH;
  const canvas = document.createElement('canvas');
  canvas.width = W * scale; canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = css('--panel'); ctx.fillRect(0, 0, W, H);
  const font = getComputedStyle(document.body).fontFamily;
  ctx.fillStyle = css('--fg'); ctx.font = `700 17px ${font}`; ctx.fillText(title, pad, 28);
  ctx.fillStyle = css('--muted'); ctx.font = `13px ${font}`; ctx.fillText(subtitle, pad, 47);
  let y = headH;
  for (const p of parts) {
    const img = await loadImage(p.markup);
    ctx.drawImage(img, pad, y, p.w, p.h);
    y += p.h + gap;
  }
  ctx.fillStyle = css('--muted'); ctx.font = `11px ${font}`;
  ctx.fillText('Data: NASA FIRMS (MODIS C6.1, VIIRS S-NPP & NOAA-20), harmonised by Firewatch Analytics · ' + location.host, pad, H - 12);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
