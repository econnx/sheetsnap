// Turns OCR words (text + bounding box) into a 2D table.
// Works in the browser (window.SheetTable) and in Node (module.exports).
(function (root) {
  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  // Group words into rows by vertical overlap.
  function groupRows(words) {
    const sorted = [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const rows = [];
    for (const w of sorted) {
      const cy = (w.y0 + w.y1) / 2;
      const row = rows.find((r) => cy > r.y0 && cy < r.y1);
      if (row) {
        row.words.push(w);
        row.y0 = Math.min(row.y0, w.y0);
        row.y1 = Math.max(row.y1, w.y1);
      } else {
        rows.push({ y0: w.y0, y1: w.y1, words: [w] });
      }
    }
    rows.sort((a, b) => a.y0 - b.y0);
    rows.forEach((r) => r.words.sort((a, b) => a.x0 - b.x0));
    return rows;
  }

  // Split a row into chunks wherever the horizontal gap is wider than `gap`.
  function chunks(row, gap) {
    const out = [];
    for (const w of row.words) {
      const last = out[out.length - 1];
      if (last && w.x0 - last.x1 < gap) {
        last.text += " " + w.text;
        last.x1 = Math.max(last.x1, w.x1);
      } else {
        out.push({ text: w.text, x0: w.x0, x1: w.x1 });
      }
    }
    return out;
  }

  // Column separators = x positions that no chunk covers in any row.
  function columnBounds(allChunks, width, minGap) {
    const covered = new Uint8Array(Math.ceil(width) + 2);
    for (const c of allChunks) {
      for (let x = Math.max(0, Math.floor(c.x0)); x <= Math.min(width, Math.ceil(c.x1)); x++) covered[x] = 1;
    }
    const cuts = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
      if (!covered[x] && start < 0) start = x;
      if ((covered[x] || x === width) && start >= 0) {
        if (x - start >= minGap) cuts.push((start + x) / 2);
        start = -1;
      }
    }
    return cuts;
  }

  /**
   * words: [{text, x0, y0, x1, y1, confidence?}]
   * returns { rows: string[][], lowConfidence: Set<"r,c"> }
   */
  function buildTable(words, opts = {}) {
    words = words.filter((w) => w.text && w.text.trim() && !/^[|¦‖_—–-]+$/.test(w.text.trim()));
    if (!words.length) return { rows: [], lowConfidence: new Set() };

    const h = median(words.map((w) => w.y1 - w.y0)) || 10;
    const gap = opts.wordGap ?? h * 0.9;       // gap between words that still belong to one cell
    const minColGap = opts.colGap ?? h * 0.6;  // empty strip that separates columns
    const width = Math.max(...words.map((w) => w.x1));

    const rows = groupRows(words).map((r) => ({ ...r, chunks: chunks(r, gap) }));
    const multi = rows.filter((r) => r.chunks.length > 1); // titles spanning one cell don't define columns
    const cuts = columnBounds((multi.length ? multi : rows).flatMap((r) => r.chunks), width, minColGap);
    const ncols = cuts.length + 1;
    const colOf = (x) => cuts.filter((c) => c < x).length;

    const table = [];
    const low = new Set();
    rows.forEach((r, ri) => {
      const cells = Array(ncols).fill("");
      for (const w of r.words) {
        const c = colOf((w.x0 + w.x1) / 2);
        cells[c] = cells[c] ? cells[c] + " " + w.text : w.text;
        if (w.confidence != null && w.confidence < (opts.minConfidence ?? 60)) low.add(`${ri},${c}`);
      }
      table.push(cells);
    });

    // drop columns that are empty everywhere
    const keep = [...Array(ncols).keys()].filter((c) => table.some((r) => r[c].trim()));
    const lowKept = new Set();
    for (const key of low) {
      const [r, c] = key.split(",").map(Number);
      if (keep.includes(c)) lowKept.add(`${r},${keep.indexOf(c)}`);
    }
    const out = table.map((r) => keep.map((c) => r[c].trim()));
    return { rows: fixScripts(out), lowConfidence: lowKept };
  }

  // OCR with eng+ukr mixes look-alike letters (Latin "A" vs Cyrillic "А").
  // Words written only with such letters follow the alphabet that dominates their column.
  const CYR = "АВЕКМНОРСТХаеорсухіІ", LAT = "ABEKMHOPCTXaeopcyxiI";
  const isCyr = (ch) => /[Ѐ-ӿ]/.test(ch);
  const isLat = (ch) => /[a-z]/i.test(ch);
  function fixScripts(rows) {
    const ncols = rows[0] ? rows[0].length : 0;
    const lettersOf = (word) => [...word].filter((ch) => isCyr(ch) || isLat(ch));
    const isAmbiguous = (letters) => letters.length > 0 && letters.every((ch) => CYR.includes(ch) || LAT.includes(ch));
    for (let c = 0; c < ncols; c++) {
      // evidence only from body rows (not the header) and from words that can't be misread
      let cyr = 0, lat = 0;
      for (const r of rows.slice(1)) {
        for (const word of r[c].split(/\s+/)) {
          const letters = lettersOf(word);
          if (isAmbiguous(letters)) continue;
          cyr += letters.filter(isCyr).length;
          lat += letters.filter(isLat).length;
        }
      }
      for (const r of rows) {
        r[c] = r[c].replace(/\S+/g, (word) => {
          const letters = lettersOf(word);
          const mixed = letters.some(isCyr) && letters.some(isLat);
          if (!isAmbiguous(letters) && !mixed) return word;
          let wordLatin;
          if (cyr !== lat) wordLatin = lat > cyr;
          else if (/\d/.test(word)) wordLatin = true;                  // codes like "BE-1"
          else if (mixed) wordLatin = letters.filter(isLat).length >= letters.filter(isCyr).length;
          else return word;                                             // no evidence: leave as read
          return [...word].map((ch) => {
            const i = wordLatin ? CYR.indexOf(ch) : LAT.indexOf(ch);
            return i >= 0 ? (wordLatin ? LAT[i] : CYR[i]) : ch;
          }).join("");
        });
      }
    }
    return rows;
  }

  // "1 234,56" / "$1,234.56" / "12%" -> number, otherwise null
  function toNumber(s) {
    let t = String(s).trim().replace(/[\s ]/g, "").replace(/^[$€£₴]|[$€£₴]$|грн\.?$|uah$/gi, "");
    if (!/^[-−+]?[\d.,]+%?$/.test(t)) return null;
    const pct = t.endsWith("%");
    t = t.replace("%", "").replace("−", "-");
    const seps = t.match(/[.,]/g) || [];
    const kinds = new Set(seps);
    if (kinds.size === 2) {
      // both used: the last one is the decimal point, e.g. "1.234,56" or "1,234.56"
      const ls = Math.max(t.lastIndexOf(","), t.lastIndexOf("."));
      t = t.slice(0, ls).replace(/[.,]/g, "") + "." + t.slice(ls + 1);
    } else if (seps.length > 1 || /^[-+]?[1-9]\d{0,2}[.,]\d{3}$/.test(t)) {
      t = t.replace(/[.,]/g, ""); // "1.234.567" or "1,234" -> thousands separators
    } else {
      t = t.replace(",", ".");
    }
    const n = Number(t);
    if (!isFinite(n)) return null;
    return pct ? n / 100 : n;
  }

  const api = { buildTable, toNumber };
  if (typeof module !== "undefined") module.exports = api;
  else root.SheetTable = api;
})(this);
