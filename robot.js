const { chromium } = require('playwright');
const admin = require('firebase-admin');

// =========================
// 1) FIREBASE ADMIN INIT
// =========================
if (process.env.FIREBASE_PRIVATE_KEY) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  } catch (err) {
    console.error("❌ Error inicializando Firebase:", err.message);
    process.exit(1);
  }
} else {
  console.error("⚠️ FALTAN LAS CLAVES DE FIREBASE");
  process.exit(1);
}

const db = admin.firestore();

// =========================
// 2) CONFIG
// =========================
const COLLECTION_NAME = "homeserve_pendientes";

// ✅ Aquí es donde la web guardará credenciales por proveedor
// Firestore: providerConfigs/homeserve { user, pass }
const PROVIDER_CONFIG_COLLECTION = "providerConfigs";
const PROVIDER_ID = "homeserve";

// =========================
// 3) HELPERS
// =========================
async function loadProviderCredentials(providerId) {
  try {
    const snap = await db.collection(PROVIDER_CONFIG_COLLECTION).doc(providerId).get();
    if (!snap.exists) {
      console.log(`⚠️ No existe config en Firestore: ${PROVIDER_CONFIG_COLLECTION}/${providerId}`);
      return null;
    }

    const data = snap.data() || {};
    const user = (data.user || "").trim();
    const pass = (data.pass || "").trim();

    if (!user || !pass) {
      console.log(`⚠️ Config incompleta en Firestore: falta user/pass en ${PROVIDER_CONFIG_COLLECTION}/${providerId}`);
      return null;
    }

    console.log(`✅ Credenciales cargadas desde Firestore (${PROVIDER_CONFIG_COLLECTION}/${providerId}) user="${user}" pass="***"`);
    return { user, pass };
  } catch (err) {
    console.error("❌ Error leyendo credenciales de Firestore:", err.message);
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

// =========================
// 4) ROBOT
// =========================
async function runRobot() {
  console.log('🤖 [V6.3] Arrancando robot (Credenciales desde Firestore + Limpieza Teléfono)...');

  // ✅ Cargar credenciales desde Firestore
  const creds = await loadProviderCredentials(PROVIDER_ID);

  // Fallback a env si Firestore no tiene nada (por si acaso)
  const HS_USER = creds?.user || (process.env.HOMESERVE_USER || "");
  const HS_PASS = creds?.pass || (process.env.HOMESERVE_PASS || "");

  if (!HS_USER || !HS_PASS) {
    console.error("❌ No hay credenciales de HomeServe. (Ni en Firestore ni en ENV).");
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // --- PASO 1: LOGIN ---
    console.log('🔐 Entrando al login...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=PROF_PASS', { timeout: 60000 });

    const selectorUsuario = 'input[name="CODIGO"]';
    const selectorPass = 'input[type="password"]';

    if (await page.isVisible(selectorUsuario)) {
      // Limpia por si el navegador autocompleta basura
      await page.fill(selectorUsuario, "");
      await page.fill(selectorPass, "");

      // Escribe credenciales
      await page.type(selectorUsuario, HS_USER, { delay: 60 });
      await page.type(selectorPass, HS_PASS, { delay: 60 });

      console.log('👆 Pulsando ENTER...');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
    } else {
      console.log("ℹ️ No veo el formulario de login (puede que ya esté logueado o haya cambiado la pantalla).");
    }

    // --- PASO 2: OBTENER LISTA ---
    console.log('📂 Leyendo lista de servicios...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total', { timeout: 60000 });

    const referenciasEnWeb = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('table tr'));
      const refs = [];
      filas.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length > 5) {
          let ref = tds[0]?.innerText?.trim();
          if (ref && !isNaN(ref.replace(/\D/g, '')) && ref.length > 3) {
            refs.push(ref);
          }
        }
      });
      return refs;
    });

    console.log(`🔎 Encontrados ${referenciasEnWeb.length} servicios.`);

    // --- PASO 3: PROCESAR UNO A UNO ---
    let actualizados = 0;
    let nuevos = 0;

    for (const ref of referenciasEnWeb) {

      const docRef = db.collection(COLLECTION_NAME).doc(ref);
      const docSnapshot = await docRef.get();
      const datosAntiguos = docSnapshot.exists ? docSnapshot.data() : null;

      // Navegar a la lista y hacer click (refrescar sesión y datos)
      await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total', { timeout: 60000 });
      try {
        await page.click(`text="${ref}"`);
        await page.waitForTimeout(1500);
      } catch (e) {
        console.error(`⚠️ No pude entrar en ficha ${ref}.`);
        continue;
      }

      // --- SCRAPING CON LIMPIEZA DE TELÉFONO ---
      const detalles = await page.evaluate(() => {
        const d = {};
        const filas = Array.from(document.querySelectorAll('tr'));
        filas.forEach(tr => {
          const celdas = tr.querySelectorAll('td');
          if (celdas.length >= 2) {
            const clave = celdas[0].innerText.toUpperCase().trim();
            const valor = celdas[1].innerText.trim();

            if (clave.includes("TELEFONOS")) {
              const match = valor.match(/[6789]\d{8}/);
              d.phone = match ? match[0] : valor;
            }

            if (clave.includes("CLIENTE")) d.clientName = valor;
            if (clave.includes("DOMICILIO")) d.addressPart = valor;
            if (clave.includes("POBLACION")) d.cityPart = valor;
            if (clave.includes("ACTUALMENTE EN")) d.status_homeserve = valor;
            if (clave.includes("COMPAÑIA")) d.company = valor;
            if (clave.includes("FECHA ASIGNACION")) d.dateString = valor;
            if (clave.includes("COMENTARIOS")) d.description = valor;
          }
        });
        return d;
      });

      // --- PREPARACIÓN DE DATOS ---
      const fullAddress = `${detalles.addressPart || ""} ${detalles.cityPart || ""}`.trim();

      let rawCompany = detalles.company || "";
      if (!rawCompany.toUpperCase().includes("HOMESERVE")) {
        rawCompany = `HOMESERVE - ${rawCompany}`;
      }

      const servicioFinal = {
        serviceNumber: ref,
        clientName: detalles.clientName || "Desconocido",
        address: fullAddress,
        phone: detalles.phone || "Sin teléfono",
        description: detalles.description || "",
        homeserveStatus: detalles.status_homeserve || "",
        company: rawCompany,
        dateString: detalles.dateString || "",
        status: "pendiente_validacion",
        updatedAt: nowIso(),
      };

      if (!datosAntiguos) servicioFinal.createdAt = nowIso();

      // --- GUARDADO INTELIGENTE ---
      if (!datosAntiguos) {
        await docRef.set(servicioFinal);
        console.log(`➕ NUEVO: ${ref} (Tlf: ${servicioFinal.phone})`);
        nuevos++;
      } else {
        const cambioEstado = (datosAntiguos.homeserveStatus || "") !== (servicioFinal.homeserveStatus || "");
        const cambioTelefono = (datosAntiguos.phone || "") !== (servicioFinal.phone || "");

        if (cambioEstado || cambioTelefono) {
          console.log(`♻️ ACTUALIZADO: ${ref}`);
          await docRef.set(servicioFinal, { merge: true });
          actualizados++;
        }
      }
    }

    console.log(`🏁 FIN V6.3: ${nuevos} nuevos, ${actualizados} actualizados.`);

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

runRobot();
