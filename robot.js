const { chromium } = require('playwright');
const admin = require('firebase-admin');

// --- CONFIGURACIÓN FIREBASE (desde ENV de Render) ---
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

const COLLECTION_NAME = "homeserve_pendientes";
const PROVIDER_DOC = "homeserve"; // providerCredentials/homeserve

async function getProviderCredentials(providerDocId) {
  const snap = await db.collection("providerCredentials").doc(providerDocId).get();
  if (!snap.exists) throw new Error(`No existe providerCredentials/${providerDocId} en Firestore`);

  const data = snap.data() || {};
  const user = String(data.user || "").trim();
  const pass = String(data.pass || "").trim();
  if (!user || !pass) throw new Error(`providerCredentials/${providerDocId} no tiene user/pass completos`);

  return { user, pass };
}

async function runRobot() {
  console.log('🤖 [V7.1] Arrancando robot (credenciales desde Firestore + filtro SERVICIO)...');

  // 0) Leer credenciales desde Firebase
  let creds;
  try {
    creds = await getProviderCredentials(PROVIDER_DOC);
    console.log(`🔐 Credenciales cargadas OK: provider=${PROVIDER_DOC} user=${creds.user}`);
  } catch (e) {
    console.error("❌ No se pudieron cargar credenciales del proveedor:", e.message);
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
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
      await page.fill(selectorUsuario, "");
      await page.fill(selectorPass, "");
      await page.type(selectorUsuario, creds.user, { delay: 100 });
      await page.type(selectorPass, creds.pass, { delay: 100 });

      console.log('👆 Pulsando ENTER...');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
    } else {
      console.log("⚠️ No veo el formulario de login (puede que ya esté logueado o cambió la web).");
    }

    // --- PASO 2: OBTENER LISTA ---
    console.log('📂 Leyendo lista de servicios...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');

    const referenciasEnWeb = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('table tr'));
      const refs = [];

      filas.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length > 0) {
          const raw = (tds[0]?.innerText || "").trim();
          // ✅ sacamos solo dígitos (si no hay dígitos, fuera → "SERVICIO" muere aquí)
          const digits = raw.replace(/\D/g, "");
          if (/^\d{4,}$/.test(digits)) refs.push(digits);
        }
      });

      // quitar duplicados por si acaso
      return Array.from(new Set(refs));
    });

    console.log(`🔎 Encontrados ${referenciasEnWeb.length} servicios válidos.`);

    // --- PASO 3: PROCESAR UNO A UNO ---
    let actualizados = 0;
    let nuevos = 0;

    for (const ref of referenciasEnWeb) {
      const docRef = db.collection(COLLECTION_NAME).doc(ref);
      const docSnapshot = await docRef.get();
      const datosAntiguos = docSnapshot.exists ? docSnapshot.data() : null;

      // Navegar a la lista y hacer click
      await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
      try {
        await page.click(`text="${ref}"`);
        await page.waitForTimeout(1500);
      } catch (e) {
        // ✅ si está bloqueado y no se puede entrar, lo marcamos bloqueado (para que NO se pueda dar de alta)
        const blockedDoc = {
          serviceNumber: ref,
          blocked: true,
          blockedReason: "No se pudo entrar en ficha (posible bloqueo de compañía)",
          status: "blocked",
          updatedAt: new Date().toISOString(),
        };
        if (!datosAntiguos) blockedDoc.createdAt = new Date().toISOString();

        await docRef.set(blockedDoc, { merge: true });
        console.warn(`⛔ BLOQUEADO: ${ref} (guardado como blocked=true)`);
        continue;
      }

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

      const fullAddress = `${detalles.addressPart || ""} ${detalles.cityPart || ""}`.trim();
      let rawCompany = detalles.company || "";
      if (!rawCompany.toUpperCase().includes("HOMESERVE")) rawCompany = `HOMESERVE - ${rawCompany}`;

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
        blocked: false,
        updatedAt: new Date().toISOString(),
      };
      if (!datosAntiguos) servicioFinal.createdAt = new Date().toISOString();

      if (!datosAntiguos) {
        await docRef.set(servicioFinal);
        console.log(`➕ NUEVO: ${ref} (Tlf: ${servicioFinal.phone})`);
        nuevos++;
      } else {
        const cambioEstado = datosAntiguos.homeserveStatus !== servicioFinal.homeserveStatus;
        const cambioTelefono = datosAntiguos.phone !== servicioFinal.phone;
        const cambioBloqueo = !!datosAntiguos.blocked !== !!servicioFinal.blocked;

        if (cambioEstado || cambioTelefono || cambioBloqueo) {
          console.log(`♻️ ACTUALIZADO: ${ref}`);
          await docRef.set(servicioFinal, { merge: true });
          actualizados++;
        }
      }
    }

    console.log(`🏁 FIN V7.1: ${nuevos} nuevos, ${actualizados} actualizados.`);
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

runRobot();
