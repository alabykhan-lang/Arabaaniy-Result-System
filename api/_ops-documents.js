'use strict';

// Server-side broadsheet and report-card renderer.
//
// It takes the one readiness payload that the database produced (accepted rows
// only, every refusal already passed) and draws both documents from that same
// object, so a card and the broadsheet cannot disagree. No browser, no print
// dialog. Fonts are embedded and every mark is black on white.
//
// The caller stores the finished bytes, their sha256 and the template version
// on the job. This module never writes anything.

const path = require('node:path');
const PDFDocument = require('pdfkit');

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 36;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FONT_REG = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');

const INK = '#000000';
const RULE = '#000000';
const SOFT = '#666666';

function str(value) {
  return String(value == null ? '' : value);
}

function number(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return digits == null ? String(n) : n.toFixed(digits).replace(/\.0+$/, '');
}

function slug(value) {
  return str(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'school';
}

function filenameFor(data, kind) {
  const school = slug(data.school_name || 'school');
  const klass = slug(data.class_label || data.class_key || 'class');
  const session = slug(data.academic_session || 'session');
  const term = slug(data.term || 'term');
  const version = slug(data.template_version || 'template');
  const subject = kind === 'broadsheet'
    ? 'broadsheet'
    : (Array.isArray(data.subject_set) && data.subject_set.length
      ? data.subject_set.map((s) => slug(s.label)).join('+')
      : 'subject');
  return `${school}-${klass}-${subject}-${session}-${term}-${version}.pdf`;
}

function newDoc(title, subject) {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margins: { top: MARGIN, bottom: 16, left: MARGIN, right: MARGIN },
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    info: {
      Title: title,
      Author: 'Arrabaaniy Standard School',
      Subject: subject,
      Creator: 'Arrabaaniy Assistant (server-side render)',
    },
  });

  doc.registerFont('body', FONT_REG);
  doc.registerFont('bold', FONT_BOLD);

  let pages = 0;
  doc.on('pageAdded', () => { pages += 1; });

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  return {
    doc,
    pageCount: () => pages,
    finish: () => new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    }),
  };
}

function write(doc, value, x, y, options = {}) {
  doc
    .font(options.bold ? 'bold' : 'body')
    .fontSize(options.size || 9)
    .fillColor(options.color || INK);
  const singleLine = options.wrap !== true;
  const size = options.size || 9;
  doc.text(str(value), x, y, {
    width: options.width,
    // A width alone makes PDFKit wrap. Table cells and labels are one line,
    // so give them a one-line height and let the ellipsis truncate cleanly.
    height: singleLine && options.width ? size * 1.35 : undefined,
    align: options.align || 'left',
    lineBreak: options.wrap === true,
    ellipsis: singleLine,
  });
}

function rule(doc, x1, y1, x2, y2, width = 0.6, color = RULE) {
  doc.save().lineWidth(width).strokeColor(color).moveTo(x1, y1).lineTo(x2, y2).stroke().restore();
}

function header(doc, data, title) {
  const school = data.school_name || 'FIRST CHOICE STANDARD SCHOOLS';
  const style = TEMPLATE_STYLES[String(data.template || '').toLowerCase()] || TEMPLATE_STYLES.modern;
  if (data.sample) {
    write(doc, 'SAMPLE — NOT A SCHOOL RESULT', PAGE_WIDTH - MARGIN - 170, MARGIN - 8, {
      bold: true, size: 7.6, color: '#8a1c1c', width: 170, align: 'right',
    });
  }
  write(doc, school, MARGIN, MARGIN, { bold: true, size: style.schoolSize, width: CONTENT_WIDTH });
  write(doc, data.school_address || '', MARGIN, MARGIN + 18, { size: 7.4, color: SOFT, width: CONTENT_WIDTH });
  write(doc, title, MARGIN, MARGIN + 34, { bold: true, size: style.titleSize, width: CONTENT_WIDTH });
  if (data.template) {
    write(doc, `Template: ${data.template}`, PAGE_WIDTH - MARGIN - 110, MARGIN + 34, {
      size: 6.8, color: SOFT, width: 110, align: 'right',
    });
  }
  rule(doc, MARGIN, MARGIN + 50, PAGE_WIDTH - MARGIN, MARGIN + 50, style.ruleWidth);
  return MARGIN + 58;
}

