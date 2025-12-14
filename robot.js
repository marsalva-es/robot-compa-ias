const { chromium } = require('playwright');
const admin = require('firebase-admin');

// --- 1. CONFIGURACIÓN FIREBASE ---
if (process.env.FIREBASE_PRIVATE_KEY) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      })
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
const COLLECTION_NAME = "appointments";

// --- FUNCIÓN PRINCIPAL ---
async function runRobot() {
  // FÍJATE AQUÍ: He cambiado el nombre a V3.1 para que lo reconozcas en el Log
  console.log('🤖 [V3.1] Arrancando robot HomeServe (Versión CODIGO)...');
  
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

    // --- CORRECCIÓN DE TU FOTO ---
    // En tu foto se ve claro: name="CODIGO"
    const selectorUsuario = 'input[name="CODIGO"]';
    const selectorPass = 'input[type="password"]';

    if (await page.isVisible(selectorUsuario)) {
        console.log("📝 He visto la casilla 'CODIGO'. Rellenando...");
        await page.fill(selectorUsuario, process.env.HOMESERVE_USER || ''); 
        await page.fill(selectorPass, process.env.HOMESERVE_PASS || '');
        
        console.log('👆 Pulsando botón Aceptar...');
        await Promise.all([
          page.waitForNavigation({ timeout: 30000 }), 
          page.click('input[type="submit"], input[value="Aceptar"]')
        ]);
    } else {
        console.log("⚠️ Sigo sin ver la casilla 'CODIGO'. Imprimiendo HTML para investigar:");
        // Si falla, imprimimos el HTML para ver qué está pasando
        console.log((await page.content()).substring(0, 1000));
    }

    // --- PASO 2: COMPROBAR LOGIN ---
    if (page.url().includes('PROF_PASS')) {
        console.error("⛔ EL LOGIN HA FALLADO. El robot sigue en la página de inicio.");
        throw new Error("Login fallido");
    }

    // --- PASO 3: IR A LA LISTA ---
    console.log('📂 Login OK. Yendo a servicios...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
    
    // --- PASO 4: LEER DATOS ---
    const servicios = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('table tr'));
      const datos = [];
      filas.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length > 5) {
            let ref = tds[0]?.innerText?.trim();
            if (ref && !isNaN(ref) && ref.length > 3) { 
                datos.push({
                    serviceNumber: ref,
                    clientName: tds[2]?.innerText?.trim(),
                    address: tds[3]?.innerText?.trim(),
                    phone: tds[4]?.innerText?.trim(),
                    status: "pendingStart",
                    createdAt: new Date().toISOString()
                });
            }
        }
      });
      return datos;
    });

    console.log(`📦 ¡BINGO! Encontrados: ${servicios.length} servicios.`);

    // --- PASO 5: GUARDAR ---
    for (const s of servicios) {
      const docRef = db.collection(COLLECTION_NAME).doc(s.serviceNumber);
      const doc = await docRef.get();
      if (!doc.exists) {
        await docRef.set(s);
        console.log(`➕ Guardado: ${s.serviceNumber}`);
      }
    }

  } catch (error) {
    console.error('❌ ERROR:', error.message);
  } finally {
    await browser.close();
    console.log('🏁 Fin V3.1');
    process.exit(0);
  }
}

runRobot();
