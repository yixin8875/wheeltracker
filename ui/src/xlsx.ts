// Minimal OOXML workbook writer: STORE-only ZIP + inline strings. Keeping this
// hand-written avoids a runtime dependency (the desktop build is offline).
import { downloadBytes } from './lib';

export type CellValue = string | number | null | undefined;
export type CellStyle = 'text' | 'number' | 'money' | 'percent';
export interface Sheet {
  name: string;
  rows: CellValue[][];
  columnWidths?: number[];
  styles?: CellStyle[];
}

const MAX_ROWS = 100_000;
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const STYLE_INDEX: Record<CellStyle, number> = { text: 0, number: 0, money: 2, percent: 3 };

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function columnName(index: number) {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function sheetName(name: string, used: Set<string>) {
  const cleaned = name.replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let candidate = cleaned;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    const tail = ` ${suffix++}`;
    candidate = cleaned.slice(0, 31 - tail.length) + tail;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function cellXml(value: CellValue, reference: string, style: number) {
  if (value == null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  }
  const text = String(value);
  if (!text) return `<c r="${reference}" s="${style}" t="inlineStr"><is><t></t></is></c>`;
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t${preserve}>${escapeXml(text)}</t></is></c>`;
}

function worksheet(sheet: Sheet) {
  const columns = Math.max(1, ...sheet.rows.map(row => row.length));
  const widths = Array.from({ length: columns }, (_, index) => {
    if (sheet.columnWidths?.[index]) return Math.min(60, Math.max(6, sheet.columnWidths[index]));
    const longest = Math.max(4, ...sheet.rows.slice(0, 200).map(row => String(row[index] ?? '').length));
    return Math.min(50, longest + 2);
  });
  const rows = sheet.rows.map((row, rowIndex) => {
    const cells = Array.from({ length: columns }, (_, columnIndex) => {
      const value = row[columnIndex];
      const style = rowIndex === 0 ? 1 : STYLE_INDEX[sheet.styles?.[columnIndex] ?? 'text'];
      return cellXml(value, `${columnName(columnIndex)}${rowIndex + 1}`, style);
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`;
}

function workbook(names: string[]) {
  const sheets = names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
}

function workbookRels(count: number) {
  const sheets = Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets}<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/><numFmt numFmtId="165" formatCode="0.00%"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFF3F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function contentTypes(count: number) {
  const sheets = Array.from({ length: count }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets}</Types>`;
}

function rootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function zip(files: { name: string; bytes: Uint8Array }[]) {
  const encoder = new TextEncoder();
  const entries = files.map(file => ({ ...file, nameBytes: encoder.encode(file.name), crc: crc32(file.bytes) }));
  const localSize = entries.reduce((sum, entry) => sum + 30 + entry.nameBytes.length + entry.bytes.length, 0);
  const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.nameBytes.length, 0);
  const total = localSize + centralSize + 22;
  if (total > MAX_BYTES) throw new Error('工作簿超过 4 GiB，无法导出。');
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  let offset = 0;
  const locals: number[] = [];
  for (const entry of entries) {
    locals.push(offset);
    view.setUint32(offset, 0x04034b50, true); offset += 4;
    view.setUint16(offset, 20, true); offset += 2;
    view.setUint16(offset, 0x0800, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0x21, true); offset += 2;
    view.setUint32(offset, entry.crc, true); offset += 4;
    view.setUint32(offset, entry.bytes.length, true); offset += 4;
    view.setUint32(offset, entry.bytes.length, true); offset += 4;
    view.setUint16(offset, entry.nameBytes.length, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    output.set(entry.nameBytes, offset); offset += entry.nameBytes.length;
    output.set(entry.bytes, offset); offset += entry.bytes.length;
  }
  const centralOffset = offset;
  entries.forEach((entry, index) => {
    view.setUint32(offset, 0x02014b50, true); offset += 4;
    view.setUint16(offset, 20, true); offset += 2;
    view.setUint16(offset, 20, true); offset += 2;
    view.setUint16(offset, 0x0800, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0x21, true); offset += 2;
    view.setUint32(offset, entry.crc, true); offset += 4;
    view.setUint32(offset, entry.bytes.length, true); offset += 4;
    view.setUint32(offset, entry.bytes.length, true); offset += 4;
    view.setUint16(offset, entry.nameBytes.length, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, locals[index], true); offset += 4;
    output.set(entry.nameBytes, offset); offset += entry.nameBytes.length;
  });
  view.setUint32(offset, 0x06054b50, true); offset += 4;
  view.setUint16(offset, 0, true); offset += 2;
  view.setUint16(offset, 0, true); offset += 2;
  view.setUint16(offset, entries.length, true); offset += 2;
  view.setUint16(offset, entries.length, true); offset += 2;
  view.setUint32(offset, centralSize, true); offset += 4;
  view.setUint32(offset, centralOffset, true); offset += 4;
  view.setUint16(offset, 0, true);
  return output;
}

export function buildXlsx(sheets: Sheet[]) {
  if (!sheets.length) throw new Error('工作簿至少需要一张工作表。');
  for (const sheet of sheets) {
    if (sheet.rows.length > MAX_ROWS) throw new Error(`工作表「${sheet.name}」超过 ${MAX_ROWS} 行，无法导出。`);
  }
  const encoder = new TextEncoder();
  const used = new Set<string>();
  const names = sheets.map(sheet => sheetName(sheet.name, used));
  const files: { name: string; bytes: Uint8Array }[] = [
    { name: '[Content_Types].xml', bytes: encoder.encode(contentTypes(sheets.length)) },
    { name: '_rels/.rels', bytes: encoder.encode(rootRels()) },
    { name: 'xl/workbook.xml', bytes: encoder.encode(workbook(names)) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: encoder.encode(workbookRels(sheets.length)) },
    { name: 'xl/styles.xml', bytes: encoder.encode(STYLES) },
  ];
  sheets.forEach((sheet, index) => {
    files.push({ name: `xl/worksheets/sheet${index + 1}.xml`, bytes: encoder.encode(worksheet(sheet)) });
  });
  return zip(files);
}

export function downloadXlsx(name: string, sheets: Sheet[]) {
  downloadBytes(name, buildXlsx(sheets), MIME);
}
