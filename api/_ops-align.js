'use strict';

// Four-list name alignment, shared by every worker.
//
// People, not strings: token sets are order-insensitive and the surname is
// compared first. A = exact, B = suggested (never accepted), C = on the sheet
// but not in the portal, D = in the portal but not on the sheet.
//
// The assignment is global. Two lines can never claim the same pupil, and a
// line is never left in C while its pupil is held by another line's nearest.
// Candidate pools are built by surname, given names are ranked inside the
// pool, and only an empty pool may fall back to an exact given-name set across
// the class. A closed-set hint from the name reader (`name_hint|pupil|literal`)
// is a suggestion like any other: it can create a B row, never an A row, and
// a contested or tied pupil goes to C.

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
  if (a === b) return 1;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length, 1);
}

function surnameMatches(a, b) {
  if (!a || !b) return false;
  return a === b
    || keyToken(a) === keyToken(b)
    || editSimilarity(a, b) >= 0.72
    || editSimilarity(keyToken(a), keyToken(b)) >= 0.70;
}

function firstCloseness(given, pupilGiven) {
  if (!given.length && !pupilGiven.length) return 1;
  if (!given.length || !pupilGiven.length) return 0;
  const scores = given.map((token) => Math.max(...pupilGiven.map((other) => editSimilarity(keyToken(token), keyToken(other)))));
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function splitHandwritten(raw) {
  const text = String(raw || '');
  const dash = text.indexOf('-');
  if (dash !== -1) {
    return { surname: tokens(text.slice(0, dash)), given: tokens(text.slice(dash + 1)), dashed: true };
  }
  const all = tokens(text);
  return { surname: all.slice(0, 1), given: all.slice(1), dashed: false };
}

// Every token of a portal name may be the surname. The sheet is compared with
// each shape in turn, so a name typed "HUSSAIN TAIWO" and one typed "TAIWO
// HUSSAIN" are the same person.
function pupilShapes(name) {
  const all = tokens(name);
  const out = [];
  for (let i = 0; i < all.length; i += 1) {
    out.push({ surname: all[i], given: all.filter((_, j) => j !== i) });
  }
  return out;
}

function pairScore(sheet, pupilName) {
  let best = null;
  const written = sheet.surname.join(' ');
  for (const shape of pupilShapes(pupilName)) {
    if (!surnameMatches(written, shape.surname)) continue;
    const surnameScore = editSimilarity(written, shape.surname);
    const first = firstCloseness(sheet.given, shape.given);
    const total = 0.65 * surnameScore + 0.35 * first;
    if (!best || total > best.total) best = { total, surname: surnameScore, first };
  }
  return best;
}

function keySet(list) {
  return list.map((token) => keyToken(token)).sort().join(' ');
}

function nameKey(value) {
  return String(value || '')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'I')
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A register entry may carry an initial the page did not write (MABUBAT E,
// HIKMOT . O). When the page *does* write an initial, it must also be present:
// a hint that invents a trailing letter is a different child, not a near match.
function pupilGivenSupported(writtenGiven, pupilGiven) {
  if (!pupilGiven.length) return true;
  if (!writtenGiven.length) return false;
  const joined = keyToken(writtenGiven.join(' '));
  return pupilGiven.every((token) => {
    const key = keyToken(token);
    if (writtenGiven.some((written) => editSimilarity(key, keyToken(written)) >= 0.8)) return true;
    return editSimilarity(joined, key) >= 0.8;
  });
}

// The exact-given fallback is deliberately narrow: the whole given-token set
// must match, order-insensitive, with the same number of names. "Raji - Abdul -
// Idrees" can therefore reach RAJI TOLIAT IDRIS only through a surname pool,
// never through a partial given-name overlap.
function exactGivenFor(sheet, pupilName) {
  for (const shape of pupilShapes(pupilName)) {
    if (!sheet.given.length || sheet.given.length !== shape.given.length) continue;
    if (keySet(sheet.given) === keySet(shape.given)) return shape;
  }
  return null;
}

function givenFor(sheet, pupilName) {
  let best = null;
  for (const shape of pupilShapes(pupilName)) {
    const first = firstCloseness(sheet.given, shape.given);
    if (!best || first > best.first) best = { first, shape };
  }
  return best;
}

// A closed-set reader names one pupil from the frozen class list for a line.
// That is a suggestion for a tap, never an acceptance: the literal spelling on
// the page must still support it.
function parseHint(flag) {
  const text = String(flag || '');
  const marker = 'name_hint|';
  if (!text.startsWith(marker)) return null;
  const rest = text.slice(marker.length);
  const split = rest.indexOf('|');
  const pupil = (split === -1 ? rest : rest.slice(0, split)).trim();
  const literal = split === -1 ? '' : rest.slice(split + 1).trim();
  return pupil ? { pupil, literal } : null;
}

// rows: [{ id, row_no, student_name_raw, admno, flag }]
// roster: [{ id, name, admno }]
// Returns the payload ops_stage_alignment expects, plus the four lists.
function alignRows(rows, roster) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('this job has no staged rows');
  if (!Array.isArray(roster) || !roster.length) throw new Error('this job has no frozen class list');

  const used = new Set();
  const state = new Map();
  const items = [];
  const lists = { A: [], B: [], C: [] };

  // A: a printed admission number that exists in the frozen class list, or a
  // full name identical after removing the dash and case. A printed number is
  // stronger evidence than an OCR'd name, so it is checked first.
  for (const row of rows) {
    const printed = String(row.admno || '').trim();
    let hit = printed
      ? roster.find((pupil) => !used.has(pupil.id)
        && String(pupil.admno || '').trim().toUpperCase() === printed.toUpperCase())
      : null;
    let method = printed ? 'admno' : 'name';
    if (!hit) {
      const sheet = tokens(row.student_name_raw);
      hit = roster.find((pupil) => !used.has(pupil.id) && tokens(pupil.name).join(' ') === sheet.join(' '));
      method = 'name';
    }
    if (!hit) continue;
    used.add(hit.id);
    state.set(row.id, 'A');
    items.push({
      staged_row_id: row.id, match_list: 'A', student_id: hit.id,
      surname_score: 1, first_score: 1, candidate_names: [hit.name], confidence: 1,
      match_method: method,
    });
    lists.A.push({
      row_no: row.row_no, raw: row.student_name_raw, pupil: hit.name,
      admno: hit.admno, method,
    });
  }

  const byName = new Map(roster.map((pupil) => [tokens(pupil.name).join(' '), pupil]));
  const available = roster.filter((pupil) => !used.has(pupil.id));

  // One suggestion per line, built from the surname pool first. A hint from a
  // closed-set reader is added only when the page supports it.
  const lines = [];
  const hintRowsByPupil = new Map();
  for (const row of rows) {
    if (state.has(row.id)) continue;
    const hint = parseHint(row.flag);
    const hintLiteral = hint?.literal || '';
    // Score the page as the high-scale second read saw it, but never let that
    // read become an A row: A stays reserved for the open first read or a
    // printed admission number. The hint still has to clear its own given-name
    // check below, so a bare surname match cannot carry it.
    const sheet = hintLiteral ? splitHandwritten(hintLiteral) : splitHandwritten(row.student_name_raw);
    const edges = [];
    let poolSize = 0;
    let eligiblePool = 0;

    for (const pupil of available) {
      const score = pairScore(sheet, pupil.name);
      if (!score) continue;
      poolSize += 1;
      if (score.first >= 0.55) {
        eligiblePool += 1;
        edges.push({
          pupil, surname: score.surname, first: score.first, total: score.total,
          method: 'surname', score: score.total,
        });
      }
    }

    // Pool exists but nothing inside it fits the given name: an exact given
    // set across the whole class is the only other evidence allowed.
    const exactHits = [];
    if (!eligiblePool) {
      for (const pupil of available) {
        if (!exactGivenFor(sheet, pupil)) continue;
        exactHits.push(pupil);
      }
      if (exactHits.length === 1) {
        const pupil = exactHits[0];
        const shape = exactGivenFor(sheet, pupil);
        const surnameScore = editSimilarity(sheet.surname.join(' '), shape.surname);
        edges.push({
          pupil, surname: surnameScore, first: 1, total: 0.65 * surnameScore + 0.35,
          method: 'given', score: 0.85 + 0.15 * surnameScore,
        });
      }
    }

    let hintPupil = null;
    if (hint) {
      hintPupil = byName.get(tokens(hint.pupil).join(' ')) || null;
      if (!hintPupil || used.has(hintPupil.id)) {
        // A hint that points at an already exact-matched line, or at a name
        // outside the frozen list, cannot be trusted. The line waits for a
        // person instead of falling through to a different child.
        state.set(row.id, 'C');
        items.push({
          staged_row_id: row.id, match_list: 'C', candidate_names: [],
          confidence: null,
        });
        lists.C.push({ row_no: row.row_no, raw: row.student_name_raw, reason: 'hint_conflict' });
        continue;
      }
      const given = givenFor(sheet, hintPupil.name);
      const natural = pairScore(sheet, hintPupil.name);
      const shape = given?.shape;
      const initialsFit = !shape || pupilGivenSupported(sheet.given, shape.given);
      // A matching surname is not support on its own: the page must also have
      // written a given name that fits this pupil. "Adeyemo - Tosin" therefore
      // never becomes ADEYEMO SODIQ just because the reader named that child.
      // When the page wrote no given name at all, only a strong surname match
      // counts.
      const givenScore = given ? given.first : 0;
      const givenSupported = sheet.given.length
        ? givenScore >= 0.55
        : Boolean(natural) && natural.surname >= 0.85;
      const supported = givenSupported && initialsFit;
      if (supported) {
        hintRowsByPupil.set(hintPupil.id, (hintRowsByPupil.get(hintPupil.id) || 0) + 1);
        // One edge per pupil per line: the hint replaces a weaker natural
        // edge to the same child instead of competing with it.
        for (let index = edges.length - 1; index >= 0; index -= 1) {
          if (edges[index].pupil.id === hintPupil.id) edges.splice(index, 1);
        }
        const surnameScore = natural
          ? natural.surname
          : editSimilarity(sheet.surname.join(' '), shape.surname);
        const firstScore = natural ? natural.first : givenScore;
        const total = 0.65 * surnameScore + 0.35 * firstScore;
        edges.push({
          pupil: hintPupil,
          surname: surnameScore,
          first: firstScore,
          total,
          method: 'hint',
          // A hinted child is a one-tap suggestion, never stronger than a
          // page that spells the whole name out on its own.
          score: Math.min(0.99, 0.9 + 0.1 * total),
          hinted: true,
        });
      }
    }

    lines.push({ row, sheet, edges, hintPupil, hintLiteral, poolSize, exactHits });
  }

  // Two printed lines cannot carry the same name. When the second read gives
  // the same literal for two lines, one of those readings is an echo of a
  // register entry; neither is allowed to become a suggestion.
  const literalRows = new Map();
  for (const line of lines) {
    const key = nameKey(line.hintLiteral);
    if (!key) continue;
    literalRows.set(key, (literalRows.get(key) || 0) + 1);
  }
  for (const line of lines) {
    const key = nameKey(line.hintLiteral);
    if (!key || (literalRows.get(key) || 0) < 2) continue;
    line.forcedC = 'duplicate_page_read';
    line.edges = line.edges.filter((edge) => !edge.hinted);
    state.set(line.row.id, 'C');
  }

  // The same reader may name one pupil for two printed lines. That is a real
  // ambiguity, not a winner: both lines go to C.
  for (const line of lines) {
    if (!line.hintPupil) continue;
    if ((hintRowsByPupil.get(line.hintPupil.id) || 0) > 1) {
      line.edges = line.edges.filter((edge) => edge.pupil.id !== line.hintPupil.id);
      state.set(line.row.id, 'C');
      line.forcedC = 'hint_conflict';
    }
  }

  // Global one-to-one assignment. A row can stay unmatched (dummy column), a
  // pupil can stay unclaimed (dummy row). Weights are maximised, so the pair
  // with the strongest evidence across the whole page wins, not the first line
  // processed.
  const assignable = lines.filter((line) => !state.has(line.row.id) && line.edges.length);
  const pupils = available;
  const assignment = maxAssignment(assignable, pupils);

  // A near-tie inside one line, or a pupil two lines could both justify, is
  // never allowed to become B: B accepts one pupil.
  const contested = new Set();
  for (const hit of assignment) {
    const line = hit.line;
    if (line.edges.length > 1) {
      const other = line.edges
        .filter((edge) => edge.pupil.id !== hit.edge.pupil.id)
        .some((edge) => edge.score >= hit.edge.score - 0.02);
      if (other && !hit.edge.hinted) contested.add(line);
    }
  }
  for (const hit of assignment) {
    if (contested.has(hit.line)) continue;
    const rival = assignment.find((other) => other !== hit
      && other.edge.pupil.id === hit.edge.pupil.id);
    if (rival) contested.add(hit.line);
  }
  for (const hit of assignment) {
    const rival = assignment.find((other) => other !== hit
      && other.line !== hit.line
      && other.line.edges.some((edge) => edge.pupil.id === hit.edge.pupil.id
        && edge.score >= hit.edge.score - 0.03
        && edge.score >= other.edge.score - 0.02));
    if (rival) {
      contested.add(hit.line);
      contested.add(rival.line);
    }
  }

  for (const line of lines) {
    const row = line.row;
    if (state.has(row.id)) {
      if (state.get(row.id) !== 'C') continue;
      if (!items.some((item) => item.staged_row_id === row.id)) {
        items.push({
          staged_row_id: row.id, match_list: 'C',
          candidate_names: line.hintPupil ? [line.hintPupil.name] : [],
          confidence: null,
        });
        lists.C.push({ row_no: row.row_no, raw: row.student_name_raw, reason: line.forcedC || 'ambiguous' });
      }
      continue;
    }
    const hit = assignment.find((entry) => entry.line === line);
    if (!hit || contested.has(line)) {
      state.set(row.id, 'C');
      const names = line.hintPupil ? [line.hintPupil.name] : [];
      items.push({
        staged_row_id: row.id, match_list: 'C',
        candidate_names: names, confidence: null,
      });
      lists.C.push({
        row_no: row.row_no, raw: row.student_name_raw,
        ...(line.hintPupil ? { hint: line.hintPupil.name } : {}),
        reason: line.forcedC || (line.exactHits.length > 1 ? 'given_ambiguous' : 'no_clear_candidate'),
      });
      continue;
    }

    const edge = hit.edge;
    state.set(row.id, 'B');
    items.push({
      staged_row_id: row.id,
      match_list: 'B',
      student_id: edge.pupil.id,
      admno: edge.pupil.admno,
      candidate_admno: edge.pupil.admno,
      candidate_names: [edge.pupil.name],
      surname_score: Number(edge.surname.toFixed(3)),
      first_score: Number(edge.first.toFixed(3)),
      confidence: Number(Math.min(edge.total, 1).toFixed(3)),
      // The review screen must show the spelling that justified the
      // suggestion, not only the wider first read. A hinted row therefore
      // carries the page literal; the surname-differs note is still derived
      // from the surname score.
      flag: line.hintLiteral
        ? `name_hint|${edge.pupil.name}|${line.hintLiteral}`
        : (edge.surname < 0.72 || edge.method === 'given' ? 'surname_differs' : 'near_match'),
      // The staged_rows check only knows admno/name/manual/none. The finer
      // evidence (surname pool, exact-given fallback, closed-set hint) stays
      // in the B list and the row's first/surname scores.
      match_method: 'name',
    });
    lists.B.push({
      row_no: row.row_no,
      raw: row.student_name_raw,
      pupil: edge.pupil.name,
      method: edge.method,
      surname_score: Number(edge.surname.toFixed(3)),
      first_score: Number(edge.first.toFixed(3)),
      score: Number(Math.min(edge.total, 1).toFixed(3)),
      ...(line.hintLiteral ? { literal: line.hintLiteral } : {}),
    });
    used.add(edge.pupil.id);
  }

  const named = new Set(items
    .filter((item) => item.match_list !== 'C')
    .map((item) => item.student_id));
  const stillOpen = new Set();
  for (const item of items) {
    if (item.match_list !== 'C') continue;
    for (const name of item.candidate_names || []) stillOpen.add(name);
  }
  const portalOnly = roster
    .filter((pupil) => !named.has(pupil.id) && !stillOpen.has(pupil.name))
    .map((pupil) => ({ id: pupil.id, name: pupil.name, admno: pupil.admno }));
  lists.D = portalOnly;

  const counts = {
    A: lists.A.length,
    B: lists.B.length,
    C: lists.C.length,
    D: portalOnly.length,
    pending: lists.B.length + lists.C.length,
  };

  return { items, lists, counts, portalOnly };
}

// Hungarian algorithm on a square cost matrix; returns row -> column. Used for
// maximum-weight one-to-one assignment: real lines meet real pupils, and the
// remaining rows use a zero-weight dummy column so they stay unmatched.
function hungarian(cost) {
  const n = cost.length;
  if (!n) return [];
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const seen = new Array(n + 1).fill(false);
    do {
      seen[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      const row = cost[i0 - 1];
      for (let j = 1; j <= n; j += 1) {
        if (seen[j]) continue;
        const cur = row[j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j += 1) {
        if (seen[j]) { u[p[j]] += delta; v[j] -= delta; } else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const answer = new Array(n).fill(-1);
  for (let j = 1; j <= n; j += 1) if (p[j]) answer[p[j] - 1] = j - 1;
  return answer;
}

function maxAssignment(lines, pupils) {
  if (!lines.length || !pupils.length) return [];
  const rows = lines.length;
  const cols = pupils.length + rows; // one dummy column per row
  const size = cols; // square: add dummy rows to reach the column count
  const NEG = -1e6;
  const weight = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      if (j >= pupils.length) { weight[i][j] = 0; continue; }
      const edge = lines[i].edges.find((entry) => entry.pupil.id === pupils[j].id);
      weight[i][j] = edge ? edge.score : NEG;
    }
  }
  const cost = weight.map((row) => row.map((value) => -value));
  const answer = hungarian(cost);
  const out = [];
  for (let i = 0; i < rows; i += 1) {
    const j = answer[i];
    if (j == null || j < 0 || j >= pupils.length) continue;
    const edge = lines[i].edges.find((entry) => entry.pupil.id === pupils[j].id);
    if (!edge) continue;
    out.push({ line: lines[i], edge, pupil: pupils[j] });
  }
  return out;
}

module.exports = {
  alignRows,
  editDistance,
  editSimilarity,
  firstCloseness,
  scoreNamePair: pairScore,
  splitHandwritten,
  surnameMatches,
  exactGivenFor,
  parseHint,
};
