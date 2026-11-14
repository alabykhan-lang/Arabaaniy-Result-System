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
  const theme = opts.theme || themeOf(data);
  // Card headers sit in the theme's colour band; broadsheets stay plain so a
  // full sheet of names keeps its ink light.
  const banded = !!opts.theme;
  if (banded) doc.save().rect(0, 0, PAGE_WIDTH, 96).fill(theme.primary).restore();
  const ink = banded ? '#ffffff' : INK;
  const soft = banded ? 'rgba(255,255,255,0.82)' : SOFT;
  let textX = MARGIN;
  let textWidth = CONTENT_WIDTH;
  if (opts.logo && drawImage(doc, opts.logo, MARGIN, MARGIN - 6, 52, 52)) {
    textX = MARGIN + 62;
    textWidth = CONTENT_WIDTH - 62;
  }
  write(doc, school, textX, MARGIN, { bold: true, size: style.schoolSize, color: banded ? theme.accent2 : INK, width: textWidth });
  write(doc, data.school_address || '', textX, MARGIN + 18, { size: 7.2, color: soft, width: textWidth });
  const contact = [data.school_phone ? `Phone: ${data.school_phone}` : '', data.school_email ? `Email: ${data.school_email}` : '']
    .filter(Boolean).join('  ·  ');
  if (contact) write(doc, contact, textX, MARGIN + 27, { size: 6.6, color: soft, width: textWidth });
  if (banded) {
    band(doc, PAGE_WIDTH - MARGIN - 128, MARGIN + 30, 128, 22, theme.accent);
    write(doc, title, PAGE_WIDTH - MARGIN - 126, MARGIN + 36, { bold: true, size: 10.5, color: theme.primary, width: 124, align: 'center' });
    if (data.sample) {
      write(doc, 'SAMPLE — NOT A SCHOOL RESULT', textX, MARGIN + 40, {
        bold: true, size: 6.6, color: theme.accent2, width: Math.max(120, textWidth - 140),
      });
    }
  } else {
    write(doc, title, textX, MARGIN + 38, { bold: true, size: style.titleSize, color: ink, width: textWidth });
    if (data.sample) {
      write(doc, 'SAMPLE — NOT A SCHOOL RESULT', PAGE_WIDTH - MARGIN - 170, MARGIN - 8, {
        bold: true, size: 7.6, color: '#8a1c1c', width: 170, align: 'right',
      });
    }
  }
  if (data.template) {
    write(doc, `Template: ${data.template}`, PAGE_WIDTH - MARGIN - 110, banded ? MARGIN + 4 : MARGIN + 40, {
      size: 6.2, color: banded ? soft : SOFT, width: 110, align: 'right',
    });
  }
  if (!banded) rule(doc, MARGIN, MARGIN + 56, PAGE_WIDTH - MARGIN, MARGIN + 56, style.ruleWidth);
  return banded ? 108 : MARGIN + 64;
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

// The three card themes the portal offers, in the same colours. The name is the
// template name the caller passed; anything else falls back to modern.
const THEMES = {
  modern: { primary: '#0b2b54', accent: '#dcae2b', accent2: '#f4d477', soft: '#f5f8fc', border: '#ccd7e6', text: '#102d50' },
  creative: { primary: '#0b6b58', accent: '#f59e0b', accent2: '#f97316', soft: '#fffaf0', border: '#e6d4a8', text: '#075744' },
  premium: { primary: '#0b3a2e', accent: '#b18a3a', accent2: '#e2bf71', soft: '#fbf6ea', border: '#d4c39b', text: '#254437' },
  classic: { primary: '#0b2b54', accent: '#dcae2b', accent2: '#f4d477', soft: '#f5f8fc', border: '#ccd7e6', text: '#102d50' },
  compact: { primary: '#0b2b54', accent: '#dcae2b', accent2: '#f4d477', soft: '#f5f8fc', border: '#ccd7e6', text: '#102d50' },
};

function themeOf(data) {
  return THEMES[String(data.template || '').toLowerCase()] || THEMES.modern;
}

function band(doc, x, y, w, h, color) {
  doc.save().rect(x, y, w, h).fill(color).restore();
}

