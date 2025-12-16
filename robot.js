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

// ✅ Si existe en cualquiera de estas colecciones, no se guarda como pendiente
const EXISTENCE_CHECKS = [
  { col: "appointments", field: "serviceNumber" },
  { col: "services", field: "serviceNumber" },
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

async function preloadExistingServiceNumbers(serviceNumbers) {
  const found = new Set();
  const unique = Array.from(new Set(serviceNumbers)).filter(Boolean);
  const parts = chunk(unique, 10);

  for (const check of EXISTENCE_CHECKS) {
    for (const p of parts) {
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

async function getAllPendingDocIds() {
  const snap = await db.collection(COLLECTION_NAME).get();
  return snap.docs.map(d => d.id);
}

async function runRobot() {
  console.log('🤖 [V7.4] Robot HomeServe (no dupes + archivado si desaparece)...');

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

    // ✅ precargar lo que ya existe en tu sistema (appointments/services)
    console.log("🧠 Precargando existencia en Firestore (appointments/services)...");
    const existentesSistema = await preloadExistingServiceNumbers(referenciasNormalizadas);
    console.log(`🧾 Ya existen en el sistema: ${existentesSistema.size} (se saltarán como pendientes)`);

    // ✅ archivo: ids que ya estaban en homeserve_pendientes
    console.log("📦 Cargando documentos actuales de homeserve_pendientes para archivar lo que desaparezca...");
    const pendingDocIds = await getAllPendingDocIds();
    const pendingSet = new Set(pendingDocIds);

    // --- PROCESAR ---
    let actualizados = 0;
    let nuevos = 0;
    let saltadosBloqueo = 0;
    let saltadosExistencia = 0;
    let archivados = 0;
    let archivadosPorIntegrado = 0;

    for (const ref of referenciasEnWeb) {
      const normalized = normalizeServiceNumber(ref);
      if (!normalized) continue;

      // ✅ si ya existe en tu sistema, no lo guardes como pendiente.
      // Si estaba en pendientes, lo archivamos como "already_in_system"
      if (existentesSistema.has(normalized)) {
        saltadosExistencia++;

        if (pendingSet.has(normalized)) {
          await db.collection(COLLECTION_NAME).doc(normalized).set({
            status: "archived",
            archivedReason: "already_in_system",
            archivedAt: nowISO,
            updatedAt: nowISO
          }, { merge: true });
          archivadosPorIntegrado++;
        }

        console.log(`⏭️ SALTADO (ya existe en el sistema): ${normalized}`);
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
        lastSeenAt: nowISO,
        updatedAt: nowISO,
      };

      if (!datosAntiguos) servicioFinal.createdAt = nowISO;

      if (!datosAntiguos) {
        await docRef.set(servicioFinal);
        console.log(`➕ NUEVO: ${normalized} (Tlf: ${servicioFinal.phone})`);
        nuevos++;
      } else {
        const cambioEstado = (datosAntiguos.homeserveStatus || "") !== (servicioFinal.homeserveStatus || "");
        const cambioTelefono = (datosAntiguos.phone || "") !== (servicioFinal.phone || "");
        const cambioAddress = (datosAntiguos.address || "") !== (servicioFinal.address || "");
        const cambioCliente = (datosAntiguos.clientName || "") !== (servicioFinal.clientName || "");
        const cambioCompany = (datosAntiguos.company || "") !== (servicioFinal.company || "");

        if (cambioEstado || cambioTelefono || cambioAddress || cambioCliente || cambioCompany) {
          console.log(`♻️ ACTUALIZADO: ${normalized}`);
          await docRef.set(servicioFinal, { merge: true });
          actualizados++;
        } else {
          // aunque no cambie nada, actualizamos lastSeenAt/updatedAt
          await docRef.set({ lastSeenAt: nowISO, updatedAt: nowISO }, { merge: true });
        }

        // Si estaba archivado por algo y reaparece, lo “desarchivamos”
        if ((datosAntiguos.status || "") === "archived") {
          await docRef.set({
            status: "pendiente_validacion",
            archivedAt: admin.firestore.FieldValue.delete(),
            archivedReason: admin.firestore.FieldValue.delete(),
            updatedAt: nowISO
          }, { merge: true });
        }
      }
    }

    // ✅ Archivar lo que antes existía en Firestore pero ya no aparece en HomeServe
    console.log("🗄️ Archivando los que han desaparecido de HomeServe...");
    for (const docId of pendingDocIds) {
      const sn = normalizeServiceNumber(docId);
      if (!sn) continue;

      // Si ya no aparece en la web, lo archivamos
      if (!webSet.has(sn)) {
        const ref = db.collection(COLLECTION_NAME).doc(sn);
        const snap = await ref.get();
        const data = snap.exists ? (snap.data() || {}) : {};

        if ((data.status || "") !== "archived") {
          await ref.set({
            status: "archived",
            archivedReason: "missing_from_homeserve",
            archivedAt: nowISO,
            updatedAt: nowISO
          }, { merge: true });
          archivados++;
        }
      }
    }

    console.log(
      `🏁 FIN V7.4: ${nuevos} nuevos, ${actualizados} actualizados, ` +
      `${saltadosBloqueo} saltados (bloqueados/sin datos), ` +
      `${saltadosExistencia} saltados (ya en sistema), ` +
      `${archivados} archivados (desaparecidos), ` +
      `${archivadosPorIntegrado} archivados (integrados).`
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
