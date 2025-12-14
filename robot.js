// Forzando actualizacion del robot
const { chromium } = require('playwright');
const admin = require('firebase-admin');

// --- 1. CONFIGURACIÓN FIREBASE ---
if (process.env.FIREBASE_PRIVATE_KEY) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Reemplaza saltos de línea escapados si es necesario
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      })
    });
  } catch (err) {
    console.error("❌ Error inicializando Firebase:", err.message);
    process.exit(1);
  }
} else {
  console.error("⚠️ FALTAN LAS CLAVES DE FIREBASE (Variables de Entorno)");
  process.exit(1);
}

const db = admin.firestore();
const COLLECTION_NAME = "appointments";

// Fíjate aquí: La función se llama runRobot
async function runRobot() {
  console.log('🤖 [INICIO] Arrancando robot HomeServe (Modo Seguro)...');
  
  // Lanzamos navegador
  const browser = await chromium.launch({ headless: true }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // --- PASO 1: VISITAR LOGIN ---
    console.log('🔐 Accediendo a la página de login...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=PROF_PASS', { timeout: 30000 });

    // --- PASO 2: INTRODUCIR CREDENCIALES ---
    const userSelector = 'input[name="Usuario"]';
    const passSelector = 'input[name="Password"]';
    const btnSelector = 'input[type="submit"], button[type="submit"]';

    if (await page.isVisible(userSelector) && await page.isVisible(passSelector)) {
        await page.fill(userSelector, process.env.HOMESERVE_USER || ''); 
        await page.fill(passSelector, process.env.HOMESERVE_PASS || '');
    } else {
        throw new Error("No se encuentran los campos de usuario/contraseña. La web puede haber cambiado.");
    }
    
    console.log('👆 Pulsando botón de entrar (Un solo intento)...');
    
    // --- PASO 3: INTENTO DE LOGIN ÚNICO ---
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }), 
      page.click(btnSelector)
    ]);

    // CHEQUEO DE SEGURIDAD
    const currentURL = page.url();
    if (currentURL.includes('w3exec=PROF_PASS') || currentURL.includes('error')) {
        console.error('⛔ LOGIN FALLIDO: La URL no ha cambiado tras el login.');
        await browser.close();
        process.exit(1); 
        return;
    }

    console.log('✅ Login aparentemente correcto. URL:', currentURL);

    // --- PASO 4: IR A LA LISTA TOTAL ---
    console.log('📂 Navegando a la lista de servicios...');
    const response = await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total', { waitUntil: 'domcontentloaded' });

    if (!response.ok()) {
        throw new Error(`Error al cargar la lista: ${response.status()}`);
    }

    // --- PASO 5: EXTRAER DATOS ---
    const nuevosServicios = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('table tr'));
      const datos = [];

      filas.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length > 5) {
            // AJUSTA ESTOS ÍNDICES SI ES NECESARIO
            let ref = tds[0]?.innerText?.trim();
            let cliente = tds[2]?.innerText?.trim();
            let direccion = tds[3]?.innerText?.trim();
            let telefono = tds[4]?.innerText?.trim();

            if (ref && !isNaN(ref) && ref.length > 3) { 
                datos.push({
                    serviceNumber: ref,
                    clientName: cliente,
                    address: direccion,
                    phone: telefono,
                    insuranceCompany: "HOMESERVE",
                    title: "Siniestro HomeServe " + ref,
                    status: "pendingStart",
                    isUrgent: false,
                    createdAt: new Date().toISOString()
                });
            }
        }
      });
      return datos;
    });

    console.log(`📦 Se han detectado ${nuevosServicios.length} servicios.`);

    // --- PASO 6: GUARDAR EN FIREBASE ---
    let guardados = 0;
    for (const servicio of nuevosServicios) {
      const docRef = db.collection(COLLECTION_NAME).doc(servicio.serviceNumber);
      const doc = await docRef.get();

      if (!doc.exists) {
        await docRef.set({
            ...servicio,
            date: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`➕ Guardado nuevo servicio: ${servicio.serviceNumber}`);
        guardados++;
      }
    }

    if (guardados === 0) console.log("💤 No hay servicios nuevos que guardar.");

  } catch (error) {
    console.error('❌ ERROR CRÍTICO EN EL ROBOT:', error.message);
  } finally {
    if (browser) {
        console.log('🔒 Cerrando navegador...');
        await browser.close();
    }
    console.log('🏁 Proceso finalizado.');
    process.exit(0);
  }
}

// ⚠️ AQUÍ ESTABA EL ERROR: AHORA LLAMAMOS A LA FUNCIÓN CORRECTA
runRobot();
