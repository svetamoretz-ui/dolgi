/* The statement history keeps a snapshot of what was issued. The payment ledger
   remains the source of truth for balances and for payments linked to a statement. */
const billingFlow = {
  history: [],
  historyOrgId: null,
  selectedStatementId: null,
  unsubscribeHistory: null,
  issueInProgress: false,
  issuedSelection: '',
  transfer: null
};
const billingElement = (id) => document.getElementById(id);
const statementCollection = () => db.collection('billingStatements');
const paymentCollection = () => db.collection('payments');
const timestampForBilling = () => firebase.firestore.FieldValue.serverTimestamp();
const amountLabel = (cents) => billingMoney.format(cents / 100);
const centsAsInput = (cents) => String(cents / 100).replace('.', ',');

function readMoneyCents(value) {
  const raw = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function formatStatement(lines, total) {
  return [...lines.map(line => `${line.objectName} — ${line.workName}, ${amountLabel(line.cents)}`),
    `Итого к оплате — ${amountLabel(total)}`].join('\n');
}

function workflowStatus(id, text, error = false) {
  const element = billingElement(id);
  element.textContent = text;
  element.toggleAttribute('data-error', error);
}

function openBillingWorkflow(id) {
  openOv(id);
  billingElement('app').inert = true;
  billingElement(id).querySelector('[data-close-workflow]').focus({preventScroll:true});
}

function stopBillingHistory() {
  billingFlow.unsubscribeHistory?.();
  billingFlow.unsubscribeHistory = null;
  billingFlow.historyOrgId = null;
  billingFlow.selectedStatementId = null;
  billingFlow.history = [];
}

function resetBillingWorkflows() {
  stopBillingHistory();
  if (!billingFlow.transfer?.saving) billingFlow.transfer = null;
}

function closeBillingWorkflow(id, restoreFocus = true) {
  if (id === 'transferOv' && billingFlow.transfer?.saving) return;
  if (id === 'billHistoryOv') stopBillingHistory();
  if (id === 'transferOv') billingFlow.transfer = null;
  closeOv(id);
  billingElement('app').inert = false;
  if (restoreFocus) {
    if (id === 'paymentCompanyOv') {billingElement('payFab').focus({preventScroll:true});return;}
    const selector = id === 'billHistoryOv' ? '.history-action' : '[onclick="openGroupPayment()"]';
    billingElement('companyActions').querySelector(selector)?.focus({preventScroll:true});
  }
}

function billingSelectionKey(draft) {
  return JSON.stringify([draft.orgId, draft.lines.map(line => [line.workId, line.cents, line.objectName, line.workName])]);
}

function billingDraftKey(orgId) { return `sk:billing-draft:${orgId}`; }

function getLocalBillingDraft(orgId) {
  try {
    const saved = JSON.parse(localStorage.getItem(billingDraftKey(orgId)));
    return saved?.id && Array.isArray(saved.lines) ? saved : null;
  } catch { return null; }
}

function rememberBillingDraft(draft) {
  const prior = getLocalBillingDraft(draft.orgId);
  const key = billingSelectionKey(draft);
  const record = prior?.key === key ? prior : {id:statementCollection().doc().id, key, lines:draft.lines};
  try { localStorage.setItem(billingDraftKey(draft.orgId), JSON.stringify(record)); } catch { /* optional device storage */ }
  return record;
}

function restoreBillingDraft() {
  const saved = getLocalBillingDraft(billingOrgId);
  if (!saved) return;
  const savedAmounts = new Map(saved.lines.map(line => [line.workId, line.cents]));
  for (const row of billingElement('billingWorks').querySelectorAll('.bill-row')) {
    const amount = savedAmounts.get(row.dataset.workId);
    if (!Number.isSafeInteger(amount) || amount <= 0) continue;
    row.querySelector('input[type=checkbox]').checked = true;
    row.querySelector('.bill-money input').value = centsAsInput(amount);
  }
}

function updateBillIssueButton(draft) {
  billingElement('billIssue').disabled = !draft || billingFlow.issueInProgress || billingFlow.issuedSelection === billingSelectionKey(draft);
  for (const toggle of billingElement('billingWorks').querySelectorAll('[data-bill-select-object]')) {
    const boxes = Array.from(toggle.parentElement.querySelectorAll('[data-known=true] input[type=checkbox]'));
    const allChecked = boxes.length > 0 && boxes.every(box => box.checked);
    toggle.setAttribute('aria-pressed', String(allChecked));
    toggle.textContent = allChecked ? 'Снять выбор с работ с суммой' : 'Выбрать все с суммой';
  }
}

async function markStatementIssued() {
  const draft = updateBilling();
  if (!draft || billingFlow.issueInProgress || billingFlow.issuedSelection === billingSelectionKey(draft)) return;
  if (new TextEncoder().encode(JSON.stringify(draft)).length > 750000) {
    billingStatus('Список слишком большой. Раздели работы на несколько счетов.', true);
    return;
  }
  const local = rememberBillingDraft(draft);
  const reference = statementCollection().doc(local.id);
  const issuedOn = today();
  billingFlow.issueInProgress = true;
  updateBillIssueButton(draft);
  billingStatus('Сохраняется в истории…');
  try {
    await db.runTransaction(async transaction => {
      const existing = await transaction.get(reference);
      if (existing.exists) return;
      transaction.set(reference, {...draft, issuedOn, createdAt:timestampForBilling()});
    });
    billingFlow.issuedSelection = local.key;
    const savedNow = getLocalBillingDraft(draft.orgId);
    if (savedNow?.id === local.id) {
      try { localStorage.removeItem(billingDraftKey(draft.orgId)); } catch { /* optional device storage */ }
    }
    billingStatus('Счёт добавлен в историю. Долг уменьшится после оплаты.');
  } catch (error) {
    billingStatus(error.code === 'permission-denied' ? 'Firebase ограничил доступ к истории счетов. Список можно скопировать.' : 'Счёт не удалось сохранить. Проверь связь и повтори.', true);
  } finally {
    billingFlow.issueInProgress = false;
    const status = billingElement('billStatus');
    const message = status.textContent;
    const isError = status.hasAttribute('data-error');
    updateBilling();
    if (billingOrgId === draft.orgId) billingStatus(message, isError);
  }
}

function statementPaidByWork(statement) {
  const paidByWork = new Map();
  for (const line of statement.lines) {
    const paid = (ALL.pays[line.workId] || []).filter(p => p.statementId === statement.id)
      .reduce((total, payment) => total + Math.round(payment.amount * 100), 0);
    paidByWork.set(line.workId, paid);
  }
  return paidByWork;
}

function statementBalance(statement) {
  const paidByWork = statementPaidByWork(statement);
  return statement.lines.reduce((sum, line) => sum + Math.max(0, line.cents - (paidByWork.get(line.workId) || 0)), 0);
}

function statementStatus(remaining, total) {
  return remaining === 0 ? 'Оплачен' : remaining < total ? 'Частично оплачен' : 'Выставлен';
}

function openBillingHistory(statementId = null) {
  if (!curOrg) return;
  stopBillingHistory();
  billingFlow.historyOrgId = curOrg.id;
  billingFlow.selectedStatementId = statementId;
  billingElement('billHistoryOrg').textContent = curOrg.name;
  billingElement('billHistoryList').replaceChildren();
  billingElement('billHistoryDetail').hidden = true;
  workflowStatus('billHistoryStatus', 'Загрузка истории…');
  openBillingWorkflow('billHistoryOv');
  const orgId = curOrg.id;
  billingFlow.unsubscribeHistory = statementCollection().where('orgId', '==', orgId).onSnapshot(snapshot => {
    if (billingFlow.historyOrgId !== orgId) return;
    billingFlow.history = snapshot.docs.map(document => ({...document.data(), id:document.id}))
      .filter(statement => Array.isArray(statement.lines) && Number.isSafeInteger(statement.totalCents))
      .sort((a, b) => (b.issuedOn || '').localeCompare(a.issuedOn || '') || (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    workflowStatus('billHistoryStatus', billingFlow.history.length ? '' : 'Здесь появятся списки, отмеченные как выставленные.');
    renderBillingHistory();
  }, error => {
    if (billingFlow.historyOrgId !== orgId) return;
    workflowStatus('billHistoryStatus', error.code === 'permission-denied' ? 'Firebase ограничил доступ к истории счетов.' : 'Не удалось загрузить историю счетов. Попробуй открыть её ещё раз.', true);
  });
}

function selectedBillingStatement() {
  return billingFlow.history.find(statement => statement.id === billingFlow.selectedStatementId);
}

function renderBillingHistory() {
  if (!billingFlow.historyOrgId) return;
  const statement = selectedBillingStatement();
  const list = billingElement('billHistoryList');
  list.hidden = Boolean(statement);
  billingElement('billHistoryDetail').hidden = !statement;
  if (statement) {
    const remaining = statementBalance(statement);
    billingElement('billHistoryMeta').textContent = `${fmtD(statement.issuedOn)} · ${statementStatus(remaining, statement.totalCents)} · Остаток ${amountLabel(remaining)}`;
    billingElement('billHistoryText').value = statement.text || formatStatement(statement.lines, statement.totalCents);
    billingElement('billHistoryPay').hidden = remaining <= 0;
    billingElement('billHistoryPay').disabled = !billingSourceReady.payments;
    return;
  }
  const buttons = billingFlow.history.map(record => {
    const remaining = statementBalance(record);
    const button = document.createElement('button');
    button.type = 'button';button.className = 'history-record';button.dataset.statementId = record.id;
    const amount = document.createElement('strong');
    amount.textContent = amountLabel(record.totalCents);
    const meta = document.createElement('span');
    meta.textContent = `${fmtD(record.issuedOn)} · ${statementStatus(remaining, record.totalCents)} · ${record.lines.length} ${plural(record.lines.length,'работа','работы','работ')}`;
    button.append(amount, meta);
    return button;
  });
  list.replaceChildren(...buttons);
}

async function copyStatementFromHistory() {
  const field = billingElement('billHistoryText');
  try {
    await navigator.clipboard.writeText(field.value);
    workflowStatus('billHistoryStatus', 'Список скопирован.');
  } catch {
    field.focus();field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* clipboard is restricted */ }
    workflowStatus('billHistoryStatus', copied ? 'Список скопирован.' : 'Текст выделен. Скопируй его вручную.');
  }
}

function transferCandidates(orgId, statement) {
  const paid = statement ? statementPaidByWork(statement) : new Map();
  const planned = statement ? statement.lines : orgObjs(orgId).flatMap(object =>
    objWorks(object.id).map(work => ({workId:work.id,objId:object.id,workName:work.name,objectName:object.name})));
  return planned.flatMap(line => {
    const work = ALL.works.find(entry => entry.id === line.workId);
    if (!work || work.objId !== line.objId || work.amount == null) return [];
    const available = Math.round(workRemaining(work) * 100);
    const remaining = statement ? Math.max(0, line.cents - (paid.get(work.id) || 0)) : available;
    const limit = Math.min(available, remaining);
    return limit > 0 ? [{...line, workId:work.id, limit}] : [];
  });
}

function renderPaymentCompanies() {
  const query = billingElement('paymentCompanySearch').value.trim().toLocaleLowerCase('ru-RU');
  const list = billingElement('paymentCompanyList');
  const companies = orgs.filter(company => String(company.name).toLocaleLowerCase('ru-RU').includes(query))
    .map(company => ({company,debt:orgDebt(company.id)}));
  companies.sort((a,b) => Number(b.debt>0)-Number(a.debt>0) || a.company.name.localeCompare(b.company.name,'ru'));
  const buttons = companies.map(({company,debt}) => {
    const works = orgObjs(company.id).flatMap(object => objWorks(object.id));
    const hasUnknown = works.some(work => work.amount==null);
    const button = document.createElement('button');
    button.type='button';button.className='payment-company';button.dataset.payCompany=company.id;
    const details = document.createElement('span');
    const name = document.createElement('strong');name.textContent=company.name;
    const status = document.createElement('small');
    status.textContent=debt>0?'К получению':hasUnknown?'Есть работы с неуточнённой суммой':'По текущим объектам долга нет';
    details.append(name,status);button.append(details);
    if(debt>0){
      const amount=document.createElement('span');amount.className='payment-company-amount';amount.textContent=billingMoney.format(debt);button.append(amount);
    }
    return button;
  });
  list.replaceChildren(...buttons);
  if(!buttons.length){
    const message=document.createElement('p');message.className='bill-empty';message.textContent=query?'Компании с таким названием не найдены.':'Пока нет компаний.';list.append(message);
  }
}

function openPaymentCompanies() {
  if (!Object.values(billingSourceReady).every(Boolean)) {
    alert('Дождись загрузки объектов, работ и оплат.');
    return;
  }
  billingElement('paymentCompanySearch').value='';
  renderPaymentCompanies();
  openBillingWorkflow('paymentCompanyOv');
  billingElement('paymentCompanyList').parentElement.scrollTop=0;
}

function openGroupPayment(statement = null, fromCompanyPicker = false) {
  if (!curOrg) return;
  if (!Object.values(billingSourceReady).every(Boolean)) {
    alert('Дождись загрузки объектов, работ и оплат.');
    return;
  }
  if (statement) closeBillingWorkflow('billHistoryOv', false);
  const rows = transferCandidates(curOrg.id, statement);
  billingFlow.transfer = { id:paymentCollection().doc().id, orgId:curOrg.id, statement, rows:new Map(rows.map(row=>[row.workId,row])), saving:false };
  billingElement('transferOrg').textContent = curOrg.name + (statement ? ` · Счёт от ${fmtD(statement.issuedOn)}` : '');
  billingElement('transferAmount').value = '';
  billingElement('transferDate').value = today();
  billingElement('transferSingle').hidden = Boolean(statement);
  billingElement('transferChangeCompany').hidden = !fromCompanyPicker;
  const list = billingElement('transferWorks');
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'transfer-unavailable';
    empty.textContent = 'Нет работ с остатком и известной суммой для распределения.';
    list.append(empty);
  }
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.objId)) {
      const group=document.createElement('fieldset');group.className='bill-object';
      const heading=document.createElement('legend');heading.textContent=row.objectName;group.append(heading);
      groups.set(row.objId,group);list.append(group);
    }
    const element = document.createElement('div');
    element.className = 'bill-row';
    element.dataset.transferWork = row.workId;
    element.innerHTML = '<label><input type="checkbox"><span><strong></strong><small></small></span></label><div class="bill-money"><input class="fi" type="text" inputmode="decimal" autocomplete="off"><span aria-hidden="true">₽</span></div>';
    element.querySelector('strong').textContent = row.workName;
    element.querySelector('small').textContent = `Остаток ${amountLabel(row.limit)}`;
    element.querySelector('input[type=checkbox]').checked = Boolean(statement);
    element.querySelector('.bill-money input').setAttribute('aria-label', `В оплату, ${row.objectName} — ${row.workName}, ₽`);
    groups.get(row.objId).append(element);
  }
  workflowStatus('transferStatus', '');
  updateTransfer();
  openBillingWorkflow('transferOv');
  billingElement('transferBody').scrollTop = 0;
}

