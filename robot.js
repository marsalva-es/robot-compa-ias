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

// Colecciones “sistema”
const APPOINTMENTS_COL = "appointments";
const SERVICES_COL = "services";
const SERVICE_NUMBER_FIELD = "serviceNumber";

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
  if (!/^\d{4,}$/.test(digits)) return null;
  return digits;
}

function hasMinimumData(detalles) {
  const client = String(detalles.clientName || "").trim();
  const addressPart = String(detalles.addressPart || "").trim();
  const cityPart = String(detalles.cityPart || "").trim();
  const phone = String(detalles.phone || "").trim();

  const address = `${addressPart} ${cityPart}`.trim();

  const phoneOk = /^[6789]\d{8}$/.test(phone);
  const hasClientAndAddress = client.length >= 3 && address.length >= 8;

  return phoneOk || hasClientAndAddress;
}

function chunk(arr, size = 10) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isCompletedStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return s === "completed" || s === "finalizado" || s === "finished" || s === "done";
}

async function preloadAppointmentsInfo(serviceNumbers) {
  // Map(sn -> { status, isInboxPending })
  const map = new Map();
  const unique = Array.from(new Set(serviceNumbers)).filter(Boolean);
  const parts = chunk(unique, 10);

  for (const p of parts) {
    const snap = await db.collection(APPOINTMENTS_COL)
      .where(SERVICE_NUMBER_FIELD, "in", p)
      .get();

    snap.forEach(doc => {
      const data = doc.data() || {};
      const sn = normalizeServiceNumber(data[SERVICE_NUMBER_FIELD]);
      if (!sn) return;
      map.set(sn, {
        status: String(data.status || "").trim(),
        isInboxPending: !!data.isInboxPending,
        docId: doc.id,
      });
    });
  }

  return map;
}

async function preloadServicesExistence(serviceNumbers) {
  const set = new Set();
  const unique = Array.from(new Set(serviceNumbers)).filter(Boolean);
  const parts = chunk(unique, 10);

  for (const p of parts) {
    const snap = await db.collection(SERVICES_COL)
      .where(SERVICE_NUMBER_FIELD, "in", p)
      .get();

    snap.forEach(doc => {
      const data = doc.data() || {};
      const sn = normalizeServiceNumber(data[SERVICE_NUMBER_FIELD]);
      if (sn) set.add(sn);
    });
  }

  return set;
}

async function getAllPendingDocIds() {
  const snap = await db.collection(COLLECTION_NAME).get();
  return snap.docs.map(d => d.id);
}