const TEMPLATE_STYLES = {
  modern: { schoolSize: 14, titleSize: 11, ruleWidth: 1.1 },
  classic: { schoolSize: 15, titleSize: 10, ruleWidth: 1.4 },
  compact: { schoolSize: 12.5, titleSize: 10.5, ruleWidth: 0.8 },
  premium: { schoolSize: 15, titleSize: 11.5, ruleWidth: 1.2 },
};

function watermark(doc, data) {
  if (!data.sample) return;
  doc.save();
  doc.opacity(0.07);
  doc.rotate(-28, { origin: [PAGE_WIDTH / 2, PAGE_HEIGHT / 2] });
  doc.font('bold').fontSize(86).fillColor(INK)
    .text('SAMPLE', 70, PAGE_HEIGHT / 2 - 40, { width: PAGE_WIDTH, align: 'center' });
  doc.restore();
}

function footer(doc, data, pageLabel, extra) {
  const y = PAGE_HEIGHT - MARGIN - 6;
  rule(doc, MARGIN, y - 10, PAGE_WIDTH - MARGIN, y - 10, 0.5, SOFT);
  write(doc, extra || data.stats.position_rule, MARGIN, y - 5, {
    size: 6.7, color: SOFT, width: CONTENT_WIDTH - 62,
  });
  write(doc, pageLabel, PAGE_WIDTH - MARGIN - 58, y - 5, {
    size: 6.7, color: SOFT, width: 58, align: 'right',
  });
}

function tableColumns(subjectCount) {
  let subjectWidth = subjectCount <= 4 ? 56 : subjectCount <= 6 ? 44 : 32;
  let admWidth = subjectCount <= 4 ? 110 : subjectCount <= 6 ? 92 : 76;
  const fixed = 18 + admWidth + subjectWidth * subjectCount + 32 + 30 + 24;
  let nameWidth = CONTENT_WIDTH - fixed;
  if (nameWidth < 84) {
    const room = CONTENT_WIDTH - 18 - admWidth - 32 - 30 - 24 - 84;
    subjectWidth = Math.max(22, Math.floor(room / Math.max(1, subjectCount)));
    nameWidth = CONTENT_WIDTH - 18 - admWidth - subjectWidth * subjectCount - 32 - 30 - 24;
  }
  return { subjectWidth, admWidth, nameWidth };
}

function drawTableHeader(doc, data, y, widths) {
  const cells = [
    { label: '#', width: 18, align: 'left' },
    { label: 'Admission No', width: widths.admWidth, align: 'left' },
    { label: 'Pupil', width: widths.nameWidth, align: 'left' },
    ...(data.subject_set || []).map((s) => ({ label: s.label, width: widths.subjectWidth, align: 'right' })),
    { label: 'Total', width: 32, align: 'right' },
    { label: 'Avg', width: 30, align: 'right' },
    { label: 'Pos', width: 24, align: 'right' },
  ];
  let x = MARGIN;
  doc.save().rect(MARGIN, y - 3, CONTENT_WIDTH, 17).fill('#eeeeee').restore();
  for (const cell of cells) {
    write(doc, cell.label, x + 2, y + 1, {
      bold: true, size: data.subject_set.length > 6 ? 6.4 : 7.4, width: cell.width - 4, align: cell.align,
    });
    x += cell.width;
  }
  rule(doc, MARGIN, y + 14, PAGE_WIDTH - MARGIN, y + 14, 0.8);
  return y + 19;
}