function readTransfer() {
  const total = readMoneyCents(billingElement('transferAmount').value);
  const dateInput = billingElement('transferDate');
  const allocations = [];
  let assigned = 0, invalid = false;
  const transfer = billingFlow.transfer;
  for (const element of billingElement('transferWorks').querySelectorAll('[data-transfer-work]')) {
    const checked = element.querySelector('input[type=checkbox]').checked;
    const input = element.querySelector('.bill-money input');
    input.disabled = !checked || transfer.saving;
    input.removeAttribute('aria-invalid');
    if (!checked || !input.value.trim()) continue;
    const cents = readMoneyCents(input.value);
    const row = transfer.rows.get(element.dataset.transferWork);
    if (cents === null || cents > row.limit || !Number.isSafeInteger(assigned + cents)) {
      invalid = true;
      input.setAttribute('aria-invalid','true');
      continue;
    }
    if (!cents) continue;
    allocations.push({...row, cents});
    assigned += cents;
  }
  return {total, date:dateInput.value, allocations, assigned, invalid, valid:total > 0 && Boolean(dateInput.value) && dateInput.validity.valid && !invalid && assigned === total};
}

function updateTransfer() {
  const transfer = billingFlow.transfer;
  if (!transfer) return;
  const values = readTransfer();
  const difference = (values.total || 0) - values.assigned;
  const assignment = values.invalid ? 'Есть суммы, которые нужно исправить.' : (difference < 0 ? `Распределено лишних ${amountLabel(-difference)}` : `Осталось распределить ${amountLabel(difference)}`);
  const totals = billingElement('transferTotals');
  totals.replaceChildren();
  const assigned = document.createElement('strong');
  assigned.textContent = `Распределено ${amountLabel(values.assigned)}`;
  const remainder = document.createElement('span');
  remainder.textContent = assignment;
  totals.append(assigned,remainder);
  billingElement('transferSave').disabled = !values.valid || transfer.saving;
  const selected = billingElement('transferWorks').querySelector('input[type=checkbox]:checked');
  billingElement('transferAllocate').disabled = !selected || !(values.total > 0) || transfer.saving;
  return values;
}

