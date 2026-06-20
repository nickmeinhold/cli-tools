// Runs inside the page context via `playwright eval`.
// The harness wraps this as: (async () => { <this file> })()
// so we can `await` and must `return` the result.
//
// Marketplace is a heavy SPA: listing cards render after domcontentloaded,
// so poll until item anchors appear (or give up after ~20s).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let anchors = [];
for (let attempt = 0; attempt < 20; attempt++) {
  anchors = [...document.querySelectorAll('a[href*="/marketplace/item/"]')];
  if (anchors.length > 0) break;
  await sleep(1000);
}

// One pass of incremental scroll to coax lazy-loaded cards into the DOM.
window.scrollTo(0, document.body.scrollHeight);
await sleep(2000);
anchors = [...document.querySelectorAll('a[href*="/marketplace/item/"]')];

const seen = new Set();
const out = [];

for (const a of anchors) {
  const m = a.getAttribute("href").match(/\/marketplace\/item\/(\d+)/);
  if (!m) continue;
  const id = m[1];
  if (seen.has(id)) continue;
  seen.add(id);

  // The card's text lives in the anchor (or its nearest sizable ancestor).
  // FB obfuscates class names, so parse by text shape, not selectors.
  let node = a;
  for (let up = 0; up < 4 && node.parentElement; up++) {
    if ((node.innerText || "").trim().length > 10) break;
    node = node.parentElement;
  }
  const lines = (node.innerText || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // Marketplace cards render lines in a stable order: price(s), then title,
  // then location. Discounted items show the current price first and a
  // struck-through original price second, so both look like currency lines.
  const isPrice = (l) => /^(?:A?U?\$\s?[\d,]+|free)$/i.test(l);

  // Price = first currency line (the current/sale price); FREE → 0.
  const priceLine = lines.find(isPrice) || "";
  const price = /free/i.test(priceLine)
    ? 0
    : (priceLine.match(/[\d,]+/) ? parseInt(priceLine.match(/[\d,]+/)[0].replace(/,/g, ""), 10) : null);

  // Strip ALL currency lines, then the remaining lines are [title, …, location]
  // in document order — title first, location last.
  const rest = lines.filter((l) => !isPrice(l));
  const title = rest[0] || "(no title)";
  const location = rest.length > 1 ? rest[rest.length - 1] : "";

  out.push({
    id,
    title,
    price,
    location,
    url: `https://www.facebook.com/marketplace/item/${id}/`,
  });
}

return JSON.stringify(out);