async function runRobot() {
  console.log('🤖 [V7.5] Robot HomeServe (no dupes + in_system + archiva solo completed)...');

  // 0) Credenciales
  let creds;
  try {
    creds = await getProviderCredentials(PROVIDER_DOC);
    console.log(`🔐 Credenciales OK: provider=${PROVIDER_DOC} user=${creds.user}`);
  } catch (e) {
    console.error("❌ No se pudieron cargar credenciales:", e.message);
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const nowISO = new Date().toISOString();

  try {
    // LOGIN
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
      console.log("⚠️ No veo login (quizá ya logueado).");
    }

    // LISTA
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

    const referenciasNormalizadas = referenciasEnWeb
      .map(normalizeServiceNumber)
      .filter(Boolean);

    const webSet = new Set(referenciasNormalizadas);

    // ✅ precargar info del sistema
    console.log("🧠 Precargando datos del sistema (appointments/services)...");
    const apptInfoMap = await preloadAppointmentsInfo(referenciasNormalizadas);
    const servicesSet = await preloadServicesExistence(referenciasNormalizadas);

    console.log(`🧾 En appointments: ${apptInfoMap.size} | En services: ${servicesSet.size}`);

    // ✅ ids que ya estaban en homeserve_pendientes
    console.log("📦 Cargando documentos actuales de homeserve_pendientes...");
    const pendingDocIds = await getAllPendingDocIds();
    const pendingSet = new Set(pendingDocIds);

    // --- CONTADORES ---
    let actualizados = 0;
    let nuevos = 0;
    let saltadosBloqueo = 0;
    let saltadosSinDatos = 0;

    let marcadosInSystem = 0;
    let archivadosCompleted = 0;
    let marcadosMissingNoArchive = 0;

    for (const ref of referenciasEnWeb) {
      const normalized = normalizeServiceNumber(ref);
      if (!normalized) continue;

      const appt = apptInfoMap.get(normalized);
      const existsInAppointments = !!appt;
      const existsInServices = servicesSet.has(normalized);

      const existsInSystem = existsInAppointments || existsInServices;

      // ✅ Si ya existe en sistema:
      // - SI completed => archived
      // - SI NO completed => in_system
      // Y NO se archiva por “existir”, solo por completed.
      if (existsInSystem && pendingSet.has(normalized)) {
        const docRef = db.collection(COLLECTION_NAME).doc(normalized);

        if (existsInAppointments && isCompletedStatus(appt.status)) {
          await docRef.set({
            status: "archived",
            archivedReason: "completed_in_system",
            archivedAt: nowISO,
            integratedIn: appt.isInboxPending ? "alta" : "calendar",
            systemStatus: appt.status,
            updatedAt: nowISO,
            lastSeenAt: nowISO,
            missingFromHomeServe: false
          }, { merge: true });

          archivadosCompleted++;
          console.log(`✅ ARCHIVED (completed): ${normalized}`);
        } else {
          await docRef.set({
            status: "in_system",
            integratedIn: existsInAppointments ? (appt.isInboxPending ? "alta" : "calendar") : "services",
            systemStatus: existsInAppointments ? (appt.status || "") : "",
            updatedAt: nowISO,
            lastSeenAt: nowISO,
            missingFromHomeServe: false
          }, { merge: true });

          marcadosInSystem++;
          console.log(`🟧 IN_SYSTEM: ${normalized}`);
        }

        // No hace falta scrapear si ya existe el doc y ya está integrado
        continue;
      }

      // Si existe en sistema pero NO existe en homeserve_pendientes (no lo tenías):
      // lo tratamos como antes (scrape) y lo guardamos con status in_system (no archived).
      // Si está completed, no creamos doc nuevo (no aporta mucho).
      if (existsInSystem && !pendingSet.has(normalized) && existsInAppointments && isCompletedStatus(appt.status)) {
        archivadosCompleted++;
        console.log(`⏭️ SALTADO (completed y sin doc pendiente): ${normalized}`);
        continue;
      }

      // Navegar a la lista y click
      await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');

      try {
        await page.click(`text="${normalized}"`, { timeout: 5000 });
        await page.waitForTimeout(1500);
      } catch (e) {
        saltadosBloqueo++;
        console.warn(`⛔ SALTADO (bloqueado/no accesible): ${normalized}`);
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

      if (!hasMinimumData(detalles)) {
        saltadosSinDatos++;
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

      // Estado según sistema (si existe, es in_system; si no, pendiente_validacion)
      let status = "pendiente_validacion";
      let integratedIn = "";
      let systemStatus = "";

      if (existsInSystem) {
        status = "in_system";
        if (existsInAppointments) {
          integratedIn = appt.isInboxPending ? "alta" : "calendar";
          systemStatus = appt.status || "";
        } else {
          integratedIn = "services";
        }
      }

      const servicioFinal = {
        serviceNumber: normalized,
        clientName: detalles.clientName || "Desconocido",
        address: fullAddress,
        phone: detalles.phone || "Sin teléfono",
        description: detalles.description || "",
        homeserveStatus: detalles.status_homeserve || "",
        company: rawCompany || "",
        dateString: detalles.dateString || "",

        status,
        integratedIn,
        systemStatus,

        lastSeenAt: nowISO,
        updatedAt: nowISO,
        missingFromHomeServe: false,
      };

      if (!datosAntiguos) servicioFinal.createdAt = nowISO;

      if (!datosAntiguos) {
        await docRef.set(servicioFinal);
        console.log(`➕ NUEVO: ${normalized} (status=${status})`);
        nuevos++;
      } else {
        const cambioEstado = (datosAntiguos.homeserveStatus || "") !== (servicioFinal.homeserveStatus || "");
        const cambioTelefono = (datosAntiguos.phone || "") !== (servicioFinal.phone || "");
        const cambioAddress = (datosAntiguos.address || "") !== (servicioFinal.address || "");
        const cambioCliente = (datosAntiguos.clientName || "") !== (servicioFinal.clientName || "");
        const cambioCompany = (datosAntiguos.company || "") !== (servicioFinal.company || "");
        const cambioStatus = (datosAntiguos.status || "") !== (servicioFinal.status || "");

        if (cambioEstado || cambioTelefono || cambioAddress || cambioCliente || cambioCompany || cambioStatus) {
          console.log(`♻️ ACTUALIZADO: ${normalized}`);
          await docRef.set(servicioFinal, { merge: true });
          actualizados++;
        } else {
          await docRef.set({ lastSeenAt: nowISO, updatedAt: nowISO, missingFromHomeServe: false }, { merge: true });
        }

        // Si estaba archivado pero reaparece y NO está completed => lo “desarchivamos”
        if ((datosAntiguos.status || "") === "archived") {
          const shouldStayArchived = existsInAppointments && isCompletedStatus(appt?.status);
          if (!shouldStayArchived) {
            await docRef.set({
              status: status,
              archivedAt: admin.firestore.FieldValue.delete(),
              archivedReason: admin.firestore.FieldValue.delete(),
              updatedAt: nowISO
            }, { merge: true });
          }
        }
      }
    }

    // ✅ Gestionar lo que ha desaparecido de HomeServe
    // Regla NUEVA: NO archivar por desaparecer; SOLO archivar si completed.
    console.log("🗄️ Revisando los que han desaparecido de HomeServe (sin archivar salvo completed)...");
    const missingIds = pendingDocIds
      .map(normalizeServiceNumber)
      .filter(Boolean)
      .filter(sn => !webSet.has(sn));

    // precargamos su estado en sistema para decidir
    const apptMissingMap = await preloadAppointmentsInfo(missingIds);
    const servicesMissingSet = await preloadServicesExistence(missingIds);

    for (const sn of missingIds) {
      const ref = db.collection(COLLECTION_NAME).doc(sn);
      const snap = await ref.get();
      const data = snap.exists ? (snap.data() || {}) : {};

      const appt = apptMissingMap.get(sn);
      const existsInAppointments = !!appt;
      const existsInServices = servicesMissingSet.has(sn);
      const existsInSystem = existsInAppointments || existsInServices;

      if (existsInAppointments && isCompletedStatus(appt.status)) {
        // ✅ SOLO AQUÍ archivamos
        if ((data.status || "") !== "archived") {
          await ref.set({
            status: "archived",
            archivedReason: "completed_in_system",
            archivedAt: nowISO,
            integratedIn: appt.isInboxPending ? "alta" : "calendar",
            systemStatus: appt.status,
            updatedAt: nowISO,
            missingFromHomeServe: true,
            missingAt: nowISO
          }, { merge: true });
          archivadosCompleted++;
        }
        continue;
      }

      if (existsInSystem) {
        // Está en tu sistema pero no está completed => en sistema, NO archived
        await ref.set({
          status: "in_system",
          integratedIn: existsInAppointments ? (appt.isInboxPending ? "alta" : "calendar") : "services",
          systemStatus: existsInAppointments ? (appt.status || "") : "",
          updatedAt: nowISO,
          missingFromHomeServe: true,
          missingAt: nowISO
        }, { merge: true });
        marcadosInSystem++;
        continue;
      }

      // No está en sistema y ha desaparecido de HomeServe -> NO archivar, solo marcar missing
      await ref.set({
        missingFromHomeServe: true,
        missingAt: nowISO,
        updatedAt: nowISO
      }, { merge: true });
      marcadosMissingNoArchive++;
    }

    console.log(
      `🏁 FIN V7.5: ${nuevos} nuevos, ${actualizados} actualizados, ` +
      `${saltadosBloqueo} saltados (bloqueados), ${saltadosSinDatos} saltados (sin datos), ` +
      `${marcadosInSystem} marcados in_system, ${archivadosCompleted} archivados (completed), ` +
      `${marcadosMissingNoArchive} marcados missing (NO archived).`
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
