/**
 * 生成 T6.1 的二进制解析 fixture：sample.pdf 与 sample.docx。
 *
 * 为什么committed 的是「脚本 + 产物」而不是只有产物：
 * 二进制 fixture 一旦成为不可读的黑盒，日后没人敢改也说不清里面到底有什么；
 * 用可读脚本生成，等于给 fixture 附上了源码与出处（对照 adapters/fixtures 的录制证据思路）。
 *
 * 零依赖：ZIP 用 STORED（不压缩）手写，PDF 手写并回填 xref 偏移。
 * 产物确定性：时间戳与元数据全部固定，重复运行字节一致（便于 diff 审查）。
 *
 * 用法：node packages/rag/fixtures/parse/generate-binary-fixtures.mjs
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- ZIP (STORED)

/** CRC-32（ZIP 用，多项式 0xEDB88320）。 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 打包为 ZIP（全部 STORED）。entries: [{name, data:Buffer}]
 * 固定 DOS 时间 1980-01-01 00:00:00，保证产物可复现。
 */
function buildZip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    localHeader.writeUInt16LE(20, 4); // 解压所需版本 2.0
    localHeader.writeUInt16LE(0, 6); // 通用标志位
    localHeader.writeUInt16LE(0, 8); // 压缩方法 0 = stored
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18); // 压缩后大小
    localHeader.writeUInt32LE(size, 22); // 原始大小
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28); // 扩展字段长度
    locals.push(localHeader, name, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
    centralHeader.writeUInt16LE(20, 4); // 创建版本
    centralHeader.writeUInt16LE(20, 6); // 解压所需版本
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30); // 扩展字段
    centralHeader.writeUInt16LE(0, 32); // 注释
    centralHeader.writeUInt16LE(0, 34); // 起始磁盘号
    centralHeader.writeUInt16LE(0, 36); // 内部属性
    centralHeader.writeUInt32LE(0, 38); // 外部属性
    centralHeader.writeUInt32LE(offset, 42); // 对应本地头偏移
    centrals.push(centralHeader, name);

    offset += localHeader.length + name.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // 中央目录结束记录
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDirectory, endRecord]);
}

// ----------------------------------------------------------------------- DOCX

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** 段落：style 为空则普通段落，否则挂 pStyle（mammoth 默认样式映射据此转 h1/h2）。 */
function paragraph(text, style) {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${paragraph("知识库验收记录", "Heading1")}
${paragraph("本文档用于验证 docx 解析路径：段落与标题的块边界必须保留。", "")}
${paragraph("导入范围", "Heading2")}
${paragraph("百级文件的真实文档目录，含中文文件名与中文正文。", "")}
${paragraph("结论：解析、分块、索引三步均无中断，单文件失败被隔离。", "")}
</w:body>
</w:document>`;

writeFileSync(
  join(OUT_DIR, "sample.docx"),
  buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf8") },
    { name: "word/document.xml", data: Buffer.from(DOCUMENT_XML, "utf8") },
  ]),
);

// ------------------------------------------------------------------------ PDF

/**
 * 两页 PDF，内嵌标准 Helvetica（WinAnsi）。
 * 正文用英文：手写 PDF 要放中文得内嵌 CID 字体与 ToUnicode 映射，
 * 复杂度远超本 fixture 的目的；中文解析路径由 md/txt/html/docx 四个 fixture 覆盖。
 */
function contentStream(lines) {
  const body = lines
    .map((line, index) => (index === 0 ? `(${line}) Tj` : `0 -20 Td (${line}) Tj`))
    .join("\n");
  return `BT\n/F1 14 Tf\n72 720 Td\n${body}\nET\n`;
}

const PAGE_1 = contentStream([
  "Hybrid Retrieval Notes",
  "BM25 and vector recall run in parallel.",
  "Results are fused with reciprocal rank fusion.",
]);

const PAGE_2 = contentStream([
  "Page two covers provenance.",
  "Every chunk records file path and page number.",
]);

/** 按对象序构建 PDF，并回填 xref 偏移。 */
function buildPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(PAGE_1, "latin1")} >>\nstream\n${PAGE_1}endstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${Buffer.byteLength(PAGE_2, "latin1")} >>\nstream\n${PAGE_2}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Title (Hybrid Retrieval Notes) /Producer (FF-pane fixture generator) >>",
  ];

  let pdf = "%PDF-1.7\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  // xref 每行严格 20 字节："%010d %05d n \n"
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += xref;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

writeFileSync(join(OUT_DIR, "sample.pdf"), buildPdf());

console.log("generated: sample.docx, sample.pdf");
