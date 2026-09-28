// 가상 상담 검토 내보내기: JSON(다시 가져오기 가능) / CSV(엑셀) / DOCX(읽고 수정하는 문서)
const review = require('./review');
const { buildDocx } = require('./docx');

function filterRows(rows, only) {
  return only === 'approved' ? rows.filter((r) => review.APPROVED.includes(r.state.status)) : rows;
}

function toJson(rows) {
  return {
    format: 'cleanery-review-export',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    note: '가져오기 시 상담직원 답변 수정·메모·검토 상태만 반영됩니다(원본 고객 발언은 바뀌지 않음).',
    items: rows.map(({ case: c, state }) => ({
      id: c.id, no: c.no, title: c.title, category: c.category, channel: c.channel, difficulty: c.difficulty,
      status: state.status, version: state.version, updatedAt: state.updatedAt, updatedBy: state.updatedBy,
      caseNote: state.caseNote,
      turns: review.finalTurns(c, state).map((t) => ({ id: t.id, speaker: t.speaker === 'staff' ? '상담직원' : '고객', original: t.original, final: t.final, edited: t.edited, note: t.note })),
      edits: state.edits, notes: state.notes, policy: c.policy,
    })),
  };
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const head = ['번호', '제목', '분류', '유형', '난이도', '검토상태', '수정한 답변 수', '사례 메모', '수정 내용(원본 → 수정, 이유)', '정책 확인 필요', '마지막 수정', '버전'];
  const lines = [head.map(csvCell).join(',')];
  for (const { case: c, state } of rows) {
    const changes = review.finalTurns(c, state).filter((t) => t.edited || t.note)
      .map((t) => `[${t.id}] ${t.original} → ${t.final}${t.note ? ` (이유: ${t.note})` : ''}`).join('\n');
    lines.push([c.no, c.title, c.category, c.channel, c.difficulty, state.status, Object.keys(state.edits).length, state.caseNote, changes, c.policy.join(' / '), state.updatedAt || '', state.version].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM: 엑셀 한글 깨짐 방지
}

function toDocx(rows, { title = '크리너리 가상 상담 사례집' } = {}) {
  const s = review.stats(rows);
  const blocks = [
    { type: 'h1', text: title },
    { type: 'p', runs: [{ text: `내보낸 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · 사례 ${rows.length}건`, color: '5B6B7C' }] },
    { type: 'p', runs: [{ text: `검토 현황 — 미검토 ${s['미검토']} · 수정 중 ${s['수정 중']} · 검토 완료 ${s['검토 완료']} · 보류 ${s['보류']} · 기준 반영 완료 ${s['기준 반영 완료']}`, color: '5B6B7C' }] },
    { type: 'p', runs: [{ text: '모든 인물·번호·주소는 가상입니다. "정책 확인 필요"는 회사 정책이 아직 정해지지 않은 부분입니다. 상담직원 답변을 수정한 경우 원본은 회색 취소선, 수정본은 파란색으로 표시됩니다.', color: '5B6B7C' }] },
  ];
  for (const { case: c, state } of rows) {
    blocks.push({ type: 'pagebreak' });
    blocks.push({ type: 'h2', text: `${String(c.no).padStart(3, '0')}. ${c.title}` });
    blocks.push({ type: 'p', runs: [{ text: `${c.category} · ${c.channel} 상담 · 난이도 ${c.difficulty} · 검토 상태: ${state.status}`, color: '5B6B7C' }] });
    blocks.push({ type: 'p', runs: [{ text: '고객 상황: ', bold: true }, c.situation] });
    blocks.push({ type: 'h3', text: c.channel === '전화' ? '통화 내용' : '문자 내용' });
    for (const t of review.finalTurns(c, state)) {
      const who = t.speaker === 'staff' ? '상담직원' : '고객';
      if (t.edited) {
        blocks.push({ type: 'p', runs: [{ text: `${who} (원본): `, bold: true, color: '9AA5B1' }, { text: t.original, strike: true, color: '9AA5B1' }] });
        blocks.push({ type: 'p', runs: [{ text: `${who} (수정): `, bold: true, color: '1D4ED8' }, { text: t.final, color: '1D4ED8' }] });
      } else {
        blocks.push({ type: 'p', runs: [{ text: `${who}: `, bold: true }, t.final] });
      }
      if (t.note) blocks.push({ type: 'p', indent: 400, runs: [{ text: `└ 수정 이유: ${t.note}`, color: 'B45309' }] });
    }
    blocks.push({ type: 'p', runs: [{ text: '상담 결과: ', bold: true }, c.outcome] });
    blocks.push({ type: 'p', runs: [{ text: '주의할 점: ', bold: true }, c.cautions.join(' / ') || '-'] });
    if (c.policy.length) blocks.push({ type: 'p', runs: [{ text: '정책 확인 필요: ', bold: true, color: 'B42318' }, { text: c.policy.join(' / '), color: 'B42318' }] });
    if (state.caseNote) blocks.push({ type: 'p', runs: [{ text: '아빠 메모: ', bold: true }, state.caseNote] });
  }
  return buildDocx(blocks);
}

module.exports = { filterRows, toJson, toCsv, toDocx };
