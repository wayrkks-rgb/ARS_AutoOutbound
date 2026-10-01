/* 수신 규칙 편집기 (서버 추가/수정, 규칙 일괄적용에서 공용)
   rule: { id, name, metrics[], keywords[], any_level, DAY, NIGHT, contacts:[{name, phone}] } */
(function () {
  const QUICK = ['*', '*사용률', '*프로세스 개수', '*가용성'];
  let uid = 0;

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach(k => k != null && e.append(k.nodeType ? k : document.createTextNode(k)));
    return e;
  }

  function blankRule(n) {
    return { id: '', name: n ? `규칙${n}` : '기본', metrics: ['*'], keywords: [], any_level: 'N',
             DAY: 'Y', NIGHT: 'Y', contacts: [{ name: '', phone: '' }] };
  }

  function phoneOk(v) { return /^010\d{8}$/.test(String(v || '').replace(/\D/g, '')); }

  function mount(root, initial, opts) {
    opts = opts || {};
    const single = !!opts.single;
    const contactsByName = {};
    (opts.contacts || []).forEach(c => (contactsByName[c.name] = contactsByName[c.name] || []).push(c.phone));
    let rules = (initial && initial.length ? initial : [blankRule()]).map(r => JSON.parse(JSON.stringify(r)));
    rules.forEach(r => { if (!r.contacts || !r.contacts.length) r.contacts = [{ name: '', phone: '' }]; });

    const listId = 'metricList' + (++uid), nameListId = 'nameList' + uid;
    const metricList = el('datalist', { id: listId }, (opts.metrics || []).map(m => el('option', { value: m })));
    const nameList = el('datalist', { id: nameListId }, Object.keys(contactsByName).sort().map(n => el('option', { value: n })));

    function renderRule(r, ri) {
      const metricInput = el('input', { type: 'text', list: listId, placeholder: 'metric 이름 또는 * 패턴 입력 후 Enter', class: 'mono' });
      const addMetric = v => {
        v = String(v || '').trim();
        if (!v) return;
        if (v === '*') r.metrics = ['*'];
        else { r.metrics = r.metrics.filter(m => m !== '*'); if (!r.metrics.includes(v)) r.metrics.push(v); }
        render();
      };
      metricInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addMetric(metricInput.value); } });

      const metricChips = el('div', { class: 'rule-chips' }, r.metrics.map((m, mi) =>
        el('span', { class: 'chip' + (m === '*' ? ' chip-all' : '') }, m === '*' ? '* 전체 (기본 담당 — 다른 규칙이 안 맞을 때)' : m,
          el('button', { type: 'button', class: 'chip-x', title: '제거', onclick: () => { r.metrics.splice(mi, 1); if (!r.metrics.length) r.metrics = ['*']; render(); } }, '×'))));

      const contactRows = r.contacts.map((c, ci) => {
        const phone = el('input', { type: 'text', value: c.phone, placeholder: '010-1234-5678', class: 'mono' });
        const hint = el('span', { class: 'ph-hint' });
        const check = () => {
          c.phone = phone.value;
          hint.textContent = !c.phone ? '' : phoneOk(c.phone) ? '✓' : '형식 오류';
          hint.style.color = phoneOk(c.phone) ? 'var(--ok)' : 'var(--danger)';
        };
        phone.addEventListener('input', check); check();
        const name = el('input', { type: 'text', value: c.name, placeholder: '이름', list: nameListId, autocomplete: 'off' });
        name.addEventListener('input', () => {
          c.name = name.value;
          const known = contactsByName[c.name.trim()];
          if (known && known.length === 1 && !phone.value) { phone.value = known[0]; check(); }
        });
        const move = d => { const t = ci + d; if (t < 0 || t >= r.contacts.length) return; [r.contacts[ci], r.contacts[t]] = [r.contacts[t], r.contacts[ci]]; render(); };
        return el('tr', {},
          el('td', { class: 'seq' }, ci === 0 ? '정' : `부${ci}`),
          el('td', {}, name),
          el('td', {}, phone, hint),
          el('td', { class: 'ops' },
            el('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: '위로', onclick: () => move(-1), disabled: ci === 0 }, '↑'),
            el('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: '아래로', onclick: () => move(1), disabled: ci === r.contacts.length - 1 }, '↓'),
            el('button', { type: 'button', class: 'btn btn-danger btn-sm', title: '삭제', onclick: () => { r.contacts.splice(ci, 1); if (!r.contacts.length) r.contacts.push({ name: '', phone: '' }); render(); } }, '✕')));
      });

      const flag = (key, label, title) => el('label', { title: title || '' },
        el('input', { type: 'checkbox', checked: r[key] === 'Y', onchange: e => { r[key] = e.target.checked ? 'Y' : 'N'; } }), ' ' + label);

      const nameInput = el('input', { type: 'text', value: r.name, placeholder: '예: OS, DBA, 기본' });
      nameInput.addEventListener('input', () => { r.name = nameInput.value; });
      const kwInput = el('input', { type: 'text', value: (r.keywords || []).join(', '), placeholder: '(선택) memo 에 포함되면 발신 — 쉼표로 구분' });
      kwInput.addEventListener('input', () => { r.keywords = kwInput.value.split(',').map(s => s.trim()).filter(Boolean); });

      return el('div', { class: 'rule-card' },
        el('div', { class: 'rule-head' },
          el('span', { class: 'rule-no' }, single ? '규칙' : `규칙 ${ri + 1}`),
          nameInput,
          single ? null : el('button', { type: 'button', class: 'btn btn-danger btn-sm', disabled: rules.length === 1,
            onclick: () => { if (confirm(`'${r.name || '규칙'}' 규칙을 삭제할까요?`)) { rules.splice(ri, 1); render(); } } }, '규칙 삭제')),
        el('div', { class: 'field' }, el('label', { text: 'metric 조건' }), metricChips,
          el('div', { class: 'rule-row' }, metricInput,
            el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => addMetric(metricInput.value) }, '추가'),
            QUICK.map(q => el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => addMetric(q) }, q === '*' ? '* 전체' : q))),
          el('div', { class: 'hint' }, "'*' 는 아무 문자열. 예) *사용률 = 모든 사용률, riv_app.log* = riv_app.log 로 시작하는 로그. 끝의 ' 이벤트 탐지' 는 자동 무시")),
        el('div', { class: 'field' }, el('label', { text: 'memo 키워드' }), kwInput),
        el('div', { class: 'checkrow' },
          flag('DAY', '주간 (09~18시)'), flag('NIGHT', '야간'),
          flag('any_level', '등급 무관 발신', '체크 안 하면 event_cd 가 "심각" 인 이벤트만 발신. 로그 패턴 규칙은 보통 체크')),
        el('div', { class: 'field' }, el('label', { text: '담당자 (위에서부터 순서대로: 각 60초 간격 3회 미응답 시 다음 사람)' }),
          el('table', { class: 'contact-tbl' },
            el('thead', {}, el('tr', {}, el('th', {}, '순위'), el('th', {}, '이름'), el('th', {}, '핸드폰번호'), el('th', {}, ''))),
            el('tbody', {}, contactRows)),
          el('button', { type: 'button', class: 'btn btn-outline btn-sm', style: 'margin-top:8px',
            onclick: () => { r.contacts.push({ name: '', phone: '' }); render(); } }, '+ 담당자(부담당) 추가')));
    }

    function render() {
      root.replaceChildren(metricList, nameList, ...rules.map(renderRule),
        single ? '' : el('button', { type: 'button', class: 'btn btn-outline', onclick: () => { rules.push(blankRule(rules.length + 1)); render(); } }, '+ 규칙 추가'));
    }
    render();

    return {
      getRules() {
        return rules.map(r => ({ ...r, contacts: r.contacts.filter(c => (c.name || '').trim() || (c.phone || '').trim()) }));
      },
      setRules(next) { rules = next.map(r => JSON.parse(JSON.stringify(r))); render(); },
    };
  }

  window.RuleEditor = { mount, blankRule };
})();
