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

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');

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

// A pupil photo and the school logo arrive as data URLs or ready buffers. A
// bad image never stops the card; the space is simply left empty.
function imageFrom(source) {
  if (!source) return null;
  if (Buffer.isBuffer(source)) return source;
  const text = str(source);
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(text);
  if (!match) return null;
  try {
    return Buffer.from(match[2], 'base64');
  } catch (err) {
    return null;
  }
}

function drawImage(doc, source, x, y, width, height) {
  const bytes = imageFrom(source);
  if (!bytes) return false;
  try {
    doc.image(bytes, x, y, { fit: [width, height], align: 'center', valign: 'center' });
    return true;
  } catch (err) {
    return false;
  }
}

function header(doc, data, title, opts = {}) {
  const school = data.school_name || 'FIRST CHOICE STANDARD SCHOOLS';
  const style = TEMPLATE_STYLES[String(data.template || '').toLowerCase()] || TEMPLATE_STYLES.modern;
  if (data.sample) {
    write(doc, 'SAMPLE — NOT A SCHOOL RESULT', PAGE_WIDTH - MARGIN - 170, MARGIN - 8, {
      bold: true, size: 7.6, color: '#8a1c1c', width: 170, align: 'right',
    });
  }
  let textX = MARGIN;
  let textWidth = CONTENT_WIDTH;
  if (opts.logo && drawImage(doc, opts.logo, MARGIN, MARGIN - 6, 54, 54)) {
    textX = MARGIN + 64;
    textWidth = CONTENT_WIDTH - 64;
  }
  write(doc, school, textX, MARGIN, { bold: true, size: style.schoolSize, width: textWidth });
  write(doc, data.school_address || '', textX, MARGIN + 18, { size: 7.4, color: SOFT, width: textWidth });
  const contact = [data.school_phone ? `Phone: ${data.school_phone}` : '', data.school_email ? `Email: ${data.school_email}` : '']
    .filter(Boolean).join('  ·  ');
  if (contact) write(doc, contact, textX, MARGIN + 28, { size: 7, color: SOFT, width: textWidth });
  write(doc, title, textX, MARGIN + 40, { bold: true, size: style.titleSize, width: textWidth });
  if (data.template) {
    write(doc, `Template: ${data.template}`, PAGE_WIDTH - MARGIN - 110, MARGIN + 40, {
      size: 6.8, color: SOFT, width: 110, align: 'right',
    });
  }
  rule(doc, MARGIN, MARGIN + 56, PAGE_WIDTH - MARGIN, MARGIN + 56, style.ruleWidth);
  return MARGIN + 64;
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

// The card follows the portal's own report card: header, bio block, class
// summary, every subject of the class, personal development, remark and
// signature. A subject or score the school has not entered yet stays blank;
// nothing is invented and no missing mark is written as zero.
const AFFECTIVE = ['Punctuality', 'Respect', 'Attentiveness', 'Reliability', 'Neatness', 'Spirit of Teamwork'];
const PSYCHOMOTOR = ['Handwriting', 'Reading', 'Verbal Fluency/Diction', 'Musical Skills', 'Creative Arts', 'Physical Education'];

function cardPage(doc, data, pupil, index, total) {
  doc.addPage();
  let y = header(doc, data, 'REPORT CARD', { logo: data.assets && data.assets.logo });

  // BIO — the same fields as the portal card, blank where the school has none.
  const photoWidth = 74;
  const hasPhoto = data.assets && drawImage(doc, pupil.photo, MARGIN + 4, y + 2, 62, 72);
  const bioX = MARGIN + (hasPhoto ? photoWidth : 0);
  const bioWidth = CONTENT_WIDTH - (hasPhoto ? photoWidth : 0);
  write(doc, 'NAME OF STUDENT', bioX, y, { size: 7, color: SOFT, width: bioWidth });
  write(doc, pupil.name || '', bioX, y + 9, { bold: true, size: 11.5, width: bioWidth });
  const bio = [
    ['GENDER', pupil.gender || '—'],
    ['CLASS', data.class_label || '—'],
    ['AGE', pupil.age || '—'],
  ];
  let bx = bioX;
  bio.forEach(([label, value]) => {
    write(doc, `${label}: ${value}`, bx, y + 24, { size: 7.6, width: 96 });
    bx += 92;
  });
  const rightX = PAGE_WIDTH - MARGIN - 116;
  write(doc, 'REG. NO:', rightX, y, { bold: true, size: 7, color: SOFT, width: 116, align: 'right' });
  write(doc, pupil.admno || '—', rightX, y + 9, { bold: true, size: 8.6, width: 116, align: 'right' });
  write(doc, 'SESSION:', rightX, y + 20, { bold: true, size: 7, color: SOFT, width: 116, align: 'right' });
  write(doc, data.academic_session || '—', rightX, y + 28, { bold: true, size: 8.6, width: 116, align: 'right' });
  write(doc, `TERM: ${data.term || '—'}`, rightX, y + 40, { bold: true, size: 7.6, width: 116, align: 'right' });
  y += hasPhoto ? 78 : 52;
  rule(doc, MARGIN, y, PAGE_WIDTH - MARGIN, y, 0.8);
  y += 6;

  // CLASS SUMMARY — the pupil's line among the class, as the portal shows it.
  const stats = data.stats || {};
  const summary = [
    ['No. of students', stats.class_size == null ? '—' : String(stats.class_size)],
    ['Student avg', pupil.average == null ? '—' : number(pupil.average, 2)],
    ['Class avg', stats.average == null ? '—' : number(stats.average, 2)],
    ['Overall total', pupil.total == null ? '—' : number(pupil.total, 1)],
    ['Lowest avg', stats.lowest_average == null ? '—' : number(stats.lowest_average, 2)],
    ['Highest avg', stats.highest_average == null ? '—' : number(stats.highest_average, 2)],
    ['Overall performance', pupil.overall_grade || '—'],
    ['Subjects counted', `${pupil.counted_subjects} of ${(data.subject_set || []).length}`],
  ];
  const cellWidth = CONTENT_WIDTH / 4;
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const [label, value] = summary[row * 4 + col];
      const cx = MARGIN + col * cellWidth;
      doc.save().rect(cx, y, cellWidth - 4, 24).lineWidth(0.5).strokeColor(RULE).stroke().restore();
      write(doc, `${label}:`, cx + 5, y + 3, { size: 6.4, color: SOFT, width: cellWidth - 14 });
      write(doc, value, cx + 5, y + 11, { bold: true, size: 8.4, width: cellWidth - 14 });
    }
    y += 27;
  }
  y += 4;

  // SUBJECTS — always the whole class list, so the card reads like the portal's.
  doc.save().rect(MARGIN, y, CONTENT_WIDTH, 15).fill('#eeeeee').restore();
  write(doc, 'ACADEMIC SUBJECT RESULTS', MARGIN + 4, y + 4, { bold: true, size: 8, width: CONTENT_WIDTH });
  y += 18;
  const colSubject = CONTENT_WIDTH - 60 - 54 - 88;
  const headCells = [
    { label: 'SUBJECT', width: colSubject, align: 'left' },
    { label: 'MARK', width: 60, align: 'right' },
    { label: 'GRADE', width: 54, align: 'center' },
    { label: 'REMARK', width: 88, align: 'left' },
  ];
  let hx = MARGIN;
  doc.save().rect(MARGIN, y - 3, CONTENT_WIDTH, 15).fill('#f4f4f4').restore();
  headCells.forEach((cell) => {
    write(doc, cell.label, hx + 4, y, { bold: true, size: 6.8, width: cell.width - 8, align: cell.align });
    hx += cell.width;
  });
  y += 14;
  rule(doc, MARGIN, y, PAGE_WIDTH - MARGIN, y, 0.6);

  const subjects = Array.isArray(data.subject_set) ? data.subject_set : [];
  subjects.forEach((subject) => {
    const mark = pupil.marks ? pupil.marks[subject.key] : null;
    const has = mark != null;
    const cells = [
      { text: subject.label, width: colSubject, align: 'left' },
      { text: has ? number(mark, 1) : '', width: 60, align: 'right' },
      { text: has ? gradeOf(pupil, subject.key) : '', width: 54, align: 'center' },
      { text: has ? str(pupil.grade_remarks && pupil.grade_remarks[subject.key]) : '', width: 88, align: 'left' },
    ];
    let cx = MARGIN;
    cells.forEach((cell) => {
      write(doc, cell.text, cx + 4, y + 2, { size: 7.8, width: cell.width - 8, align: cell.align });
      cx += cell.width;
    });
    y += 13;
    rule(doc, MARGIN, y, PAGE_WIDTH - MARGIN, y, 0.3, '#cccccc');
  });
  y += 6;

  // PERSONAL DEVELOPMENT — blank ratings where nothing has been entered.
  const traits = pupil.traits || {};
  doc.save().rect(MARGIN, y, CONTENT_WIDTH, 15).fill('#eeeeee').restore();
  write(doc, 'PERSONAL DEVELOPMENT ASSESSMENT', MARGIN + 4, y + 4, { bold: true, size: 7.6, width: CONTENT_WIDTH });
  y += 18;
  const half = CONTENT_WIDTH / 2;
  [['AFFECTIVE TRAITS', AFFECTIVE, 'affective'], ['PSYCHOMOTOR SKILLS', PSYCHOMOTOR, 'psychomotor']].forEach(([title, list, kind], side) => {
    const sx = MARGIN + side * half;
    write(doc, title, sx + 4, y, { bold: true, size: 6.8, width: half - 40 });
    write(doc, 'RTG', sx + half - 34, y, { bold: true, size: 6.8, width: 28, align: 'center' });
    list.forEach((trait, i) => {
      const ty = y + 11 + i * 11;
      write(doc, trait, sx + 4, ty, { size: 7.4, width: half - 40 });
      const value = traits[kind] && traits[kind][trait] != null ? String(traits[kind][trait]) : '';
      write(doc, value, sx + half - 34, ty, { bold: true, size: 7.4, width: 28, align: 'center' });
      rule(doc, sx, ty + 9, sx + half - 6, ty + 9, 0.25, '#dddddd');
    });
  });
  y += 11 + 6 * 11 + 4;
  rule(doc, MARGIN + half, y - 74, MARGIN + half, y - 8, 0.4);

  // REMARK
  doc.save().rect(MARGIN, y, CONTENT_WIDTH, 26).lineWidth(0.5).strokeColor(RULE).stroke().restore();
  write(doc, 'TEACHER’S REMARK', MARGIN + 4, y + 3, { bold: true, size: 6.4, color: SOFT, width: CONTENT_WIDTH - 8 });
  write(doc, pupil.remark || '', MARGIN + 4, y + 10, { size: 7.8, width: CONTENT_WIDTH - 8, wrap: true });
  y += 32;

  // SIGNATURE
  const sigX = PAGE_WIDTH - MARGIN - 150;
  const sigTop = Math.max(y + 4, PAGE_HEIGHT - MARGIN - 74);
  if (data.assets && data.assets.signature) drawImage(doc, data.assets.signature, sigX, sigTop, 140, 44);
  rule(doc, sigX, sigTop + 46, sigX + 140, sigTop + 46, 0.8);
  write(doc, data.signature_title || 'School Proprietor', sigX, sigTop + 49, {
    bold: true, size: 7, width: 140, align: 'center',
  });

  write(doc, `Card ${index + 1} of ${total}`, PAGE_WIDTH - MARGIN - 70, PAGE_HEIGHT - MARGIN + 6, {
    size: 6.6, color: SOFT, width: 70, align: 'right',
  });
  write(doc, data.stats && data.stats.position_rule ? data.stats.position_rule : '', MARGIN, PAGE_HEIGHT - MARGIN + 6, {
    size: 6.6, color: SOFT, width: CONTENT_WIDTH - 80,
  });
}

async function readAsset(name, width, height) {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', name));
    // One file is a JPEG behind a .png name, so normalise both through sharp.
    return await sharp(raw).resize(width, height, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch (err) {
    return null;
  }
}

async function renderCards(data) {
  const { doc, pageCount, finish } = newDoc(
    `Report cards — ${data.class_label} — ${data.term}`,
    `${data.class_label} ${data.term} ${data.academic_session}`,
  );

  // The school's own logo and proprietor signature, exactly as the portal serves
  // them. If either file is missing the card is still printed.
  data.assets = {
    logo: await readAsset('school-logo.png', 160, 160),
    signature: await readAsset('proprietor-signature.png', 420, 160),
  };

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
