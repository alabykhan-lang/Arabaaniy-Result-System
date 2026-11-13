'use strict';

// Free-text instruction parser. It turns one sentence into the same fields a
// form used to ask for: class, subject, printed assessment column, term and
// scope. It never guesses a class or subject: when a name is not in the
// school's own catalogue it returns the closest two real ones and a question.

const COLUMN_LABELS = {
  ca: 'CLASS EXERCISE',
  'class exercise': 'CLASS EXERCISE',
  classwork: 'CLASS EXERCISE',
  'continuous assessment': 'CLASS EXERCISE',
  exam: 'EXAM',
  examination: 'EXAM',
};

const STOP = new Set([
  'record', 'this', 'that', 'for', 'in', 'to', 'the', 'a', 'an', 'is', 'are',
  'please', 'marks', 'mark', 'score', 'scores', 'term', 'first', 'second',
  'third', '1st', '2nd', '3rd', 'and', 'of', 'add', 'new', 'student', 'pupil',
  'ca', 'exam', 'examination', 'class', 'exercise', 'classwork', 'result',
]);

function text(value) {
  return String(value == null ? '' : value);
}

function normalise(value) {
  return text(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compact(value) {
  return normalise(value).replace(/\s+/g, '');
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a, b) {
  if (a === b) return 1;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length, 1);
}

function closest(value, options, limit = 2) {
  const target = normalise(value);
  return options
    .map((option) => ({ option, score: similarity(target, normalise(option)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.option);
}

function classOptions(context) {
  return Array.isArray(context?.classes) ? context.classes : [];
}

// A class name can sit right against the next token, as in "primary 5C.A":
// the teacher writes the class, the column and the subject in one breath. The
// number must end the token (so "primary 55" is not Primary 5) but a letter or
// a full stop may follow it.
function classPattern(alias) {
  const value = normalise(alias);
  if (!value) return null;
  const body = value
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '[\\s-]*');
  return new RegExp(`\\b${body}${/\d$/.test(value) ? '(?![0-9])' : '\\b'}`);
}

const NUMBER_WORDS = {
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

// "nursery one" and "nursery 1" are the same class to a teacher.
function withDigits(value) {
  return normalise(value).replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g,
    (word) => NUMBER_WORDS[word] || word);
}

function findClass(raw, context) {
  const haystack = normalise(raw);
  const digitHaystack = withDigits(raw);
  let best = null;
  for (const item of classOptions(context)) {
    const aliases = new Set([
      normalise(item.key),
      compact(item.key),
      normalise(item.label),
      compact(item.label),
      normalise(item.label).replace(/\s+/g, ''),
    ]);
    // Teachers shorten the first word: "nur 1", "pri 5", "pry 2". Accept the
    // first three letters when a second word keeps the match exact.
    const words = normalise(item.label).split(' ');
    if (words.length > 1 && words[0].length > 4) {
      const short = [words[0].slice(0, 3), ...words.slice(1)].join(' ');
      aliases.add(short);
      aliases.add(short.replace(/\s+/g, ''));
      if (words[0].startsWith('pri')) aliases.add(['pry', ...words.slice(1)].join(' '));
    }
    for (const alias of [...aliases]) aliases.add(withDigits(alias));
    for (const alias of aliases) {
      if (!alias) continue;
      const pattern = classPattern(alias);
      if (pattern && (pattern.test(haystack) || pattern.test(digitHaystack))) {
        if (!best || alias.length > best.alias.length) best = { item, alias };
      }
    }
  }
  return best?.item || null;
}

function findTerm(raw, activeTerm) {
  const value = normalise(raw);
  if (/\b(second|2nd)\s+term\b/.test(value) || /\bterm\s*2\b/.test(value)) return '2nd Term';
  if (/\b(third|3rd)\s+term\b/.test(value) || /\bterm\s*3\b/.test(value)) return '3rd Term';
  if (/\b(first|1st)\s+term\b/.test(value) || /\bterm\s*1\b/.test(value)) return '1st Term';
  return activeTerm || null;
}

function findColumn(raw) {
  const original = text(raw);
  const value = normalise(raw);
  // "C.A" becomes "c a" in normalise, so catch the dotted and spaced forms
  // before the plain CA check. The column word may sit right after the class
  // number ("primary 5C.A"), so a digit or a full stop is allowed in front.
  if (/(?:^|[^A-Za-z])c\s*\.?\s*a\s*[123]?(?![A-Za-z])/i.test(original)) return COLUMN_LABELS.ca;
  if (/\b(class\s*exercise|classwork|continuous\s+assessment)\b/.test(value)) return COLUMN_LABELS['class exercise'];
  if (/\b(ca\s*[123]?|ca)\b/.test(value)) return COLUMN_LABELS.ca;
  if (/\b(exam|examination)\b/.test(value)) return COLUMN_LABELS.exam;
  return null;
}

function findSubject(raw, classItem, context) {
  const value = normalise(raw);
  const subjects = Array.isArray(classItem?.subjects) ? classItem.subjects : [];
  let best = null;
  for (const subject of subjects) {
    const full = normalise(subject);
    const short = full.split(' ')[0];
    const aliases = new Set([full, compact(subject)]);
    if (short.length >= 4) aliases.add(short);
    if (full === 'english language') aliases.add('english');
    if (full === 'mathematics') {
      aliases.add('maths');
      aliases.add('math');
    }
    // Initials work too: "verbal reasoning" is VR, "basic science" is BS.
    const initials = full.split(' ').filter(Boolean).map((word) => word[0]).join('');
    if (initials.length >= 2) aliases.add(initials);
    for (const alias of aliases) {
      if (alias && value.includes(alias)) {
        if (!best || alias.length > best.alias.length) best = { subject, alias };
      }
    }
  }
  if (best) return best.subject;

  // A short phrase after the class name, before a term or column word, is the
  // likely subject the school meant. Try it against the class's real subjects.
  let tail = text(raw);
  if (classItem) {
    for (const alias of [classItem.label, classItem.key]) {
      const pattern = new RegExp(String(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'), 'i');
      tail = tail.replace(pattern, ' ');
    }
  }
  tail = tail
    .replace(/\b(first|second|third|1st|2nd|3rd)\s+term\b/gi, ' ')
    .replace(/\b(term\s*[123])\b/gi, ' ')
    .replace(/\b(class\s*exercise|classwork|continuous assessment|exam|examination|ca)\b/gi, ' ')
    .replace(/\bc\s*\.?\s*a\s*[123]?\b/gi, ' ')
    .replace(/\b\d+(\.\d+)?\s*marks?\b/gi, ' ')
    .replace(/[.,]/g, ' ')
    .trim();
  const words = normalise(tail).split(' ').filter((word) => word && !STOP.has(word));
  if (words.length) {
    return { unknown: words.join(' ') };
  }
  return null;
}

function closestSubjects(value, classItem, context) {
  const subjects = Array.isArray(classItem?.subjects) ? classItem.subjects : [];
  if (subjects.length) return closest(value, subjects, 2);
  const all = [];
  for (const item of classOptions(context)) {
    for (const subject of (item.subjects || [])) all.push(subject);
  }
  return closest(value, [...new Set(all)], 2);
}

function questionForSubject(value, classItem, context) {
  const options = closestSubjects(value, classItem, context);
  const label = classItem?.label || 'this class';
  if (options.length >= 2) return `Is the subject ${options[0]} or ${options[1]} for ${label}?`;
  if (options.length === 1) return `Is the subject ${options[0]} for ${label}?`;
  return `What subject is this for ${label}?`;
}

function cleanName(value) {
  return text(value)
    .replace(/\b(record|this|that|for|please|the|a|an|is|are)\b/gi, ' ')
    .replace(/\b(in|to)\b.*$/i, ' ')
    .replace(/[.,]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseInstruction(raw, context) {
  const original = text(raw).trim();
  const value = normalise(original);
  const classPhrase = (original.match(/\b(jss|ss|primary|nursery|kg)\s*\d+\b/i) || [])[0] || null;
  // The class must be in the sentence. The portal's active class is never a
  // stand-in: an empty class stays empty and is asked for.
  const classItem = findClass(original, context);
  const term = findTerm(original, context?.term);
  const column = findColumn(original);

  const addStudent = /\b(add|enrol|enroll|register)\b/.test(value) && /\b(student|pupil)\b/.test(value);
  const markMatch = original.match(/\b(\d{1,3}(?:\.\d+)?)\s*marks?\b/i);
  const mark = markMatch ? Number(markMatch[1]) : null;

  let pupilName = null;
  if (addStudent) {
    const match = original.match(/\badd\s+(.+?)\s+to\b/i);
    const candidate = match ? cleanName(match[1]) : null;
    if (candidate && !/^(this|a|the)?\s*(new\s+)?(student|pupil)$/i.test(candidate)) pupilName = candidate;
  } else if (mark != null) {
    // A name only matters for one pupil's mark. "record ... for me: primary
    // 5C.A in mathematics" is not a pupil called "me".
    const match = original.match(/\bfor\s+(.+?)\s+in\b/i);
    if (match) pupilName = cleanName(match[1]);
  }

  const individual = !addStudent && mark != null && pupilName;
  const scope = addStudent ? 'add_student'
    : individual ? 'individual'
      : column ? 'assessment'
        : (classItem || findClass(original, context)) ? 'context' : 'unknown';

  const foundSubject = findSubject(original, classItem, context);
  let subject = null;
  let subjectKey = null;
  let needs = [];
  let question = null;

  if (foundSubject && typeof foundSubject === 'object' && foundSubject.unknown && classItem) {
    question = questionForSubject(foundSubject.unknown, classItem, context);
    needs.push('subject');
  } else if (foundSubject && !(typeof foundSubject === 'object' && foundSubject.unknown)) {
    const subjects = Array.isArray(classItem?.subjects) ? classItem.subjects : [];
    const index = subjects.findIndex((item) => normalise(item) === normalise(foundSubject));
    subject = foundSubject;
    subjectKey = classItem ? `${classItem.key}:${String(index + 1)}` : null;
  }

  // A typed instruction about "this" uses the portal's active subject.
  if (!subject && !needs.includes('subject') && (scope === 'assessment' || scope === 'context')
      && classItem?.key === context?.class_key && context?.subject_label) {
    subject = context.subject_label;
    subjectKey = context.subject_key || null;
  }

  // An individual mark needs a subject. Ask for the first two real ones rather
  // than guessing one.
  if (scope === 'individual' && !subject) {
    const options = (classItem?.subjects || []).slice(0, 2);
    question = options.length >= 2
      ? `Which subject is this for, ${options[0]} or ${options[1]}?`
      : (options.length
        ? `Is the subject ${options[0]} for ${classItem?.label || 'this class'}?`
        : `What subject is this for ${classItem?.label || 'this class'}?`);
    needs.push('subject');
  }

  if (!classItem) {
    const options = classPhrase ? closest(classPhrase, classOptions(context).map((item) => item.label), 2) : [];
    question = options.length >= 2
      ? `Which class did you mean, ${options[0]} or ${options[1]}?`
      : (options.length === 1 ? `Is the class ${options[0]}?` : 'Which class is this for?');
    needs.push('class');
  }

  if (scope === 'unknown') {
    question = question || 'Which class and subject is this for?';
    needs.push('class');
  }

  const parsed = {
    ok: needs.length === 0,
    raw: original,
    intent: addStudent ? 'add_student' : individual ? 'individual_mark' : 'context',
    scope,
    class_key: classItem?.key || null,
    class_label: classItem?.label || null,
    section: classItem ? (classItem.section || context?.section || null) : null,
    subject,
    subject_key: subjectKey,
    column_group: term ? String(term).toUpperCase() : null,
    column_label: column,
    term,
    academic_session: context?.academic_session || null,
    pupil_name: pupilName,
    mark,
    needs: [...new Set(needs)],
    question: question || null,
  };

  if (addStudent) {
    parsed.proposal = {
      name: pupilName,
      class_key: parsed.class_key,
      class_label: parsed.class_label,
      fields: {
        source: 'text',
        raw: original,
        note: pupilName ? null : 'Name was not stated in the sentence.',
      },
      status: 'blocked',
      reason: 'Creating a pupil is a live write and stays blocked until live writes are on.',
    };
  }

  return parsed;
}

module.exports = {
  COLUMN_LABELS,
  closest,
  findClass,
  findColumn,
  findSubject,
  findTerm,
  normalise,
  parseInstruction,
  similarity,
};