function suggestTransferAllocation() {
  const transfer = billingFlow.transfer;
  let left = readMoneyCents(billingElement('transferAmount').value);
  if (!transfer || transfer.saving || !(left > 0)) return;
  const items = billingElement('transferWorks').querySelectorAll('[data-transfer-work]');
  items.forEach(element => {
    if (!element.querySelector('input[type=checkbox]').checked) return;
    const cents = Math.min(transfer.rows.get(element.dataset.transferWork).limit, left);
    element.querySelector('.bill-money input').value = cents > 0 ? centsAsInput(cents) : '';
    left -= cents;
  });
  workflowStatus('transferStatus', left > 0 ? 'Выбранные работы покрывают только часть перевода. Отметь ещё работы или поправь сумму.' : 'Распределено по порядку строк. Суммы можно поправить.');
  updateTransfer();
}

function paymentFields(work, amount, date, note) {
  return {workId:work.id,workName:work.name,objName:work.objName||'',orgName:work.orgName||'',amount,date,note,createdAt:timestampForBilling()};
}

function revisedPaymentWork(work, paidAfter) {
  const update = {paymentRevision:firebase.firestore.FieldValue.increment(1)};
  if (work.amount != null && paidAfter >= Math.round(work.amount * 100)) update.status = 'paid';
  else if (work.amount != null && work.status === 'clarifying') update.status = 'waiting';
  return update;
}

