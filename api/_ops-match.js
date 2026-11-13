'use strict';

// Deterministic name matching for a frozen class list. This is the same
// matcher the OpenBot worker uses, kept here so an adapter and a CLI worker
// cannot drift apart.
//
// It never guesses. An exact or normalised name yields an admission number; a
// single close candidate yields a candidate only; everything else is flagged
// for a human. The database resolves the admission number against the frozen
// class list for the job, so a later roster change cannot alter the result.

const { CONTRACT_VERSION } = require('./_ops-contract');

function normalise(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[-.]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function tokens(value) {
  return normalise(value).split(' ').filter(Boolean);
}

function keyToken(value) {
  return value
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/q/g, 'k')
    .replace(/(.)\1+/g, '$1')
    .replace(/ee/g, 'i')
    .replace(/ea/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/ou/g, 'u')
    .replace(/y/g, 'i')
    .replace(/c/g, 'k');
}

function longestMatch(a, b, alo, ahi, blo, bhi) {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map();
  for (let i = alo; i < ahi; i += 1) {
    const newj2len = new Map();
    for (let j = blo; j < bhi; j += 1) {
      if (a[i] === b[j]) {
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }
  return [besti, bestj, bestsize];
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const queue = [[0, a.length, 0, b.length]];
  let matched = 0;
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, size] = longestMatch(a, b, alo, ahi, blo, bhi);
    if (size === 0) continue;
    matched += size;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + size < ahi && j + size < bhi) queue.push([i + size, ahi, j + size, bhi]);
  }
  return (2 * matched) / (a.length + b.length);
}

// lines: [{ no: number|null, raw: string }]
// pupils: [{ id, name, admno }]
// Returns a contract-valid staged-rows document. The caller validates it.
function matchLines(lines, pupils, options = {}) {
  const subjectKey = options.subjectKey || '';
  const subjectLabel = options.subjectLabel || '';
  const component = options.component || 'ca1';

  if (!Array.isArray(pupils) || pupils.length === 0) {
    throw new Error('this job has no frozen class list');
  }

  const roster = pupils.map((pupil) => {
    const t = tokens(pupil.name);
    return {
      pupil,
      t,
      n: t.join(' '),
      k: t.map(keyToken).join(' '),
    };
  });

  const rows = [];

  for (const line of lines) {
    const t = tokens(line.raw);
    const names = new Set([t.join(' '), t.slice().reverse().join(' ')]);
    const base = {
      name_raw: line.raw,
      subject_key: subjectKey || undefined,
      subject_label: subjectLabel || undefined,
      component,
    };
    if (line.no != null) base.row_no = line.no;

    const exact = roster.filter((p) => names.has(p.n));
    if (exact.length === 1) {
      rows.push({ ...base, admno: exact[0].pupil.admno, confidence: 1 });
      continue;
    }
    if (exact.length > 1) {
      rows.push({ ...base, flag: 'ambiguous', confidence: null });
      continue;
    }

    const keyed = new Set([
      t.map(keyToken).join(' '),
      t.slice().reverse().map(keyToken).join(' '),
    ]);
    const normalised = roster.filter((p) => keyed.has(p.k));
    if (normalised.length === 1) {
      rows.push({ ...base, admno: normalised[0].pupil.admno, confidence: 0.9 });
      continue;
    }
    if (normalised.length > 1) {
      rows.push({ ...base, flag: 'ambiguous', confidence: null });
      continue;
    }

    const candidates = [];
    for (const p of roster) {
      let best = null;
      let first = null;
      for (let i = 0; i < p.t.length; i += 1) {
        const kp = keyToken(p.t[i]);
        const kt = keyToken(t[0] || '');
        if (kp === kt || similarity(kp, kt) >= 0.8
            || (kt.length >= 4 && (kp.startsWith(kt) || kt.startsWith(kp)))) {
          const rest = p.t.filter((_, j) => j !== i);
          const matches = [];
          for (const x of t.slice(1)) for (const y of rest) matches.push(similarity(keyToken(x), keyToken(y)));
          const f = matches.length ? Math.max(...matches) : 0;
          const score = 0.5 + 0.5 * f;
          if (best == null || score > best) {
            best = score;
            first = p;
          }
        }
      }
      if (best != null) candidates.push({ score: best, pupil: first });
    }
    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length && candidates[0].score >= 0.84
        && candidates[0].score - (candidates[1]?.score || 0) >= 0.12) {
      const top = candidates[0];
      rows.push({
        ...base,
        candidate_admno: top.pupil.pupil.admno,
        confidence: Number(top.score.toFixed(3)),
        flag: 'near_match',
      });
      continue;
    }

    const whole = t.join(' ');
    const reversed = t.slice().reverse().join(' ');
    const scored = roster.map((p) => {
      const s = Math.max(similarity(whole, p.n), similarity(reversed, p.n));
      const a = new Set(t.map(keyToken));
      const b = new Set(p.t.map(keyToken));
      const intersection = [...a].filter((x) => b.has(x)).length;
      const union = new Set([...a, ...b]).size;
      const jaccard = union ? intersection / union : 0;
      return { score: Math.max(s, 0.5 * s + 0.5 * jaccard * 1.15), pupil: p };
    }).sort((x, y) => y.score - x.score);

    if (scored[0] && scored[0].score >= 0.88 && scored[0].score - (scored[1]?.score || 0) >= 0.12) {
      rows.push({
        ...base,
        candidate_admno: scored[0].pupil.pupil.admno,
        confidence: Number(scored[0].score.toFixed(3)),
        flag: 'near_match',
      });
    } else {
      rows.push({ ...base, flag: 'no_confident_match', confidence: null });
    }
  }

  return {
    schema_version: CONTRACT_VERSION,
    rows,
    warnings: rows.some((row) => row.flag)
      ? ['Lines with a flag are waiting for a human; none of them were accepted.']
      : [],
  };
}

module.exports = {
  keyToken,
  matchLines,
  normalise,
  similarity,
  tokens,
};