// The card follows the portal's own report card: themed header band, bio block,
// class summary, every subject of the class, personal development, remark and
// signature. A subject or score the school has not entered yet stays blank;
// nothing is invented and no missing mark is written as zero.
// The card is a copy of the portal's own printed card: the same navy frame,
// header, subject columns, personal development table, fee schedule, remark
// line and proprietor signature. The school's own section toggles decide what
// appears, so a card made here and a card printed in the portal read the same.
// Every number below is measured from the portal's own printed card, so the
// download and the browser print are the same document. Coordinates are
// offsets from the card's left edge; the frame starts at CARD_M.
const CARD_M = 22.5;
const CARD_EDGE = CARD_M + 0.75;
const CARD_W = PAGE_WIDTH - CARD_EDGE * 2;
const CARD_CELL = 0.75;

// Card text sits on a baseline. PDFKit places the top of the line, so lift the
// baseline by the font's ascent.
function cardText(doc, value, x, baseline, opts = {}) {
  const size = opts.size || 8;
  write(doc, value, CARD_EDGE + x, baseline - size * 0.93, {
    size,
    bold: opts.bold,
    color: opts.color,
    width: opts.width,
    align: opts.align,
  });
}

function cardCell(doc, theme, x, y, w, h, fill) {
  doc.save().rect(CARD_EDGE + x, y, w, h).lineWidth(CARD_CELL)
    .strokeColor(theme.border).fillAndStroke(fill, theme.border).restore();
}

function cardRule(doc, theme, x1, x2, y, width = 0.75) {
  rule(doc, CARD_EDGE + x1, y, CARD_EDGE + x2, y, width, theme.border);
}

function cardBand(doc, theme, title, y, height = 20.25) {
  band(doc, CARD_EDGE, y, CARD_W, height, theme.accent);
  cardText(doc, title.toUpperCase(), 0, y + height - 7.5, {
    bold: true, size: 8, color: theme.primary, width: CARD_W, align: 'center',
  });
  return y + height;
}

function cardHeader(doc, data, theme) {
  const top = CARD_M;
  const outer = PAGE_WIDTH - CARD_M * 2;
  // Frame: light border, heavier navy strip across the top.
  doc.save().rect(CARD_M, top, outer, PAGE_HEIGHT - CARD_M * 2)
    .lineWidth(CARD_CELL).strokeColor(theme.border).stroke().restore();
  band(doc, CARD_M, top, outer, 5.25, theme.primary);
  band(doc, CARD_EDGE, top + 5.25, CARD_W, 69.75, theme.primary);
  band(doc, CARD_EDGE, top + 73.5, CARD_W, 1.5, theme.accent);

  // School crest on its white tile.
  band(doc, CARD_EDGE + 12, top + 12.75, 51, 51, '#ffffff');
  const logo = data.assets && data.assets.logo;
  if (logo) drawImage(doc, logo, CARD_EDGE + 14, top + 14.75, 47, 47);

  const textX = 74.25;
  const textW = 439.5 - textX - 10;
  cardText(doc, str(data.school_name || 'SCHOOL NAME').toUpperCase(), textX, top + 34.5, {
    bold: true, size: 15, color: theme.accent2, width: textW,
  });
  if (data.school_address) cardText(doc, data.school_address, textX, top + 47.25, {
    size: 8, color: '#ffffff', width: textW,
  });
  const contact = [data.school_phone ? `Phone: ${data.school_phone}` : '',
    data.school_email ? `Email: ${data.school_email}` : ''].filter(Boolean).join(' | ');
  if (contact) cardText(doc, contact, textX, top + 57, { size: 8, color: '#ffffff', width: textW });
  if (data.sample) cardText(doc, 'SAMPLE — NOT A SCHOOL RESULT', textX, top + 68, {
    bold: true, size: 6.5, color: theme.accent2, width: textW,
  });

  band(doc, CARD_EDGE + 439.5, top + 26.25, 97.5, 26.25, theme.accent);
  cardText(doc, 'REPORT CARD', 439.5, top + 43.25, {
    bold: true, size: 9.5, color: theme.primary, width: 97.5, align: 'center',
  });
  return top + 75;
}