function saveSinglePayment(work, amount, date, note) {
  const reference = paymentCollection().doc();
  const fields = paymentFields(work, amount, date, note);
  const update = revisedPaymentWork(work, Math.round((workPaid(work.id) + amount) * 100));
  const workRef = db.collection('works').doc(work.id);
  const batch = db.batch();
  batch.set(reference, fields);
  batch.update(workRef, update);
  batch.commit().catch(async error => {
    if (error.code !== 'permission-denied') throw error;
    // A project can restrict fields on existing work documents. A denied
    // batch wrote nothing, so retry the existing payment path safely.
    await reference.set(fields);
    if (update.status) await workRef.update({status:update.status}).catch(() => alert('Оплата записана. Статус работы не обновился.'));
  }).catch(() => alert('Оплату не удалось записать. Проверь связь и попробуй снова.'));
}

function deleteSinglePayment(id) {
  const workId = Object.keys(ALL.pays).find(key => ALL.pays[key].some(payment => payment.id === id));
  const work = ALL.works.find(entry => entry.id === workId);
  const reference = paymentCollection().doc(id);
  const batch = db.batch();
  batch.delete(reference);
  if (work) {
    const update = {paymentRevision:firebase.firestore.FieldValue.increment(1)};
    const payment = ALL.pays[workId].find(entry => entry.id === id);
    if (work.amount != null && work.status === 'paid' && Math.round((workPaid(workId) - payment.amount) * 100) < Math.round(work.amount * 100)) {
      update.status = work.deadline && work.deadline < today() ? 'overdue' : 'waiting';
    }
    batch.update(db.collection('works').doc(workId), update);
  }
  batch.commit().catch(error => {
    if (error.code !== 'permission-denied') throw error;
    return reference.delete();
  }).catch(() => alert('Оплату не удалось удалить. Попробуй ещё раз.'));
}

