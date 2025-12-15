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

// ✅ Colecciones donde comprobamos existencia. Si existe en CUALQUIERA → no guardamos.
const EXISTENCE_CHECKS = [
  { col: "appointments", field: "serviceNumber" }, // calendario
  { col: "services", field: "serviceNumber" },     // alta cliente
  { col: "homeserve_pendientes", field: "serviceNumber" }, // por si ya está en pendientes
  // { col: "onlineAppointmentRequests", field: "serviceNumber" }, // opcional: si lo usas
];

async function getProviderCredentials(providerDocId) {
  const snap = await db.collection("providerCredentials").doc(providerDocId).get();
  if (!snap.exists) throw new Error(`No existe providerCredentials/${providerDocId} en Firestore`);

  const data = snap.data() || {};
  const user = String(data.user || "").trim();
  const pass = String(data.pass || "").trim();

  if (!user || !pass) throw new Error(`providerCredentials/${providerDocId} no tiene user/pass completos`);
  return { user, pass };
}

function normalizeServiceNumber(raw) {
  const digits = String(raw || "").trim().replace(/\D/g, "");
  // mínimo 4 dígitos para evitar basura tipo "SERVICIO"
  if (!/^\d{4,}$/.test(digits)) return null;
  return digits;
}

function hasMinimumData(detalles) {
  const client = String(detalles.clientName || "").trim();
  const addressPart = String(detalles.addressPart || "").trim();
  const cityPart = String(detalles.cityPart || "").trim();
  const phone = String(detalles.phone || "").trim();

  const address = `${addressPart} ${cityPart}`.trim();

  // ✅ Mínimos: (cliente + dirección) o teléfono válido.
  // Ajusta si quieres ser más estricto.
  const phoneOk = /^[6789]\d{8}$/.test(phone);
  const hasClientAndAddress = client.length >= 3 && address.length >= 8;

  return phoneOk || hasClientAndAddress;
}

// -------------------------
// ✅ Helpers existencia PRO
// -------------------------
function chunk(arr, size = 10) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function preloadExistingServiceNumbers(serviceNumbers) {
  const found = new Set();
  const unique = Array.from(new Set(serviceNumbers)).filter(Boolean);
  const parts = chunk(unique, 10);

  for (const check of EXISTENCE_CHECKS) {
    for (const p of parts) {
      // Firestore "in" permite hasta 10 valores
      const snap = await db.collection(check.col)
        .where(check.field, "in", p)
        .get();

      snap.forEach(doc => {
        const v = doc.get(check.field);
        const normalized = normalizeServiceNumber(v);
        if (normalized) found.add(normalized);
      });
    }
  }
  return found;
}

async function runRobot() {
  console.log('🤖 [V7.3] Arrancando robot (NO guarda bloqueados / sin datos / ni si ya existe en cualquier lado)...');

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

      await page.type(selectorUsuario, creds.user, { delay: 80 });
      await page.type(selectorPass, creds.pass, { delay: 80 });

      console.log('👆 Pulsando ENTER...');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
    } else {
      console.log("⚠️ No veo el formulario de login (puede que ya esté logueado).");
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
          const digits = raw.replace(/\D/g, "");
          if (/^\d{4,}$/.test(digits)) refs.push(digits);
        }
      });

      return Array.from(new Set(refs));
    });

    console.log(`🔎 Encontrados ${referenciasEnWeb.length} servicios válidos.`);

    // ✅ Normalizamos lista y precargamos existencia EN TODO EL SISTEMA
    const referenciasNormalizadas = referenciasEnWeb
      .map(normalizeServiceNumber)
      .filter(Boolean);

    console.log("🧠 Precargando existencia en Firestore (appointments/services/homeserve_pendientes)...");
    const existentes = await preloadExistingServiceNumbers(referenciasNormalizadas);
    console.log(`🧾 Ya existen en el sistema: ${existentes.size} (se saltarán)`);

    // --- PASO 3: PROCESAR UNO A UNO ---
    let actualizados = 0;
    let nuevos = 0;
    let saltadosBloqueo = 0;
    let saltadosExistencia = 0;

    for (const ref of referenciasEnWeb) {
      const normalized = normalizeServiceNumber(ref);
      if (!normalized) continue;

      // ✅ REGLA NUEVA: si ya existe en cualquier lado → NO GUARDAR NADA
      if (existentes.has(normalized)) {
        saltadosExistencia++;
        console.log(`⏭️ SALTADO (ya existe en el sistema): ${normalized}`);
        continue;
      }

      // Navegar a la lista y hacer click
      await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');

      try {
        // Si está bloqueado, aquí suele fallar el click o no navega/abre.
        await page.click(`text="${normalized}"`, { timeout: 5000 });
        await page.waitForTimeout(1500);
      } catch (e) {
        // ✅ REGLA: si está bloqueado/no accesible → NO GUARDAR NADA
        saltadosBloqueo++;
        console.warn(`⛔ SALTADO (bloqueado o no accesible): ${normalized}`);
        continue;
      }

      // Scraping
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
              d.phone = match ? match[0] : "";
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

      // ✅ REGLA: si entra pero no hay datos mínimos → NO GUARDAR
      if (!hasMinimumData(detalles)) {
        saltadosBloqueo++;
        console.warn(`⛔ SALTADO (sin datos mínimos): ${normalized}`);
        continue;
      }

      const fullAddress = `${detalles.addressPart || ""} ${detalles.cityPart || ""}`.trim();

      let rawCompany = detalles.company || "";
      if (rawCompany && !rawCompany.toUpperCase().includes("HOMESERVE")) {
        rawCompany = `HOMESERVE - ${rawCompany}`;
      }

      const docRef = db.collection(COLLECTION_NAME).doc(normalized);
      const docSnapshot = await docRef.get();
      const datosAntiguos = docSnapshot.exists ? docSnapshot.data() : null;

      const servicioFinal = {
        serviceNumber: normalized,
        clientName: detalles.clientName || "Desconocido",
        address: fullAddress,
        phone: detalles.phone || "Sin teléfono",
        description: detalles.description || "",
        homeserveStatus: detalles.status_homeserve || "",
        company: rawCompany || "",
        dateString: detalles.dateString || "",
        status: "pendiente_validacion",
        updatedAt: new Date().toISOString(),
      };

      if (!datosAntiguos) servicioFinal.createdAt = new Date().toISOString();

      if (!datosAntiguos) {
        await docRef.set(servicioFinal);
        console.log(`➕ NUEVO: ${normalized} (Tlf: ${servicioFinal.phone})`);
        nuevos++;
      } else {
        const cambioEstado = (datosAntiguos.homeserveStatus || "") !== (servicioFinal.homeserveStatus || "");
        const cambioTelefono = (datosAntiguos.phone || "") !== (servicioFinal.phone || "");
        const cambioAddress = (datosAntiguos.address || "") !== (servicioFinal.address || "");
        const cambioCliente = (datosAntiguos.clientName || "") !== (servicioFinal.clientName || "");

        if (cambioEstado || cambioTelefono || cambioAddress || cambioCliente) {
          console.log(`♻️ ACTUALIZADO: ${normalized}`);
          await docRef.set(servicioFinal, { merge: true });
          actualizados++;
        }
      }
    }

    console.log(
      `🏁 FIN V7.3: ${nuevos} nuevos, ${actualizados} actualizados, ` +
      `${saltadosBloqueo} saltados (bloqueados/sin datos), ` +
      `${saltadosExistencia} saltados (ya existen en el sistema).`
    );

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

runRobot();
