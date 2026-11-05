// Builds a small uncompressed PDF with a real text layer so the free
// text-layer extraction path can be exercised without an AI provider.
import { writeFileSync } from 'node:fs';

const lines = [
  'Physics - Class 10 (Punjab Board)',
  'Contents',
  'Chapter 1 Simple Harmonic Motion and Waves ......... 1',
  'Chapter 2 Characteristics of Waves .................. 15',
  'Chapter 3 Geometrical Optics ........................ 29',
  'Chapter 4 Electrostatics ............................ 47',
  'Chapter 5 Current Electricity ....................... 63',
  'Chapter 6 Electromagnetism .......................... 81',
  'Chapter 7 Basic Electronics ......................... 97',
  'Chapter 8 Atomic and Nuclear Physics ................ 111',
];

const content = ['BT', '/F1 12 Tf', '72 720 Td', '18 TL'].concat(
  lines.map(l => `(${l.replace(/[()\\]/g, c => '\\' + c)}) Tj T*`),
).concat(['ET']).join('\n');

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, index) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefAt = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

writeFileSync(process.argv[2] || 'dev-tools/probe-toc.pdf', Buffer.from(pdf, 'latin1'));
console.log('wrote', Buffer.byteLength(pdf), 'bytes');