function setTransferBusy(busy) {
  const transfer = billingFlow.transfer;
  transfer.saving = busy;
  for (const id of ['transferAmount','transferDate','transferSingle','transferChangeCompany']) billingElement(id).disabled = busy;
  billingElement('transferOv').querySelector('[data-close-workflow]').disabled = busy;
  billingElement('transferWorks').querySelectorAll('input[type=checkbox]').forEach(input => {input.disabled = busy;});
  updateTransfer();
}

async function commitGroupedPayment(transfer, values) {
  const firstPayment = paymentCollection().doc(`${transfer.id}-0`);
  const workRefs = values.allocations.map(row => db.collection('works').doc(row.workId));
  return db.runTransaction(async transaction => {
    const duplicate = await transaction.get(firstPayment);
    if (duplicate.exists) return false;
    let statementLines = new Map();
    if (transfer.statement) {
      const saved = await transaction.get(statementCollection().doc(transfer.statement.id));
      if (!saved.exists || saved.data().orgId !== transfer.orgId) throw new Error('Счёт больше недоступен. Открой историю заново.');
      statementLines = new Map(saved.data().lines.map(line => [line.workId,line.cents]));
    }
    const workSnapshots = await Promise.all(workRefs.map(ref => transaction.get(ref)));
    // Each payment writer updates its work in the same commit. The transaction
    // retries if a work changed while the matching payments were being read.
    const ledgers = await Promise.all(values.allocations.map(row => paymentCollection().where('workId','==',row.workId).get({source:'server'})));
    values.allocations.forEach((row,index) => {
      const current = workSnapshots[index];
      const work = current.exists ? {id:current.id,...current.data()} : null;
      if (!work || work.objId !== row.objId || work.orgId && work.orgId !== transfer.orgId || work.amount == null) {
        throw new Error(`Работа «${row.workName}» изменилась. Открой форму заново.`);
      }
      const existing = ledgers[index].docs.map(document => document.data());
      const paid = existing.reduce((total,payment) => total + Math.round((payment.amount || 0) * 100), 0);
      const debt = Math.max(0,Math.round(work.amount * 100) - paid);
      if (row.cents > debt) throw new Error(`По работе «${row.workName}» осталось ${amountLabel(debt)}. Открой форму заново.`);
      if (transfer.statement) {
        const applied = existing.filter(payment => payment.statementId === transfer.statement.id)
          .reduce((total,payment) => total + Math.round(payment.amount * 100), 0);
        const remaining = Math.max(0,(statementLines.get(row.workId) || 0) - applied);
        if (row.cents > remaining) throw new Error(`По счёту за «${row.workName}» осталось ${amountLabel(remaining)}. Открой форму заново.`);
      }
      const payment = {...paymentFields(work,row.cents / 100,values.date,null),groupId:transfer.id};
      if (transfer.statement) payment.statementId = transfer.statement.id;
      transaction.set(paymentCollection().doc(`${transfer.id}-${index}`),payment);
      transaction.update(workRefs[index],revisedPaymentWork(work,paid + row.cents));
    });
    return true;
  });
}