// Cell sizes of the results grid, in the portal's own proportions. The subject
// column takes whatever the fixed columns leave.
const CARD_HEADS = [
  { label: 'TOTAL', sub: '(100%)', pad: 4.5 },
  { label: 'GRADE', pad: 4.5 },
  { label: 'CLASS AVG', pad: 4.5 },
  { label: 'HIGHEST', pad: 4.5 },
  { label: 'REMARK', pad: 4.5, size: 9.5 },
];

function cardPage(doc, data, pupil, index, total) {
  doc.addPage();
  const theme = themeOf(data);
  const sections = data.sections || {};
  const on = (key) => sections[key] !== false;
  let y = cardHeader(doc, data, theme);

  // BIO — only when the school keeps it on.
  if (on('showBio')) {
    const photoWidth = 84;
    band(doc, CARD_EDGE, y, CARD_W, 78, theme.soft);
    const hasPhoto = on('showPhoto') && pupil.photo
      && drawImage(doc, pupil.photo, CARD_EDGE + 10, y + 3, 62, 72);
    const bioX = hasPhoto ? photoWidth : 12;
    const rightX = 420;
    const bioWidth = rightX - bioX - 8;
    cardText(doc, 'NAME OF STUDENT', bioX, y + 14, { size: 7.4, color: theme.text, width: bioWidth });
    cardText(doc, str(pupil.name).toUpperCase(), bioX, y + 28, {
      bold: true, size: 11.5, color: theme.primary, width: bioWidth,
    });
    let bx = bioX;
    [['GENDER', pupil.gender || '—'], ['CLASS', data.class_label || '—'], ['AGE', pupil.age || '—']]
      .forEach(([label, value]) => {
        cardText(doc, `${label}: ${value}`, bx, y + 40, { size: 8, color: theme.text, width: 100 });
        bx += 92;
      });
    cardText(doc, 'REG. NO:', rightX, y + 16, {
      bold: true, size: 7.5, color: theme.primary, width: 108, align: 'right',
    });
    cardText(doc, str(pupil.admno || '—'), rightX, y + 27, {
      bold: true, size: 9, color: theme.text, width: 108, align: 'right',
    });
    cardText(doc, 'SESSION:', rightX, y + 40, {
      bold: true, size: 7.5, color: theme.primary, width: 108, align: 'right',
    });
    cardText(doc, str(data.academic_session || '—'), rightX, y + 51, {
      bold: true, size: 9, color: theme.text, width: 108, align: 'right',
    });
    band(doc, CARD_EDGE + rightX + 26, y + 62, 82, 14, theme.primary);
    cardText(doc, `TERM: ${str(data.term || '—')}`, rightX + 28, y + 72, {
      bold: true, size: 7.4, color: theme.accent2, width: 78, align: 'center',
    });
    y += 78;
    cardRule(doc, theme, 0, CARD_W, y, 1.5);
    y += 1.5;
  }

  // SUMMARY — the pupil's line among the class, when the school keeps it on.
  if (on('showSummary')) {
    const stats = data.stats || {};
    const cells = [
      ['No. of students', stats.class_size == null ? '—' : String(stats.class_size)],
      ['Student avg', pupil.average == null ? '--' : number(pupil.average, 2)],
      ['Class avg', stats.average == null ? '--' : number(stats.average, 2)],
      ['Overall total', pupil.total == null ? '--' : number(pupil.total, 1)],
      ['Lowest avg', stats.lowest_average == null ? '--' : number(stats.lowest_average, 2)],
      ['Highest avg', stats.highest_average == null ? '--' : number(stats.highest_average, 2)],
      ['Overall performance', pupil.overall_grade || '--'],
      ['Term', data.term || '--'],
    ];
    const cw = CARD_W / 4;
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        const [label, value] = cells[row * 4 + col];
        cardCell(doc, theme, col * cw, y, cw, 15, '#ffffff');
        cardText(doc, `${label}: ${value}`, col * cw + 4, y + 11, { size: 7.2, color: theme.text, width: cw - 8 });
      }
      y += 15;
    }
    y += 5;
  }

  // SUBJECTS — the portal's own columns, including the class figures. A browser
  // table widens a column to fit its longest entry, so the widths here are
  // measured the same way: every column starts at its longest word and the
  // spare width is shared out. A long subject name therefore widens its column
  // instead of being cut off.
  if (on('showSubjects')) {
    y = cardBand(doc, theme, 'Academic Subject Results', y);
    y += 0.75;
    const assessment = data.assessment || { caCount: 2, caMarks: [], examMark: 70 };
    const caCount = Math.max(1, Math.min(3, Number(assessment.caCount) || 1));
    const caHeads = Array.from({ length: caCount }, (_, i) => ({
      label: `CA${i + 1}`, sub: `(${Number((assessment.caMarks || [])[i]) || 0})`, pad: 4.5,
    }));
    const heads = [
      { label: 'SUBJECT', pad: 9 },
      ...caHeads,
      { label: 'EXAM', sub: `(${Number(assessment.examMark) || 100}%)`, pad: 4.5 },
      ...CARD_HEADS,
    ];
    const statsByKey = new Map((((data.stats || {}).subjects) || []).map((row) => [String(row.key), row]));
    const subjects = Array.isArray(data.subject_set) ? data.subject_set : [];
    const at = (i) => heads[1 + caCount + i];
    const rows = subjects.map((subject, ri) => {
      const key = String(subject.key);
      const parts = (pupil.parts && pupil.parts[key]) || {};
      const total = pupil.marks ? pupil.marks[key] : null;
      const has = total != null;
      const stat = statsByKey.get(key) || {};
      return [
        { text: subject.label, align: 'left', bold: true, color: theme.primary, pad: 9 },
        ...caHeads.map((cell, ci) => ({
          text: parts[`ca${ci + 1}`] == null ? '' : parts[`ca${ci + 1}`], align: 'center', pad: 4.5,
        })),
        { text: parts.exam == null ? '' : parts.exam, align: 'center', pad: 4.5 },
        { text: has ? number(total, 1) : '', align: 'center', bold: true, color: theme.text, pad: 4.5 },
        { text: has ? str(pupil.grades && pupil.grades[key]) : '', align: 'center', bold: true, color: theme.text, pad: 4.5 },
        { text: stat.average == null ? '--' : number(stat.average, 1), align: 'center', color: theme.text, pad: 4.5 },
        { text: stat.highest == null ? '--' : number(stat.highest, 1), align: 'center', color: theme.text, pad: 4.5 },
        { text: has ? str(pupil.grade_remarks && pupil.grade_remarks[key]) : '', align: 'center', color: theme.text, pad: 4.5 },
      ];
    });

    // Measure, then lay out like the browser does.
    const measure = (text, bold, size, pad) => doc.font(bold ? 'bold' : 'body')
      .fontSize(size).widthOfString(str(text)) + pad;
    const longestWord = (text, bold, size, pad) => {
      const words = str(text).split(/\s+/).filter(Boolean);
      const widest = words.length ? Math.max(...words.map((word) => measure(word, bold, size, 0))) : 0;
      return widest + pad;
    };
    const cols = heads.map((head, ci) => {
      const pad = head.pad;
      const size = head.size || 8;
      let min = Math.max(longestWord(head.label, true, size, pad), head.sub ? longestWord(head.sub, true, 8, pad) : 0);
      let max = Math.max(measure(head.label, true, size, pad), head.sub ? measure(head.sub, true, 8, pad) : 0);
      rows.forEach((cells) => {
        const cell = cells[ci];
        if (!cell) return;
        min = Math.max(min, longestWord(cell.text, cell.bold, 8, pad));
        max = Math.max(max, measure(cell.text, cell.bold, 8, pad));
      });
      return { min, max };
    });
    const floor = cols.reduce((sum, col) => sum + col.min, 0);
    if (floor >= CARD_W) {
      cols.forEach((col) => { col.w = (col.min * CARD_W) / floor; });
    } else {
      const spare = CARD_W - floor;
      const room = cols.reduce((sum, col) => sum + (col.max - col.min), 0);
      const bases = cols.reduce((sum, col) => sum + col.max, 0);
      cols.forEach((col) => {
        const share = room > 0 ? (col.max - col.min) / room : col.max / bases;
        col.w = col.min + spare * share;
      });
    }
    heads.forEach((head, ci) => { head.w = cols[ci].w; });

    let hx = 0;
    heads.forEach((cell, ci) => {
      band(doc, CARD_EDGE + hx, y, cell.w, 27.75, theme.primary);
      const label = cell.pad / 2;
      if (cell.sub) {
        cardText(doc, cell.label, hx + label, y + 11.25, {
          bold: true, size: 8, color: '#ffffff', width: cell.w - cell.pad, align: 'center',
        });
        cardText(doc, cell.sub, hx + label, y + 21, {
          bold: true, size: 8, color: '#ffffff', width: cell.w - cell.pad, align: 'center',
        });
      } else {
        const size = cell.size || 8;
        cardText(doc, cell.label, hx + label, y + (size > 8 ? 17.5 : 11.25), {
          bold: true, size, color: '#ffffff', width: cell.w - cell.pad,
          align: ci === 0 ? 'left' : 'center',
        });
      }
      hx += cell.w;
    });
    y += 27.75;

    rows.forEach((cells, ri) => {
      const fill = ri % 2 === 0 ? '#ffffff' : theme.soft;
      let cxp = 0;
      cells.forEach((cell, ci) => {
        const w = heads[ci].w;
        cardCell(doc, theme, cxp, y, w, 16.5, fill);
        cardText(doc, cell.text, cxp + cell.pad / 2, y + 10.5, {
          size: 8, bold: cell.bold, color: cell.color,
          width: w - cell.pad, align: cell.align,
        });
        cxp += w;
      });
      y += 16.5;
    });
    // Close the grid with the frame's own edge.
    cardRule(doc, theme, 0, CARD_W, y);
  }

  // PERSONAL DEVELOPMENT — two columns, ratings blank where none is entered.
  if (on('showAffective') || on('showPsycho')) {
    y = cardBand(doc, theme, 'Personal Development Assessment', y);
    const sides = [];
    if (on('showAffective')) sides.push(['AFFECTIVE TRAITS', AFFECTIVE, 'affective']);
    if (on('showPsycho')) sides.push(['PSYCHOMOTOR SKILLS', PSYCHOMOTOR, 'psychomotor']);
    const layout = sides.length > 1
      ? [{ x: 1.5, w: 219.75, rtg: 221.25 }, { x: 276, w: 220.5, rtg: 496.5 }]
      : [{ x: 1.5, w: CARD_W - 57, rtg: CARD_W - 55.5 }];
    const rtgW = 52.5;
    const headY = y + 0.75;
    sides.forEach(([title, list, kind], side) => {
      const spot = layout[side];
      band(doc, CARD_EDGE + spot.x, headY, spot.w, 18, theme.primary);
      band(doc, CARD_EDGE + spot.rtg, headY, rtgW, 18, theme.primary);
      cardText(doc, title, spot.x, headY + 12.5, {
        bold: true, size: 8, color: '#ffffff', width: spot.w - 6,
      });
      cardText(doc, 'RTG', spot.rtg, headY + 12.5, {
        bold: true, size: 8, color: '#ffffff', width: rtgW, align: 'center',
      });
      list.forEach((trait, i) => {
        const ty = headY + 18 + i * 16.5;
        const fill = i % 2 === 0 ? '#ffffff' : theme.soft;
        cardCell(doc, theme, spot.x, ty, spot.w, 16.5, fill);
        cardText(doc, trait, spot.x + 5.25, ty + 10.5, { size: 8, color: theme.text, width: spot.w - 10 });
        const value = pupil.traits && pupil.traits[kind] && pupil.traits[kind][trait] != null
          ? String(pupil.traits[kind][trait]) : '';
        cardText(doc, value, spot.rtg, ty + 10.5, {
          bold: true, size: 8, color: theme.primary, width: rtgW, align: 'center',
        });
      });
      // Rating key under the psychomotor column, then the column closes.
      const footTop = headY + 18 + list.length * 16.5;
      cardCell(doc, theme, spot.x, footTop, spot.w, 13.5, '#ffffff');
      cardCell(doc, theme, spot.rtg, footTop, rtgW, 13.5, '#ffffff');
    });
    band(doc, CARD_EDGE + 221.25, headY, 0.75, 18, theme.primary);
    if (on('showPsycho')) {
      cardText(doc, '5=Excellent, 1=Poor', 461.47, headY + 18 + PSYCHOMOTOR.length * 16.5 + 9.5, {
        size: 7, color: SOFT, width: 75, align: 'right',
      });
    }
    if (sides.length > 1) band(doc, CARD_EDGE + 273.75, headY, 1.5, 18 + 6 * 16.5 + 13.5, theme.border);
    y = headY + 18 + 6 * 16.5 + 13.5;
  }

  // NEXT TERM FEES — the school's own lines.
  const feeRows = Array.isArray(data.fees_next_term) ? data.fees_next_term : [];
  if (on('showFees') && feeRows.length) {
    y = cardBand(doc, theme, 'Next Term Fee Schedule', y, 18.75);
    band(doc, CARD_EDGE + 1.5, y + 0.75, CARD_W - 1.5, 18.75, theme.primary);
    band(doc, CARD_EDGE, y, CARD_W, 1.5, theme.primary);
    cardText(doc, 'FEE ITEM', 5.25, y + 13.5, {
      bold: true, size: 8, color: '#ffffff', width: 180,
    });
    cardText(doc, 'NEXT TERM AMOUNT', 0, y + 13.5, {
      bold: true, size: 8, color: '#ffffff', width: CARD_W - 6, align: 'right',
    });
    y += 18.75;
    feeRows.forEach((row, i) => {
      const fill = i % 2 === 0 ? '#ffffff' : theme.soft;
      cardCell(doc, theme, 1.5, y, 201, 18, fill);
      cardCell(doc, theme, 202.5, y, CARD_W - 203.25, 18, fill);
      cardText(doc, row.label, 5.25, y + 12, { size: 8, color: theme.text, width: 180 });
      cardText(doc, row.amount ? `N${Number(row.amount).toLocaleString('en-NG')}` : '--', 202.5, y + 12, {
        bold: true, size: 8.5, color: theme.text, width: CARD_W - 208.5, align: 'right',
      });
      y += 18;
    });
    cardRule(doc, theme, 0, CARD_W, y - 0.75);
  }

  // GENERAL REMARK — written on its own rule, as in the portal card.
  const remarkY = y + 14.25;
  cardText(doc, 'GENERAL REMARK', 9.75, remarkY, { bold: true, size: 8.5, color: theme.accent });
  // The remark is written on the rule beside the label; the rule fills the rest
  // of the line, as in the portal card.
  const remarkX = 9.75 + doc.font('bold').fontSize(8.5).widthOfString('GENERAL REMARK') + 14;
  const remark = str(pupil.general_remark || pupil.remark || '--') || '--';
  cardText(doc, remark, remarkX, remarkY + 1.5, { size: 7.5, color: theme.text, width: CARD_W - remarkX - 10 });
  const remarkEnd = remarkX + doc.font('body').fontSize(7.5).widthOfString(remark) + 10;
  rule(doc, CARD_EDGE + remarkEnd, remarkY + 2.25, CARD_EDGE + 540, remarkY + 2.25, 0.75, '#aaaaaa');
  cardRule(doc, theme, 0, CARD_W, remarkY + 7.5);

  // SIGNATURE — signature art over a rule, with the title beneath it.
  if (on('showSignature')) {
    if (data.assets && data.assets.signature) {
      drawImage(doc, data.assets.signature, CARD_EDGE + 34, remarkY + 15.25, 54, 42);
    }
    rule(doc, CARD_EDGE + 17.5, remarkY + 55.75, CARD_EDGE + 130.5, remarkY + 55.75, 0.75, theme.primary);
    cardText(doc, str(data.signature_title || 'SCHOOL PROPRIETOR').toUpperCase(), 7.29, remarkY + 69.75, {
      bold: true, size: 8.5, color: theme.primary, width: 140,
    });
  }
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
