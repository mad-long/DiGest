const { createDomShim, getAppCode } = require('./dom-shim');
const { makeRunner } = require('./test-runner');

createDomShim();
const { T, report } = makeRunner();
global.T = T;
global.report = report;

const testsCode = `
  (async () => {
    T("PBKDF2 : round-trip chiffrement/déchiffrement OK", async () => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey('motdepasse-test', salt);
      const payload = await aesEncryptJSON(key, { hello: 'world' });
      const decrypted = await aesDecryptJSON(key, payload.iv, payload.data);
      return decrypted.hello === 'world';
    });

    await T("PBKDF2 : un mauvais mot de passe échoue proprement", async () => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey('bon-mdp', salt);
      const payload = await aesEncryptJSON(key, { secret: 42 });
      try {
        const wrongKey = await deriveKey('mauvais-mdp', salt);
        await aesDecryptJSON(wrongKey, payload.iv, payload.data);
        return false; // n'aurait jamais dû réussir
      } catch(e) { return true; }
    });

    await T("persist() : les écritures rapprochées restent dans le bon ordre", async () => {
      sessionCryptoKey = null;
      state = { symptoms:[], foods:[{name:'v1'}], recipeBook:[], gaugeTypes:[], agenda:{}, medications:[], pathologies:[] };
      persist();
      state = { symptoms:[], foods:[{name:'v2'}], recipeBook:[], gaugeTypes:[], agenda:{}, medications:[], pathologies:[] };
      await persist();
      const raw = JSON.parse(localStorage.getItem('intolerances_v1'));
      return raw.foods[0].name === 'v2';
    });

    await T("Export Médecin : exclut toujours médicaments et pathologies", () => {
      state.medications = [{id:'m1', name:'SecretMed'}];
      state.pathologies = [{id:'p1', name:'SecretPatho'}];
      state.foods = []; state.symptoms = []; state.agenda = {};
      global.window.print = () => {};
      generateDoctorExport();
      const html = document.getElementById('doctorExportPrintView').innerHTML;
      return !html.includes('SecretMed') && !html.includes('SecretPatho');
    });

    const { pass, total } = global.report('Sécurité & Export Médecin');
    process.exitCode = (pass === total) ? 0 : 1;
  })();
`;

(0, eval)(getAppCode() + '\n' + testsCode);