async function saveGroupedPayment() {
  const transfer = billingFlow.transfer;
  if (!transfer || transfer.saving) return;
  const values = updateTransfer();
  if (!values.valid) return;
  if (values.allocations.length > 150) {
    workflowStatus('transferStatus','В одном поступлении может быть до 150 работ.',true);
    return;
  }
  setTransferBusy(true);
  workflowStatus('transferStatus','Проверяем остатки и записываем поступление…');
  try {
    const created = await commitGroupedPayment(transfer, values);
    setTransferBusy(false);
    closeBillingWorkflow('transferOv');
    buzz();
    const feedback = created ? `Поступление ${amountLabel(values.total)} записано.` : 'Это поступление уже записано.';
    if (transfer.statement) {
      openBillingHistory(transfer.statement.id);
      workflowStatus('billHistoryStatus',feedback);
    } else {
      const status = billingElement('companyMessage');
      status.textContent = feedback;status.hidden = false;
    }
  } catch (error) {
    setTransferBusy(false);
    const text = error.code ? 'Поступление не записано. Проверь подключение и попробуй снова.' : error.message;
    workflowStatus('transferStatus',text,true);
  }
}

billingElement('billIssue').addEventListener('click',markStatementIssued);
billingElement('billingWorks').addEventListener('click',event => {
  const toggle = event.target.closest('[data-bill-select-object]');
  if (!toggle) return;
  const next = toggle.getAttribute('aria-pressed') !== 'true';
  toggle.parentElement.querySelectorAll('[data-known=true] input[type=checkbox]').forEach(box => {box.checked = next;});
  updateBilling();
});
billingElement('billHistoryList').addEventListener('click',event => {
  const row = event.target.closest('[data-statement-id]');
  if (!row) return;
  billingFlow.selectedStatementId = row.dataset.statementId;
  workflowStatus('billHistoryStatus','');
  renderBillingHistory();
});
billingElement('billHistoryBack').addEventListener('click',() => {
  billingFlow.selectedStatementId = null;
  workflowStatus('billHistoryStatus','');
  renderBillingHistory();
});
billingElement('billHistoryCopy').addEventListener('click',copyStatementFromHistory);
billingElement('billHistoryPay').addEventListener('click',() => {
  const statement = selectedBillingStatement();
  if (statement) openGroupPayment(statement);
});
document.addEventListener('payments:updated',renderBillingHistory);
for (const id of ['transferAmount','transferDate','transferWorks']) billingElement(id).addEventListener('input',() => {
  if (billingFlow.transfer?.saving) return;
  workflowStatus('transferStatus','');
  updateTransfer();
});
billingElement('transferAllocate').addEventListener('click',suggestTransferAllocation);
billingElement('transferSave').addEventListener('click',saveGroupedPayment);
billingElement('transferSingle').addEventListener('click',() => {closeBillingWorkflow('transferOv',false);onPay();});
billingElement('transferChangeCompany').addEventListener('click',() => {
  closeBillingWorkflow('transferOv',false);
  goBack();
  openPaymentCompanies();
});
billingElement('paymentCompanySearch').addEventListener('input',renderPaymentCompanies);
billingElement('paymentCompanyList').addEventListener('click',event => {
  const button=event.target.closest('[data-pay-company]');
  if(!button||!orgs.some(company=>company.id===button.dataset.payCompany))return;
  closeBillingWorkflow('paymentCompanyOv',false);
  openOrg(button.dataset.payCompany);
  openGroupPayment(null,true);
});
for (const id of ['billHistoryOv','transferOv','paymentCompanyOv']) {
  const overlay = billingElement(id);
  overlay.querySelector('[data-close-workflow]').addEventListener('click',() => closeBillingWorkflow(id));
  overlay.addEventListener('keydown',event => {if (event.key === 'Escape') closeBillingWorkflow(id);});
}