function drawTableRow(doc, data, pupil, index, y, widths) {
  const values = [
    { text: String(index + 1), width: 18, align: 'left' },
    { text: pupil.admno || '—', width: widths.admWidth, align: 'left' },
    { text: (pupil.name || '') + (pupil.asterisk ? ' *' : ''), width: widths.nameWidth, align: 'left' },
    ...(data.subject_set || []).map((s) => ({
      text: pupil.marks && pupil.marks[s.key] != null ? number(pupil.marks[s.key], 1) : '—',
      width: widths.subjectWidth,
      align: 'right',
    })),
    { text: number(pupil.total, 1), width: 32, align: 'right' },
    { text: number(pupil.average, 2), width: 30, align: 'right' },
    { text: String(pupil.position == null ? '—' : pupil.position), width: 24, align: 'right' },
  ];
  let x = MARGIN;
  const size = data.subject_set.length > 6 ? 6.5 : 7.8;
  for (const cell of values) {
    write(doc, cell.text, x + 2, y + 1, { size, width: cell.width - 4, align: cell.align });
    x += cell.width;
  }
  rule(doc, MARGIN, y + 15, PAGE_WIDTH - MARGIN, y + 15, 0.3, '#bbbbbb');
  return y + 17;
}

async function renderBroadsheet(data) {
  const { doc, pageCount, finish } = newDoc(
    `Broadsheet — ${data.class_label} — ${data.term}`,
    `${data.class_label} ${data.term} ${data.academic_session}`,
  );

  const subjects = Array.isArray(data.subject_set) ? data.subject_set : [];
  const widths = tableColumns(subjects.length);
  const stats = data.stats || {};
  const subjectLines = (stats.subjects || []).map((s) => (
    `${s.label} — average ${number(s.average, 2)}, highest ${number(s.highest, 1)}, lowest ${number(s.lowest, 1)}`
  ));

  let pageIndex = 0;
  let y = 0;
  let headerY = 0;

  function startPage() {
    doc.addPage();
    pageIndex += 1;
    watermark(doc, data);
    y = header(doc, data, `BROADSHEET — ${data.class_label} — ${data.term} — ${data.academic_session}`);
    write(doc, `Class size ${stats.class_size == null ? '—' : stats.class_size}  ·  Column ${data.column_label || ''}  ·  Subjects ${subjects.length}`,
      MARGIN, y, { bold: true, size: 8.6, width: CONTENT_WIDTH });
    y += 13;
    subjectLines.forEach((line) => {
      write(doc, line, MARGIN, y, { size: 8, width: CONTENT_WIDTH });
      y += 11;
    });
    write(doc, `Class average ${number(stats.average, 2)}  ·  Highest ${number(stats.highest, 1)}  ·  Lowest ${number(stats.lowest, 1)}`,
      MARGIN, y, { bold: true, size: 8.4, width: CONTENT_WIDTH });
    y += 12;
    write(doc, stats.order_rule || 'Ordered by admission number.', MARGIN, y, {
      size: 7.2, color: SOFT, width: CONTENT_WIDTH,
    });
    y += 13;
    headerY = drawTableHeader(doc, data, y, widths);
    y = headerY;
  }

  startPage();
  const pupils = Array.isArray(data.pupils) ? data.pupils : [];
  for (let i = 0; i < pupils.length; i += 1) {
    if (y + 18 > PAGE_HEIGHT - MARGIN - 36) {
      footer(doc, data, `Page ${pageIndex}`, stats.position_rule);
      startPage();
    }
    y = drawTableRow(doc, data, pupils[i], i, y, widths);
  }

  // Legend, then page footers. pdfkit can revisit buffered pages once drawing
  // is finished, so the footer is identical on every page.
  y += 8;
  if (y < PAGE_HEIGHT - MARGIN - 70) {
    write(doc, '* = ranked only on the subjects with a mark. No missing mark is filled with zero.',
      MARGIN, y, { size: 7, width: CONTENT_WIDTH });
    y += 10;
    write(doc, stats.position_rule, MARGIN, y, { size: 7, width: CONTENT_WIDTH });
  }

  const totalPages = pageCount();
  for (let p = 0; p < totalPages; p += 1) {
    doc.switchToPage(p);
    footer(doc, data, `Page ${p + 1} of ${totalPages}`, stats.position_rule);
  }

  const buffer = await finish();
  return {
    type: 'broadsheet',
    mime: 'application/pdf',
    filename: filenameFor(data, 'broadsheet'),
    pageCount: totalPages,
    buffer,
  };
}

