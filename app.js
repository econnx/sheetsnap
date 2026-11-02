// SheetSnap UI: image in -> OCR -> editable table -> xlsx / csv / clipboard.
const $ = (id) => document.getElementById(id);
const state = { rows: [], low: new Set(), header: true, name: "table" };
let worker = null;
let workerLang = null;

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

function setProgress(p, text) {
  $("progress").hidden = false;
  $("barFill").style.width = Math.round(p * 100) + "%";
  if (text) $("status").textContent = text;
}

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (worker) await worker.terminate();
  worker = await Tesseract.createWorker(lang, 1, {
    logger: (m) => {
      if (m.status === "recognizing text") setProgress(0.35 + m.progress * 0.6, "Reading text…");
      else if (m.status && m.status.includes("loading")) setProgress(0.1 + (m.progress || 0) * 0.2, "Loading language data (first time only)…");
    },
  });
  await worker.setParameters({ preserve_interword_spaces: "1" });
  workerLang = lang;
  return worker;
}

async function loadImage(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

async function handle(blob, name = "table") {
  if (!blob || !blob.type.startsWith("image/")) return toast("Please use an image file");
  state.name = name.replace(/\.[^.]+$/, "") || "table";
  $("result").hidden = true;
  $("previewImg").src = URL.createObjectURL(blob);
  try {
    setProgress(0.03, "Preparing image…");
    const img = await loadImage(blob);
    const prep = SheetPrep.prepare(img);
    const canvas = document.createElement("canvas");
    canvas.width = prep.width;
    canvas.height = prep.height;
    canvas.getContext("2d").putImageData(new ImageData(prep.data, prep.width, prep.height), 0, 0);

    const w = await getWorker($("lang").value);
    const { data } = await w.recognize(canvas);
    const words = (data.words || []).map((x) => ({ text: x.text, confidence: x.confidence, ...x.bbox }));
    const { rows, lowConfidence } = SheetTable.buildTable(words);
    if (!rows.length) throw new Error("No text found in this image");
    state.rows = rows;
    state.low = lowConfidence;
    render();
    setProgress(1, "Done");
    setTimeout(() => ($("progress").hidden = true), 500);
    $("result").hidden = false;
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    console.error(e);
    $("status").textContent = "Something went wrong: " + e.message;
  }
}

function render() {
  const grid = $("grid");
  grid.innerHTML = "";
  const ncols = Math.max(...state.rows.map((r) => r.length));
  state.rows.forEach((row, ri) => {
    const tr = grid.insertRow();
    if (ri === 0 && state.header) tr.className = "header";
    for (let ci = 0; ci < ncols; ci++) {
      const td = tr.insertCell();
      td.contentEditable = "true";
      td.spellcheck = false;
      td.textContent = row[ci] ?? "";
      if (state.low.has(`${ri},${ci}`)) td.classList.add("low");
      if (SheetTable.toNumber(td.textContent) !== null) td.classList.add("num");
      td.addEventListener("input", () => {
        state.rows[ri][ci] = td.textContent;
        td.classList.remove("low");
        td.classList.toggle("num", SheetTable.toNumber(td.textContent) !== null);
      });
      td.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); td.blur(); }
      });
    }
  });
  const lowCount = state.low.size;
  $("summary").textContent = `${state.rows.length} rows × ${ncols} columns` +
    (lowCount ? ` · ${lowCount} cell${lowCount > 1 ? "s" : ""} to check` : " · looks clean");
  $("headerRow").textContent = state.header ? "First row is header ✓" : "First row is header";
}

// Numbers become real numbers in the exported file.
function sheetData() {
  return state.rows.map((row, ri) =>
    row.map((v) => {
      if (ri === 0 && state.header) return v;
      const n = SheetTable.toNumber(v);
      return n === null ? v : n;
    })
  );
}

$("xlsx").onclick = () => {
  const aoa = sheetData();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  state.rows.forEach((row, ri) => row.forEach((v, ci) => {
    if (String(v).trim().endsWith("%") && typeof aoa[ri][ci] === "number") {
      ws[XLSX.utils.encode_cell({ r: ri, c: ci })].z = "0.0%";
    }
  }));
  ws["!cols"] = state.rows[0].map((_, ci) => ({ wch: Math.min(40, Math.max(8, ...state.rows.map((r) => String(r[ci] ?? "").length + 2))) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, state.name + ".xlsx");
};

$("csv").onclick = () => {
  const esc = (v) => (/[",\n;]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const text = state.rows.map((r) => r.map(esc).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
  a.download = state.name + ".csv";
  a.click();
};

$("copy").onclick = async () => {
  const tsv = state.rows.map((r) => r.join("\t")).join("\n");
  try {
    await navigator.clipboard.writeText(tsv);
    toast("Copied — paste into Excel or Google Sheets");
  } catch {
    toast("Couldn't access the clipboard");
  }
};

$("addRow").onclick = () => {
  state.rows.push(Array(state.rows[0].length).fill(""));
  render();
};
$("addCol").onclick = () => {
  state.rows.forEach((r) => r.push(""));
  render();
};
$("headerRow").onclick = () => {
  state.header = !state.header;
  render();
};

// Input: click, drag & drop, paste
const drop = $("drop");
drop.onclick = () => $("file").click();
drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") $("file").click(); };
$("file").onchange = (e) => handle(e.target.files[0], e.target.files[0]?.name);
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => handle(e.dataTransfer.files[0], e.dataTransfer.files[0]?.name));
window.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) handle(item.getAsFile(), "pasted-table");
});

$("sample").onclick = async () => {
  const res = await fetch("sample.png");
  handle(await res.blob(), "sample");
};
