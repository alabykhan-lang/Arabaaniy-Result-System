'use strict';

// Score-entry name matching.
//
// A record-book page writes a pupil as "SURNAME - Given name", while the class
// list stores the same child as "SURNAME GIVEN NAME". The scanner only accepts
// a pupil when the surname AND every given name on the page agree after the
// handwriting-tolerant key form (double letters, ph/f, y/i, c/k, ee/i, oo/u).
// A page that spells a name differently is never forced onto a surname
// sibling: it is returned as a suggestion for the teacher to confirm.
//
// Surname-only was the old failure: "Azeez - Mubarak" could be saved against
// whatever Azeez the matcher happened to rank first. That can no longer happen
// here because a page with no given name never matches, and a given name that
// disagrees only produces a suggestion.

const { keyToken, tokens } = require('./_ops-match');

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

function editSimilarity(a, b) {
  if (!a || !b) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length, 1);
}

// The page is written surname first, split by a dash. "Raji - Tolahun - Idrees"
// is one surname and two given names. Without a dash the first word is the
// surname, which is how the class list is written.
function pageName(raw) {
  const text = String(raw || '').trim();
  const parts = text.split(/\s*[-–—]\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return { surname: tokens(parts[0]), given: tokens(parts.slice(1).join(' ')), dashed: true };
  const all = tokens(text);
  return { surname: all.slice(0, 1), given: all.slice(1), dashed: false };
}

function keys(list) {
  return list.map((token) => keyToken(token));
}

// Any run of one to three words of a stored name can be the surname, so
// "ABDUL HAMID AMIRAT" and "AMIRAT ABDUL HAMID" both offer a surname shape.
function pupilShapes(name) {
  const all = tokens(name);
  const out = [];
  const maxRun = Math.min(3, all.length);
  for (let start = 0; start < all.length; start += 1) {
    for (let length = 1; length <= maxRun && start + length <= all.length; length += 1) {
      const surname = all.slice(start, start + length);
      const given = all.filter((_, index) => index < start || index >= start + length);
      out.push({ surname, given, surnameKey: keys(surname).join(' '), givenKey: keys(given).sort().join(' ') });
    }
  }
  return out;
}

function sameName(surnameKeys, givenKeys, shape) {
  if (shape.surname.length !== surnameKeys.length) return false;
  if (shape.surnameKey !== surnameKeys.join(' ')) return false;
  if (!shape.given.length || !givenKeys.length) return false;
  if (shape.given.length !== givenKeys.length) return false;
  return shape.givenKey === givenKeys.slice().sort().join(' ');
}

// How close one written name is to a stored one, used only to order the
// suggestions the teacher sees. It never decides a match.
function closeness(sheet, name) {
  let best = 0;
  const written = keys(sheet.surname).join(' ');
  for (const shape of pupilShapes(name)) {
    const surname = editSimilarity(written, shape.surnameKey);
    const given = sheet.given.length
      ? sheet.given.reduce((sum, token) => {
        const key = keyToken(token);
        return sum + Math.max(...shape.given.map((other) => editSimilarity(key, keyToken(other))), 0);
      }, 0) / sheet.given.length
      : 0;
    best = Math.max(best, 0.65 * surname + 0.35 * given);
  }
  return Number(best.toFixed(3));
}

function surnameFamily(sheet, pupils) {
  const written = keys(sheet.surname).join(' ');
  return pupils.filter((pupil) => pupilShapes(pupil.name).some((shape) => shape.surnameKey === written));
}

// Returns one row decision:
//   matched    exactly one pupil's surname and given names agree
//   ambiguous  the surname exists, but the written given name does not agree,
//              or more than one pupil fits; the teacher chooses from candidates
//   unmatched  no surname on the page matches anyone in the class
function matchPupil(raw, pupils) {
  const sheet = pageName(raw);
  const list = Array.isArray(pupils) ? pupils : [];
  if (!sheet.surname.length || !sheet.given.length) {
    return {
      status: 'unmatched',
      pupil: null,
      confidence: 0,
      candidates: [],
      reason: sheet.surname.length ? 'No given name on the page.' : 'No name could be read on this row.',
    };
  }
  const givenKeys = keys(sheet.given);
  const exact = list.filter((pupil) => pupilShapes(pupil.name).some((shape) => sameName(keys(sheet.surname), givenKeys, shape)));
  if (exact.length === 1) {
    return { status: 'matched', pupil: exact[0], confidence: 1, candidates: [{ ...exact[0], score: 1 }], reason: null };
  }
  if (exact.length > 1) {
    return {
      status: 'ambiguous',
      pupil: null,
      confidence: 1,
      candidates: exact.map((pupil) => ({ ...pupil, score: 1 })),
      reason: 'Two pupils fit this name. Choose the right one.',
    };
  }
  const family = surnameFamily(sheet, list);
  const pool = family.length ? family : list;
  const ranked = pool
    .map((pupil) => ({ ...pupil, score: closeness(sheet, pupil.name) }))
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
  const candidates = ranked.slice(0, 3).filter((pupil) => family.length || pupil.score >= 0.5);
  if (family.length) {
    return {
      status: 'ambiguous',
      pupil: null,
      confidence: candidates[0]?.score || 0,
      candidates,
      reason: 'Surname is on the list; written name differs. Choose the pupil.',
    };
  }
  return {
    status: 'unmatched',
    pupil: null,
    confidence: candidates[0]?.score || 0,
    candidates,
    reason: 'Not on the class list.',
  };
}

module.exports = {
  editSimilarity,
  matchPupil,
  pageName,
  pupilShapes,
};