function gradeOf(pupil, key) {
  return pupil.grades && pupil.grades[key] != null ? pupil.grades[key] : '—';
}

function cardPage(doc, data, pupil, index, total) {
  doc.addPage();
  watermark(doc, data);
  let y = header(doc, data, 'REPORT CARD');

  write(doc, pupil.name || '', MARGIN, y, { bold: true, size: 13, width: CONTENT_WIDTH });
  y += 18;
  write(doc, `Admission number ${pupil.admno || '—'}`, MARGIN, y, { size: 8.4, width: CONTENT_WIDTH });
  y += 14;

  const info = [
    ['Class', data.class_label],
    ['Session', data.academic_session],
    ['Term', data.term],
    ['Column', data.column_label],
  ];
  const colWidth = CONTENT_WIDTH / 4;
  info.forEach(([label, value], i) => {
    const x = MARGIN + i * colWidth;
    write(doc, label, x, y, { size: 6.8, color: SOFT, width: colWidth - 6 });
    write(doc, value || '—', x, y + 9, { size: 8.6, width: colWidth - 6 });
  });
  y += 28;
  rule(doc, MARGIN, y, PAGE_WIDTH - MARGIN, y, 0.7);
  y += 8;

  const subjects = Array.isArray(data.subject_set) ? data.subject_set : [];
  const withMarks = subjects.filter((s) => pupil.marks && pupil.marks[s.key] != null);

  const colSubject = CONTENT_WIDTH - 70 - 64 - 96;
  const headerCells = [
    { label: 'Subject', width: colSubject, align: 'left' },
    { label: 'Mark', width: 70, align: 'right' },
    { label: 'Grade', width: 64, align: 'center' },
    { label: 'Remark', width: 96, align: 'left' },
  ];
  let x = MARGIN;
  doc.save().rect(MARGIN, y - 3, CONTENT_WIDTH, 17).fill('#eeeeee').restore();
  headerCells.forEach((cell) => {
    write(doc, cell.label, x + 3, y + 1, { bold: true, size: 7.8, width: cell.width - 6, align: cell.align });
    x += cell.width;
  });
  y += 19;
  rule(doc, MARGIN, y - 2, PAGE_WIDTH - MARGIN, y - 2, 0.7);

  for (const subject of withMarks) {
    const mark = pupil.marks[subject.key];
    const remark = pupil.grade_remarks && pupil.grade_remarks[subject.key]
      ? pupil.grade_remarks[subject.key]
      : '';
    x = MARGIN;
    const row = [
      { text: subject.label, width: colSubject, align: 'left' },
      { text: number(mark, 1), width: 70, align: 'right' },
      { text: gradeOf(pupil, subject.key), width: 64, align: 'center' },
      { text: remark, width: 96, align: 'left' },
    ];
    row.forEach((cell) => {
      write(doc, cell.text, x + 3, y, { size: 8.2, width: cell.width - 6, align: cell.align });
      x += cell.width;
    });
    y += 17;
    rule(doc, MARGIN, y - 2, PAGE_WIDTH - MARGIN, y - 2, 0.3, '#bbbbbb');
  }

  if (!withMarks.length) {
    write(doc, 'No approved mark for this pupil.', MARGIN, y + 4, { size: 8.2, width: CONTENT_WIDTH });
    y += 22;
  }

  if (withMarks.length) {
    write(doc, 'Grade and remark are the school bands applied to the mark as a percentage of the subject maximum.',
      MARGIN, y + 3, { size: 6.6, color: SOFT, width: CONTENT_WIDTH });
    y += 14;
  }

  y += 12;
  const totalLabel = pupil.max_total != null && Number(pupil.max_total) !== 100
    ? `Total (of ${number(pupil.max_total, 1)})`
    : 'Total';
  const summary = [
    [totalLabel, number(pupil.total, 1)],
    ['Average', number(pupil.average, 2)],
    ['Position', pupil.position == null ? '—' : String(pupil.position)],
    ['Subjects counted', `${pupil.counted_subjects} of ${subjects.length}`],
  ];
  const boxWidth = CONTENT_WIDTH / 4;
  summary.forEach(([label, value], i) => {
    const bx = MARGIN + i * boxWidth;
    doc.save().rect(bx, y, boxWidth - 8, 34).lineWidth(0.6).strokeColor(RULE).stroke().restore();
    write(doc, label, bx + 6, y + 5, { size: 6.8, color: SOFT, width: boxWidth - 18 });
    write(doc, value, bx + 6, y + 15, { bold: true, size: 10.5, width: boxWidth - 18 });
  });
  y += 46;

  if (pupil.asterisk) {
    const missing = (pupil.missing_subjects || []).map((key) => {
      const found = subjects.find((s) => s.key === key);
      return found ? found.label : key;
    }).join(', ');
    doc.save().rect(MARGIN, y, CONTENT_WIDTH, 34).lineWidth(0.8).strokeColor(RULE).stroke().restore();
    write(doc, `Ranked on ${pupil.counted_subjects} of ${subjects.length} subjects. No mark in ${missing || 'one or more subjects'}.`,
      MARGIN + 7, y + 7, { size: 7.8, width: CONTENT_WIDTH - 14 });
    write(doc, 'No missing mark has been filled with zero.', MARGIN + 7, y + 19, { size: 7.2, color: SOFT, width: CONTENT_WIDTH - 14 });
    y += 44;
  }

  if (pupil.remark) {
    doc.font('body').fontSize(8.2);
    const remarkHeight = doc.heightOfString(pupil.remark, { width: CONTENT_WIDTH });
    write(doc, "Teacher's remark", MARGIN, y + 4, { bold: true, size: 7.6, width: CONTENT_WIDTH });
    write(doc, pupil.remark, MARGIN, y + 14, { size: 8.2, width: CONTENT_WIDTH, wrap: true });
    y += 14 + Math.min(remarkHeight, 70) + 8;
  }

  write(doc, `Built from this pupil's broadsheet row. Template ${data.template_version}.`,
    MARGIN, PAGE_HEIGHT - MARGIN - 52, { size: 6.8, color: SOFT, width: CONTENT_WIDTH });
  write(doc, data.stats.position_rule, MARGIN, PAGE_HEIGHT - MARGIN - 42, {
    size: 6.8, color: SOFT, width: CONTENT_WIDTH,
  });
  write(doc, `Card ${index + 1} of ${total}`, PAGE_WIDTH - MARGIN - 70, PAGE_HEIGHT - MARGIN - 18, {
    size: 6.8, color: SOFT, width: 70, align: 'right',
  });
}

