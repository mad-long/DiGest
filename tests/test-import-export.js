const { createDomShim, getAppCode } = require('./dom-shim');
const { makeRunner } = require('./test-runner');

createDomShim();
const { T, report } = makeRunner();
global.T = T;
global.require = require;
global.__testDirname = __dirname;

const testsCode = `
  T("export/import round-trip préserve les données", () => {
    state.foods = [{ id:'x', type:'food', name:'Carotte', symptoms:[], cooking:[{name:'vapeur',count:2}], assoc:[], favorite:true, count:4 }];
    const { medications, pathologies, ...exportable } = state;
    const clean = sanitizeImportedState(JSON.parse(JSON.stringify(exportable)));
    return clean.foods[0].name === 'Carotte' && clean.foods[0].cooking[0].count === 2;
  });

  T("export standard : redactRdvFieldsForExport retire nom/lieu/notes, garde heure/type", () => {
    const redacted = redactRdvFieldsForExport({
      '2026-08-08': [{ id:'r1', kind:'appointment', name:'Dr Martin', time:'14:30', doctorType:'Gastro-entérologue', location:'12 rue X', notes:'sensible' }]
    });
    const rdv = redacted['2026-08-08'][0];
    return rdv.name === '' && rdv.location === '' && rdv.notes === '' && rdv.time === '14:30' && rdv.doctorType === 'Gastro-entérologue';
  });

  T("redactRdvFieldsForExport ne touche pas aux entrées symptôme", () => {
    const redacted = redactRdvFieldsForExport({
      '2026-08-08': [{ id:'s1', kind:'symptom', note:'ballonnements', symptomIds:[], gauges:{} }]
    });
    return redacted['2026-08-08'][0].note === 'ballonnements';
  });

  T("import : le kind food-log/recipe-log n'est plus écrasé en 'symptom' (régression corrigée)", () => {
    const clean = sanitizeImportedState({
      symptoms: [], foods: [],
      agenda: { '2026-08-08': [ { id:'a', kind:'food-log', label:'Tomate' }, { id:'b', kind:'recipe-log', label:'Soupe' } ] }
    });
    const entries = clean.agenda['2026-08-08'];
    return entries[0].kind === 'food-log' && entries[0].label === 'Tomate'
        && entries[1].kind === 'recipe-log' && entries[1].label === 'Soupe';
  });

  T("import : un objet vide/corrompu ne fait pas planter la validation", () => {
    const clean = sanitizeImportedState({});
    return Array.isArray(clean.foods) && Array.isArray(clean.symptoms);
  });

  T("sécurité : les labels agenda sont bien échappés à l'affichage (pas d'injection)", () => {
    state.agenda = {};
    logDailyActivity('food-log', '<img src=x onerror=alert(1)>');
    selectedDate = todayKey();
    renderAgendaDaySummary();
    const html = document.getElementById('agendaDaySummary').innerHTML;
    return !html.includes('<img') && html.includes('&lt;img');
  });

  T("aucun eval()/Function() dynamique dans app.js", () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__testDirname, '..', 'app.js'), 'utf-8');
    return !/\\beval\\(/.test(src) && !/new Function\\(/.test(src);
  });
`;

(0, eval)(getAppCode() + '\n' + testsCode);

const { pass, total } = report('Import/Export & Sécurité des données');
process.exitCode = (pass === total) ? 0 : 1;
