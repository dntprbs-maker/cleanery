// 상담 기준 후보 추출 — 아빠가 "검토 완료"(또는 "기준 반영 완료")로 표시한 사례에서만 뽑습니다.
// 결과는 '후보'이며 상담봇 운영 규칙에 자동 적용하지 않습니다(아빠 최종 승인 후 별도 반영).
const review = require('./review');
const { buildDocx } = require('./docx');

function bigrams(s) {
  const t = String(s).replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// 같은 주제 안에서 서로 다른 숫자 기준 / 가능·불가 표현이 섞여 있으면 충돌 후보
const NUM_RULES = [
  { label: '며칠 전 기준', re: /(\d+)\s*일\s*(?:전|이내)/g },
  { label: '금액(원)', re: /(\d[\d,]*)\s*(?:만\s*)?원/g },
  { label: '비율(%)', re: /(\d+)\s*(?:%|퍼센트)/g },
];
const POLARITY_SUBJECTS = ['할인', '환불', '카드', '세금계산서', '현금영수증', '수거', '재방문', '무료', '보험'];

function findConflicts(items) {
  const conflicts = [];
  for (const rule of NUM_RULES) {
    const values = new Map();
    for (const it of items) {
      for (const m of it.text.matchAll(rule.re)) {
        const v = m[1].replace(/,/g, '');
        if (!values.has(v)) values.set(v, []);
        values.get(v).push(it.ref);
      }
    }
    if (rule.label === '며칠 전 기준' && values.size > 1) {
      conflicts.push({ kind: rule.label, detail: [...values.entries()].map(([v, refs]) => `${v}일(${refs.join(', ')})`).join(' / ') });
    }
  }
  for (const subj of POLARITY_SUBJECTS) {
    const yes = items.filter((it) => it.text.includes(subj) && /가능(?!성)|해\s*드릴게요|해\s*드립니다|됩니다/.test(it.text) && !/어렵|불가|안\s*돼|하지\s*않/.test(it.text));
    const no = items.filter((it) => it.text.includes(subj) && /어렵|불가|안\s*돼|하지\s*않/.test(it.text));
    if (yes.length && no.length) {
      conflicts.push({ kind: `'${subj}' 가능/불가 혼재`, detail: `가능: ${yes.map((x) => x.ref).join(', ')} / 불가: ${no.map((x) => x.ref).join(', ')}` });
    }
  }
  return conflicts;
}

function groupSimilar(items, threshold = 0.45) {
  const groups = [];
  for (const it of items) {
    const g = groups.find((gr) => similarity(gr[0].text, it.text) >= threshold);
    if (g) g.push(it); else groups.push([it]);
  }
  return groups;
}

async function extract() {
  const rows = await review.allStates();
  const approved = rows.filter((r) => review.APPROVED.includes(r.state.status));
  const topics = {};
  const policy = [];
  for (const { case: c, state } of approved) {
    for (const p of c.policy) policy.push({ ref: `#${c.no}`, text: p });
    const staff = review.finalTurns(c, state).filter((t) => t.speaker === 'staff');
    for (const tag of c.tags) {
      if (!topics[tag]) topics[tag] = [];
      for (const t of staff) {
        topics[tag].push({ ref: `#${c.no}-${t.id}`, caseNo: c.no, turnId: t.id, text: t.final, edited: t.edited, note: t.note });
      }
    }
  }
  const result = Object.entries(topics).map(([tag, items]) => ({
    tag,
    topic: review.TOPICS[tag] || tag,
    count: items.length,
    groups: groupSimilar(items).map((g) => ({ representative: g.find((x) => x.edited) || g[0], members: g })),
    conflicts: findConflicts(items),
  }));
  return {
    generatedAt: new Date().toISOString(),
    approvedCases: approved.map((r) => r.case.no),
    excludedCount: rows.length - approved.length,
    topics: result,
    policyToConfirm: policy,
    testSeeds: approved.map(({ case: c, state }) => ({
      caseNo: c.no, title: c.title,
      conversation: review.finalTurns(c, state).map((t) => ({ role: t.speaker === 'staff' ? '상담직원(기대 답변)' : '고객', text: t.final })),
    })),
    appliedToBot: false,
  };
}

function toMarkdown(x) {
  const lines = [
    '# 크리너리 상담 기준 후보 (아빠 최종 확인용)',
    '',
    `- 생성: ${x.generatedAt}`,
    `- 근거: **검토 완료·기준 반영 완료 사례 ${x.approvedCases.length}건** (${x.approvedCases.map((n) => '#' + n).join(', ') || '없음'}) — 나머지 ${x.excludedCount}건은 제외`,
    '- ⚠ 이 문서는 후보입니다. 아빠 승인 전에는 상담봇 운영 규칙에 적용하지 않습니다.',
    '',
  ];
  for (const t of x.topics) {
    lines.push(`## ${t.topic}`, '');
    if (t.conflicts.length) {
      lines.push('**⚠ 서로 충돌할 수 있는 답변 — 하나로 정해 주세요**', '');
      for (const c of t.conflicts) lines.push(`- ${c.kind}: ${c.detail}`);
      lines.push('');
    }
    t.groups.forEach((g, i) => {
      lines.push(`${i + 1}. ${g.representative.text}${g.representative.edited ? ' *(아빠 수정)*' : ''}`);
      lines.push(`   - 근거: ${g.members.map((m) => m.ref).join(', ')}`);
      const notes = g.members.filter((m) => m.note).map((m) => `${m.ref}: ${m.note}`);
      if (notes.length) lines.push(`   - 수정 이유: ${notes.join(' / ')}`);
    });
    lines.push('');
  }
  if (x.policyToConfirm.length) {
    lines.push('## 정책 확인 필요 (검토 완료 사례에 남아 있는 미정 정책)', '');
    for (const p of x.policyToConfirm) lines.push(`- ${p.ref} ${p.text}`);
  }
  return lines.join('\n');
}

// 승인된 기준을 상담봇 규칙·시험으로 옮길 때 쓸 초안 (자동 적용 안 함)
function toBotDraft(x) {
  const rules = x.topics.map((t) => ({
    topic: t.topic,
    guideline: t.groups.map((g) => g.representative.text),
    sources: t.groups.flatMap((g) => g.members.map((m) => m.ref)),
    conflictsToResolve: t.conflicts,
  }));
  return { status: '초안 — 아빠 승인 전 적용 금지', rules, tests: x.testSeeds };
}

function toDocx(x) {
  const md = toMarkdown(x).split('\n');
  const blocks = md.map((l) => {
    if (l.startsWith('# ')) return { type: 'h1', text: l.slice(2) };
    if (l.startsWith('## ')) return { type: 'h2', text: l.slice(3) };
    return { type: 'p', text: l.replace(/\*\*/g, '').replace(/\*/g, '') };
  });
  return buildDocx(blocks);
}

module.exports = { extract, toMarkdown, toBotDraft, toDocx, similarity, findConflicts };
