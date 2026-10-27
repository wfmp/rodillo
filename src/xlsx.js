/* Minimal .xlsx reader (cached cell values) and writer (one sheet, stored zip), with no external libraries. */
(function (root) {
  "use strict";

  // ---------- ZIP ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") throw new Error("Este navegador no puede leer archivos .xlsx");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Read every entry of a zip archive: returns Map name -> Uint8Array. */
  async function unzip(buffer) {
    const bytes = new Uint8Array(buffer);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("No es un archivo .xlsx válido");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = new Map();
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Archivo .xlsx dañado");
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      const lNameLen = dv.getUint16(localOffset + 26, true), lExtraLen = dv.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + compSize);
      files.set(name, { method, data });
    }
    const out = new Map();
    for (const [name, f] of files) out.set(name, f.method === 0 ? f.data : f.method === 8 ? await inflateRaw(f.data) : null);
    return out;
  }

  /** Build a zip with stored (uncompressed) entries. files: [{name, data: Uint8Array}] */
  function zip(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const local = new Uint8Array(30 + name.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(8, 0, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, f.data.length, true); dv.setUint32(22, f.data.length, true);
      dv.setUint16(26, name.length, true); local.set(name, 30);
      chunks.push(local, f.data);
      const cen = new Uint8Array(46 + name.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, f.data.length, true); cv.setUint32(24, f.data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); cen.set(name, 46);
      central.push(cen);
      offset += local.length + f.data.length;
    }
    const cenSize = central.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  // ---------- Reader ----------
  const parseXml = (bytes) => new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
  const byTag = (node, tag) => Array.from(node.getElementsByTagNameNS("*", tag));

  function colIndex(ref) {
    const letters = ref.match(/^[A-Z]+/)[0];
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  /**
   * Read the sheets of an .xlsx file.
   * Returns [{name, rows: [[{v, f}]]}] where v is the cached value (number or string) and f the formula text, if any.
   */
  async function read(buffer) {
    const files = await unzip(buffer);
    const shared = [];
    if (files.get("xl/sharedStrings.xml")) {
      for (const si of byTag(parseXml(files.get("xl/sharedStrings.xml")), "si")) shared.push(byTag(si, "t").map((t) => t.textContent).join(""));
    }
    const rels = new Map();
    for (const r of byTag(parseXml(files.get("xl/_rels/workbook.xml.rels")), "Relationship")) rels.set(r.getAttribute("Id"), r.getAttribute("Target"));
    const sheets = [];
    for (const s of byTag(parseXml(files.get("xl/workbook.xml")), "sheet")) {
      const rid = s.getAttribute("r:id") || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      let target = rels.get(rid) || "";
      target = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
      const data = files.get(target);
      if (!data) continue;
      const rows = [];
      for (const row of byTag(parseXml(data), "row")) {
        const ri = parseInt(row.getAttribute("r"), 10) - 1;
        const cells = [];
        for (const c of byTag(row, "c")) {
          const type = c.getAttribute("t");
          const vNode = byTag(c, "v")[0], fNode = byTag(c, "f")[0];
          let v = vNode ? vNode.textContent : null;
          if (type === "s") v = shared[+v];
          else if (type === "inlineStr") v = byTag(c, "t").map((t) => t.textContent).join("");
          else if (type === "e") v = null;
          else if (type !== "str" && v != null && v !== "") v = Number(v);
          cells[colIndex(c.getAttribute("r"))] = { v, f: fNode ? fNode.textContent : null };
        }
        rows[ri] = cells;
      }
      sheets.push({ name: s.getAttribute("name"), rows });
    }
    return sheets;
  }

  /** Excel serial date (1900 system) -> local Date at midnight. */
  function serialToDate(serial) {
    const ms = Math.round((serial - 25569) * 86400000);
    const utc = new Date(ms);
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
  }
  function dateToSerial(d) {
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000 + 25569;
  }

  // ---------- Writer ----------
  const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function colName(i) { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  /**
   * Write one sheet. columns: [{header, width, type: "date"|"number"|"text", decimals}]
   * rows: arrays of values (Date for date columns) or {formula, value} objects.
   */
  function write(sheetName, columns, rows) {
    // write([{name, columns, rows}, ...]) writes several sheets; write(name, columns, rows) writes one
    const sheetsIn = Array.isArray(sheetName) ? sheetName : [{ name: sheetName, columns, rows }];
    const enc = new TextEncoder();
    const sheetXml = sheetsIn.map((sh) => buildSheet(sh.columns, sh.rows));
    return packWorkbook(sheetsIn.map((sh) => sh.name), sheetXml, enc);
  }

  function buildSheet(columns, rows) {
    const styleFor = (col) => col.type === "date" ? 1 : col.decimals === 1 ? 2 : col.decimals === 2 ? 3 : 0;
    let sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    sheet += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    sheet += "<cols>" + columns.map((c, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.width || 12) + '" customWidth="1"/>').join("") + "</cols><sheetData>";
    sheet += '<row r="1">' + columns.map((c, i) => '<c r="' + colName(i) + '1" t="inlineStr" s="4"><is><t>' + xmlEsc(c.header) + "</t></is></c>").join("") + "</row>";
    rows.forEach((row, ri) => {
      const r = ri + 2;
      sheet += '<row r="' + r + '">';
      row.forEach((val, ci) => {
        const ref = colName(ci) + r, col = columns[ci];
        if (val == null || val === "") return;
        if (typeof val === "object" && !(val instanceof Date) && val.formula) {
          sheet += '<c r="' + ref + '" s="' + styleFor(col) + '"><f>' + xmlEsc(val.formula.replace(/\{r\}/g, r)) + "</f>" + (val.value != null ? "<v>" + val.value + "</v>" : "") + "</c>";
        } else if (val instanceof Date) {
          sheet += '<c r="' + ref + '" s="1"><v>' + dateToSerial(val) + "</v></c>";
        } else if (typeof val === "number") {
          sheet += '<c r="' + ref + '" s="' + styleFor(col) + '"><v>' + val + "</v></c>";
        } else {
          sheet += '<c r="' + ref + '" t="inlineStr"><is><t>' + xmlEsc(val) + "</t></is></c>";
        }
      });
      sheet += "</row>";
    });
    sheet += "</sheetData></worksheet>";
    return sheet;
  }

  function packWorkbook(names, sheetXml, enc) {
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    const files = [
      { name: "[Content_Types].xml", text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + names.map((n, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: "_rels/.rels", text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + names.map((n, i) => '<sheet name="' + xmlEsc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") + '</sheets></workbook>' },
      { name: "xl/_rels/workbook.xml.rels", text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + names.map((n, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("") + '<Relationship Id="rId' + (names.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: "xl/styles.xml", text: styles },
      ...sheetXml.map((text, i) => ({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", text })),
    ];
    return zip(files.map((f) => ({ name: f.name, data: enc.encode(f.text) })));
  }

  root.RodilloXlsx = { read, write, serialToDate, dateToSerial, unzip, crc32 };
})(typeof window !== "undefined" ? window : globalThis);