async function renderCards(data) {
  const { doc, pageCount, finish } = newDoc(
    `Report cards — ${data.class_label} — ${data.term}`,
    `${data.class_label} ${data.term} ${data.academic_session}`,
  );

  const pupils = Array.isArray(data.pupils) ? data.pupils : [];
  pupils.forEach((pupil, index) => cardPage(doc, data, pupil, index, pupils.length));

  const totalPages = pageCount();
  return {
    type: 'cards',
    mime: 'application/pdf',
    filename: filenameFor(data, 'cards'),
    pageCount: totalPages,
    buffer: await finish(),
  };
}

async function renderDocuments(data) {
  if (!data || !Array.isArray(data.pupils)) {
    throw new Error('OPS_RENDER_DATA_INVALID');
  }
  if (!data.pupils.length) {
    throw new Error('OPS_RENDER_NO_PUPILS');
  }

  const broadsheet = await renderBroadsheet(data);
  const cards = await renderCards(data);

  const stats = data.stats || {};
  const sample = data.pupils[0] || null;
  return {
    broadsheet,
    cards,
    numbers: {
      class_size: stats.class_size,
      average: stats.average,
      highest: stats.highest,
      lowest: stats.lowest,
      subjects: (stats.subjects || []).map((s) => ({
        key: s.key, label: s.label, average: s.average, highest: s.highest, lowest: s.lowest, count: s.count,
      })),
      sample: sample ? {
        name: sample.name,
        admno: sample.admno,
        total: sample.total,
        average: sample.average,
        position: sample.position,
      } : null,
    },
  };
}

module.exports = {
  filenameFor,
  renderBroadsheet,
  renderCards,
  renderDocuments,
};
