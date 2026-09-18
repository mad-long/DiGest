const { createDomShim, getAppCode } = require('./dom-shim');
const { makeRunner } = require('./test-runner');

createDomShim();
const { T, report } = makeRunner();
global.T = T;

const testsCode = `
  state.symptoms = [
    { id:'s1', name:'Ballonnements', color:SYMPTOM_PALETTE[0], archived:false },
    { id:'s2', name:'Migraine', color:SYMPTOM_PALETTE[1], archived:false }
  ];
  state.agenda = {};

  T("saveAgendaEntry refuse une entrée totalement vide", () => {
    selectedDate = '2026-08-08';
    pendingAgendaSymptoms = new Set(); pendingAgendaGauges = {};
    document.getElementById('agendaNote').value = '';
    saveAgendaEntry();
    return !state.agenda['2026-08-08'];
  });

  T("saveAgendaEntry accepte une entrée avec une simple note", () => {
    document.getElementById('agendaNote').value = 'une note';
    saveAgendaEntry();
    return state.agenda['2026-08-08'] && state.agenda['2026-08-08'][0].kind === 'symptom';
  });

  T("saveAgendaRdv refuse sans nom", () => {
    const before = (state.agenda['2026-08-08']||[]).length;
    document.getElementById('rdvName').value = '';
    saveAgendaRdv();
    return (state.agenda['2026-08-08']||[]).length === before;
  });

  T("saveAgendaRdv accepte avec un nom, et un rdv se range sous SA propre date", () => {
    selectedDate = '2026-08-08';
    document.getElementById('rdvName').value = 'Consultation aujourd\\'hui';
    saveAgendaRdv();
    selectedDate = '2026-08-09';
    document.getElementById('rdvName').value = 'Consultation demain';
    saveAgendaRdv();
    return (state.agenda['2026-08-08']||[]).some(e=>e.kind==='appointment')
        && (state.agenda['2026-08-09']||[]).some(e=>e.kind==='appointment');
  });

  T("toggleQuickSymptom (le pansement) crée puis retire proprement", () => {
    state.agenda = {};
    toggleQuickSymptom('s1');
    const today = todayKey();
    const hasIt = (state.agenda[today]||[]).some(e => e.quickLog && e.symptomIds.includes('s1'));
    toggleQuickSymptom('s1');
    const stillThere = (state.agenda[today]||[]);
    return hasIt && stillThere.length === 0;
  });

  T("toggleQuickSymptom n'interfère jamais avec une entrée manuelle du même jour", () => {
    const today = todayKey();
    state.agenda[today] = [{ id:'manual', kind:'symptom', symptomIds:['s2'], note:'note manuelle', gauges:{} }];
    toggleQuickSymptom('s1');
    return state.agenda[today].length === 2 && state.agenda[today][0].note === 'note manuelle';
  });

  T("dayActivityCategories distingue bien les 4 catégories", () => {
    const entries = [
      { kind:'food-log', label:'Poivron' },
      { kind:'recipe-log', label:'Curry' },
      { kind:'symptom', symptomIds:['s1'] },
      { kind:'appointment', name:'RDV' },
    ];
    const cats = dayActivityCategories(entries);
    return cats.food && cats.recipe && cats.symptom && cats.rdv;
  });

  T("dayActivityCategories : entrées pré-migration (sans kind) comptent comme symptôme", () => {
    const cats = dayActivityCategories([{ symptomIds:['s1'] }]);
    return cats.symptom === true && !cats.food && !cats.recipe && !cats.rdv;
  });

  T("renderCalendar ne plante pas sur un mois avec des données mixtes", () => {
    renderCalendar();
    return true;
  });
`;

(0, eval)(getAppCode() + '\n' + testsCode);

const { pass, total } = report('Agenda');
process.exitCode = (pass === total) ? 0 : 1;
